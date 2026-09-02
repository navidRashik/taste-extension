// gitcommit.ts — the project-scope auto-commit writer.
//
// A learned team convention only pays off if it reaches the team, so a
// project-scope artefact is committed to the repo it was written into. The
// git write is deliberately the narrowest one that can publish a file:
//
//   git add -- <artefact-path>
//   git commit --only -m <message> -- <artefact-path>
//
// A freshly promoted artefact is a brand-new untracked file, and git refuses
// to commit a path it has never heard of, so the path is staged first. The
// staging names exactly the one artefact path that has already been
// validated as inside the taste-owned subtree, and that path is proved to
// be a single file before it is handed over: `git add` given a directory
// stages everything beneath it, so "exactly one file" is checked rather
// than trusted. No glob is ever passed, and none of the bulk-stage
// arguments the argv guard below refuses can reach git either — so staging
// cannot pick up a file Taste did not write. `--only` then commits that
// one pathspec's content and IGNORES THE
// REST OF THE INDEX, so whatever the human had already staged is never swept
// into Taste's commit. The `--` separator ends the option list, so an
// artefact path that begins with a dash is read as a path and never as a
// flag.
//
// There is no `-f`, no `--amend`, and no push: publishing a commit to a
// remote stays a human/CI concern. Taste also never disables a repository's
// own hooks or signing, so every commit it makes is subject to exactly the
// checks a human commit is. The argument guard below is enforced on every
// argv this module builds, probes and staging included, so the narrowness is
// a property of the module rather than of one call site.
//
// Everything git touches is behind one injectable seam. The seam carries a
// process runner and a path predicate because the repository-state probes
// need both — git for refs and status, the filesystem for the in-progress
// operation markers git itself reads. Tests inject a fake that records argv
// and never spawns a process.
//
// The safety checks run BEFORE the artefact is written. A repository state
// that makes a clean single-path commit impossible refuses the promotion
// outright, so the artefact is never written and never half-published; the
// pre-write ordering is what stops `git commit --only` from sweeping a
// human's unstaged edits into Taste's commit. A directory that is not a git
// repository is not a refusal — there is no shared repo to publish into, so
// the artefact is written and nothing is committed.

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { PreferenceCandidate, PromotionTarget } from "./schema.js";

export interface GitResult {
  status: number;
  stdout: string;
}

/** What lives at a path on disk, as far as staging is concerned. */
export type PathKind = "file" | "directory" | "absent" | "other";

export interface GitRunner {
  /** Run one git invocation in `cwd`. A spawn failure reports a non-zero status. */
  run(cwd: string, args: string[]): GitResult;
  /** Probe for an in-progress-operation marker inside the git directory. */
  exists(path: string): boolean;
  /**
   * Classify what lives at `path`. Staging needs this and not a bare
   * existence answer, because `git add` reads a directory as "everything
   * underneath", so the path it is handed has to be proved a single file
   * first. A symlink is judged by what it points at, so a link into a
   * directory is refused exactly as the directory itself is.
   */
  pathKind(path: string): PathKind;
}

/**
 * Arguments that may never appear in any git invocation Taste builds. Each
 * one widens the write past the single promoted artefact or makes it
 * irreversible: the bulk-stage flags sweep unrelated content in, `--amend`
 * rewrites a commit the human may already have shared, and `push` publishes.
 * The staging subcommands are absent from this list because a publication
 * cannot happen without them, but they are only ever reached with one
 * already-validated pathspec; it is the bulk flags, not the verb, that would
 * widen the write.
 */
export const FORBIDDEN_GIT_ARGS: Readonly<Record<string, true>> = {
  push: true,
  "-A": true,
  "--all": true,
  "-a": true,
  "-f": true,
  "--force": true,
  "--amend": true,
};

/**
 * Every `--no-…` opt-out is refused as a family rather than enumerated. The
 * ones that matter here switch off a repository's own verification — hooks
 * and signature requirements — and a learned auto-commit that can skip the
 * checks a human commit must pass is not a narrow write. Refusing the whole
 * family also means a future git option cannot slip past a stale list.
 */
const OPT_OUT_ARG_RX = /^--no-/;

/**
 * Targets whose artefact is a file inside the repo's taste-owned subtree and
 * can therefore be committed. A memory promotion has no file in the repo —
 * it lands in the harness's memory runtime or the profile state root — so it
 * is published by neither this writer nor any other.
 */
export const COMMITTED_TARGETS: Readonly<Record<PromotionTarget, boolean>> = {
  skill: true,
  memory: false,
  rule: true,
  approval: true,
};

/** Markers git itself writes while an operation is mid-flight. */
const IN_PROGRESS_MARKERS: readonly string[] = [
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
];

/**
 * Tokens that would attribute the commit to an assistant rather than to
 * Taste. The boundaries are alphanumeric-only rather than `\b`, because `\b`
 * treats an underscore as a word character and would miss the token inside
 * an identifier like `pc_gpt_written`. Anything that is not a letter or a
 * digit therefore separates, which can only make the guard refuse more.
 */
