// gitcommit.ts — the project-scope auto-commit writer.
//
// A learned team convention only pays off if it reaches the team, so a
// project-scope artefact is committed to the repo it was written into. The
// git write is deliberately the narrowest one that can publish a file:
//
//   git commit --only <artefact-path> -m <message>
//
// `--only` commits exactly that pathspec's working-tree content and IGNORES
// THE INDEX, so whatever the human had already staged is never swept into
// Taste's commit. There is no `git add` at any point, no `-A`, no `-a`, no
// `-f`, no `--amend`, and no push: publishing a commit to a remote stays a
// human/CI concern. Taste also never disables a repository's own hooks or
// signing, so every commit it makes is subject to exactly the checks a human
// commit is. The argument guard below is enforced on every argv this module
// builds, probes included, so the narrowness is a property of the module
// rather than of one call site.
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
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { PreferenceCandidate, PromotionTarget } from "./schema.js";

export interface GitResult {
  status: number;
  stdout: string;
}

export interface GitRunner {
  /** Run one git invocation in `cwd`. A spawn failure reports a non-zero status. */
  run(cwd: string, args: string[]): GitResult;
  /** Probe for an in-progress-operation marker inside the git directory. */
  exists(path: string): boolean;
}

/**
 * Arguments that may never appear in any git invocation Taste builds. Each
 * one widens the commit past the single promoted artefact or makes the write
 * irreversible: staging verbs sweep unrelated content in, `--amend` rewrites
 * a commit the human may already have shared, and `push` publishes.
 */
const FORBIDDEN_GIT_ARGS: Readonly<Record<string, true>> = {
  add: true,
  push: true,
  stage: true,
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
 * Run one git invocation through the seam, refusing any argv that carries a
 * forbidden or opt-out argument. The guard sits here rather than at the
 * commit call site so it covers the probes too: no code path in this module
 * can reach git with a staging, force, amend, push, or verification-skipping
 * argument.
 */
function git(runner: GitRunner, cwd: string, args: string[]): GitResult {
  for (const arg of args) {
    if (FORBIDDEN_GIT_ARGS[arg] || OPT_OUT_ARG_RX.test(arg)) {
      throw new Error(`taste git: forbidden argument in git argv: ${arg}`);
    }
  }
  return runner.run(cwd, args);
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
 * whatever it named. Returns the argv that was run, so a caller can assert on
 * the exact shape of the git write.
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
  const args = ["commit", "--only", target, "-m", commitMessageFor(candidate)];
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
 * caller deletes the file first; this records that deletion. The pathspec is
 * validated inside the taste subtree and the argv runs through the same guard
 * as a promotion commit, so a removal can no more smuggle a staging, force,
 * amend, push, or verification-skipping argument than a promotion can. This
 * does not run the promotion preflight, because a forget deliberately dirties
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
  const args = ["commit", "--only", target, "-m", message];
  const res = git(runner, cwd, args);
  if (res.status !== 0) {
    throw new Error(`taste git: removal commit refused with status ${res.status}`);
  }
  return args;
}