const ATTRIBUTION_RX =
  /(?<![A-Za-z0-9])(?:claude|copilot|chatgpt|gpt|llm|anthropic|openai|ai[ _-]?(?:generated|assisted|authored))(?![A-Za-z0-9])/i;

/** The repository state a promotion is committed against, or refused against. */
export interface CommitPlan {
  repoRoot: string;
  /** The only subtree a Taste pathspec may name. */
  tasteRoot: string;
}

/** True when `child` is `root` itself or lies beneath it, after resolution. */
function isInside(root: string, child: string): boolean {
  const r = resolve(root);
  const c = resolve(child);
  return c === r || c.startsWith(r + sep);
}

/**
 * Refuse an argv that carries a widening, irreversible, publishing or
 * verification-skipping argument. This is the whole of the module's argv
 * safety rule, exposed so it can be exercised against every refused argument
 * directly rather than inferred from the call sites that happen to exist.
 */
export function assertNarrowArgv(args: readonly string[]): void {
  for (const arg of args) {
    if (FORBIDDEN_GIT_ARGS[arg] || OPT_OUT_ARG_RX.test(arg)) {
      throw new Error(`taste git: forbidden argument in git argv: ${arg}`);
    }
  }
}

/**
 * Run one git invocation through the seam, refusing any unsafe argv. The
 * guard sits here rather than at the commit call site so it covers the
 * probes and the staging call too: no code path in this module can reach git
 * with a bulk-stage, force, amend, push, or verification-skipping argument.
 */
function git(runner: GitRunner, cwd: string, args: string[]): GitResult {
  assertNarrowArgv(args);
  return runner.run(cwd, args);
}

/** Whether a path is entering the index as content to publish, or as a deletion to record. */
type StageMode = "publish" | "delete";

/**
 * Stage exactly one path. Git cannot commit a pathspec it has never heard
 * of, so a brand-new artefact has to enter the index before it can be
 * published. The caller has already proved `target` lies inside the
 * taste-owned subtree — but that proof says nothing about what KIND of
 * thing the path names, and a directory handed to `git add` stages every
 * file beneath it. A writer that returned a directory would therefore
 * publish the whole subtree while every existing check passed. So the kind
 * is settled here, at the single point staging happens: a directory is
 * refused outright, and a path being published must already be a regular
 * file on disk. A deletion is the asymmetric case — the caller unlinks the
 * artefact before the removal is committed, so the path being gone is the
 * expected state there rather than a fault.
 *
 * The classification goes through the same injected seam as the git calls,
 * so a test decides what the filesystem answers instead of having to build
 * the shape it wants on a real disk.
 *
 * The `--` separator ends the option list, so a path beginning with a dash
 * is read as a path rather than as a flag.
 */
function stageOne(runner: GitRunner, cwd: string, target: string, mode: StageMode): void {
  const kind = runner.pathKind(target);
  if (kind === "directory") {
    throw new Error(`taste git: pathspec is a directory, and staging one publishes everything beneath it: ${target}`);
  }
  if (mode === "publish" && kind !== "file") {
    throw new Error(`taste git: pathspec to publish is not a regular file (${kind}): ${target}`);
  }
  const res = git(runner, cwd, ["add", "--", target]);
  if (res.status !== 0) {
    throw new Error(`taste git: staging refused with status ${res.status}`);
  }
}

/** Default seam — spawns the real git binary, bounded so a hang cannot stall promotion. */
export const defaultGitRunner: GitRunner = {
  run(cwd, args) {
    try {
      const out = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 1 << 20 });
      return { status: out.status ?? 1, stdout: out.stdout ?? "" };
    } catch {
      return { status: 1, stdout: "" };
    }
  },
  exists: (path) => existsSync(path),
  pathKind(path) {
    try {
      const st = statSync(path);
      if (st.isDirectory()) return "directory";
      return st.isFile() ? "file" : "other";
    } catch {
      // Nothing is there, or nothing that can be inspected at all. Either
      // way it is not a file Taste may publish; a removal treats it as the
      // already-deleted artefact it normally is.
      return "absent";
    }
  },
};

/**
 * Walk up from `cwd` for the directory holding `.git`. Finding the root this
 * way rather than by asking git means the overwhelmingly common "not a
 * repository" answer costs no subprocess at all, and it is exact: `.git` sits
 * at the top level of a worktree whether it is a directory or a link file.
 */
function repoRootOf(cwd: string, runner: GitRunner): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (runner.exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function firstLine(res: GitResult): string {
  return res.status === 0 ? res.stdout.split("\n")[0].trim() : "";
}

/**
 * Decide, before anything is written, whether this promotion may be
 * auto-committed. Returns null when there is nothing to publish into, and
 * throws when the repository is in a state where a clean single-path commit
 * is impossible — the throw is what quarantines the promotion and leaves the
 * artefact unwritten.
 */
export function preflightAutoCommit(cwd: string, runner: GitRunner): CommitPlan | null {
  const repoRoot = repoRootOf(cwd, runner);
  if (repoRoot === null) return null;
  const tasteRoot = join(resolve(cwd), ".omp");
  if (!isInside(repoRoot, tasteRoot)) {
    throw new Error("taste git: the taste subtree lies outside the repository");
  }
  const gitDir = firstLine(git(runner, cwd, ["rev-parse", "--absolute-git-dir"]));
  // `.git` exists but git cannot answer: there is no way to verify the
  // repository is safe, so nothing is committed and nothing is refused.
  if (!gitDir) return null;
  for (const marker of IN_PROGRESS_MARKERS) {
    if (runner.exists(join(gitDir, marker))) {
      throw new Error(`taste git: repository has an operation in progress (${marker})`);
    }
  }
  const branch = firstLine(git(runner, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]));
  if (branch === "" || branch === "HEAD") {
    throw new Error("taste git: HEAD is detached");
  }
  // `check-ignore` exits 0 when the path is ignored — the repo telling us not
  // to commit its taste subtree.
  if (git(runner, cwd, ["check-ignore", "-q", tasteRoot]).status === 0) {
    throw new Error("taste git: the taste subtree is gitignored");
  }
  const status = git(runner, cwd, ["status", "--porcelain", "--", tasteRoot]);
  if (status.status !== 0) {
    throw new Error("taste git: working-tree status is unreadable");
  }
  if (status.stdout.trim() !== "") {
    throw new Error("taste git: the taste subtree carries working-tree modifications that are not Taste's own");
  }
  return { repoRoot, tasteRoot };
}

/**
 * Build the commit message from the candidate's structural fields only. Prose
 * never reaches the message: a learned statement is derived from the human's
 * own correction text and could carry anything, including an attribution
 * token. The guard then proves the constructed message is attribution-free
 * rather than assuming it.
 */
export function commitMessageFor(candidate: PreferenceCandidate): string {
  const message = `taste: promote ${candidate.target} preference ${candidate.id} (${candidate.scope} scope)`;
  if (ATTRIBUTION_RX.test(message)) {
    throw new Error("taste git: commit message carries an attribution token");
  }
  return message;
}

/**
 * Commit exactly one promoted artefact. The pathspec is re-validated against
 * the taste-owned subtree here, at the point it is handed to git, so a writer
 * that returned a path outside that subtree refuses rather than committing
 * whatever it named. Only after that validation is the path staged, so
 * nothing outside the subtree can ever enter the index. Returns the commit
 * argv that was run, so a caller can assert on the exact shape of the write.
 */
export function commitArtefact(
  plan: CommitPlan,
  cwd: string,
  artefactPath: string,
  candidate: PreferenceCandidate,
  runner: GitRunner,
): string[] {
  const target = resolve(artefactPath);
  if (!isInside(plan.tasteRoot, target)) {
    throw new Error(`taste git: pathspec escapes the taste subtree: ${target}`);
  }
  // Every refusal is settled before the index is touched, so a rejected
  // promotion leaves nothing staged behind it.
  const message = commitMessageFor(candidate);
  stageOne(runner, cwd, target, "publish");
  const args = ["commit", "--only", "-m", message, "--", target];
  const res = git(runner, cwd, args);
  if (res.status !== 0) {
    throw new Error(`taste git: commit refused with status ${res.status}`);
  }
  return args;
}

/**
 * Commit the REMOVAL of one promoted artefact. A project-scope forget deletes
 * the artefact from the taste subtree, which would leave the subtree dirty and
 * make every later promotion refuse on the dirty-subtree condition; committing
 * the deletion keeps the subtree clean so the promotion loop stays live. The
 * caller deletes the file first; staging that path records the deletion in
 * the index, and the commit then publishes it — the identical two-step shape
 * a promotion uses. The pathspec is validated inside the taste subtree and
 * both argv run through the same guard as a promotion commit, so a removal
 * can no more smuggle a bulk-stage, force, amend, push, or
 * verification-skipping argument than a promotion can. This does not run the
 * promotion preflight, because a forget deliberately dirties
 * the subtree with the very deletion it is about to commit.
 */
export function commitRemoval(
  plan: CommitPlan,
  cwd: string,
  artefactPath: string,
  ledgerId: string,
  runner: GitRunner,
): string[] {
  const target = resolve(artefactPath);
  if (!isInside(plan.tasteRoot, target)) {
    throw new Error(`taste git: pathspec escapes the taste subtree: ${target}`);
  }
  const message = `taste: forget promotion ${ledgerId}`;
  if (ATTRIBUTION_RX.test(message)) {
    throw new Error("taste git: commit message carries an attribution token");
  }
  stageOne(runner, cwd, target, "delete");
  const args = ["commit", "--only", "-m", message, "--", target];
  const res = git(runner, cwd, args);
  if (res.status !== 0) {
    throw new Error(`taste git: removal commit refused with status ${res.status}`);
  }
  return args;
}
