// gitcommit-realgit.test.ts — the publication path against the real git binary.
//
// Every other test in this suite drives the writer through a fake seam that
// records argv and reports success. That proves the SHAPE of the write, but
// it cannot prove git accepts it: a freshly promoted artefact is a brand-new
// untracked file, and a commit naming a path git has never heard of fails
// with a pathspec error no fake will ever produce. These tests therefore
// spawn real git in a throwaway repository and assert on what actually lands
// in HEAD, so the staging step cannot be removed without a red test.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNarrowArgv,
  commitArtefact,
  commitRemoval,
  defaultGitRunner,
  preflightAutoCommit,
  FORBIDDEN_GIT_ARGS,
  type CommitPlan,
  type GitRunner,
} from "../src/gitcommit.js";
import type { PreferenceCandidate } from "../src/schema.js";

/**
 * The subject of this file is the git binary itself, so a machine without one
 * has nothing to test rather than a failing test. This is availability, not
 * suppression: where git exists the condition is false and every case below
 * runs, and no defect can hide behind it because the defect these cases catch
 * only exists when real git is the one answering.
 */
const HAS_GIT = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const SUITE = HAS_GIT
  ? "gitcommit against real git"
  : "gitcommit against real git — SKIPPED: no `git` binary on this machine";

/** The path Taste's own artefact takes inside the throwaway repository. */
const ARTEFACT_REL = ".omp/skills/taste-pc_real01/SKILL.md";

/**
 * Run git directly, outside the module's seam and its guard. This is test
 * scaffolding — repository setup and after-the-fact inspection — so it is
 * deliberately not bound by the narrowness rules the writer is bound by.
 */
function sh(cwd: string, args: string[]): string {
  const out = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (out.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${out.status}): ${out.stderr}`);
  }
  return out.stdout;
}

/** The lines of a git listing, with the trailing blank dropped. */
function lines(out: string): string[] {
  return out.split("\n").filter((l) => l !== "");
}

/** The paths one commit touched. */
function filesIn(repo: string, rev: string): string[] {
  return lines(sh(repo, ["show", "--name-only", "--pretty=format:", rev]));
}

/**
 * A repository with one seed commit and nothing else. Every setting the
 * publication depends on is pinned LOCALLY, so the machine's own git
 * configuration — a global hooks path, a signing requirement, a personal
 * ignore file listing `.omp` — cannot decide the outcome. Signing is turned
 * off by configuration rather than by a command-line opt-out, because the
 * writer is forbidden from passing one. The scratch hooks directory and
 * ignore file live inside `.git`, which is not part of the worktree, so they
 * never show up as repository content.
 */
function initRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "taste-realgit-")));
  sh(repo, ["init", "-q", "-b", "main"]);
  const hooks = join(repo, ".git", "taste-test-hooks");
  mkdirSync(hooks, { recursive: true });
  const excludes = join(repo, ".git", "taste-test-excludes");
  writeFileSync(excludes, "");
  sh(repo, ["config", "user.email", "taste@example.invalid"]);
  sh(repo, ["config", "user.name", "Taste Test"]);
  sh(repo, ["config", "commit.gpgsign", "false"]);
  sh(repo, ["config", "core.hooksPath", hooks]);
  sh(repo, ["config", "core.excludesFile", excludes]);
  writeFileSync(join(repo, "README.md"), "seed\n");
  sh(repo, ["add", "--", "README.md"]);
  sh(repo, ["commit", "-q", "-m", "seed"]);
  return repo;
}

function candidate(): PreferenceCandidate {
  return {
    id: "pc_real01",
    statement: "prefer pnpm over npm",
    class: "implementer",
    target: "skill",
    confidence: 0.9,
    scope: "project",
    evidence: ["sig_real01"],
  };
}

/** Write the artefact the way a promotion writer would: a new untracked file. */
function writeArtefact(repo: string): string {
  const artefact = join(repo, ARTEFACT_REL);
  mkdirSync(dirname(artefact), { recursive: true });
  writeFileSync(artefact, "# managed skill\n");
  return artefact;
}

describe.skipIf(!HAS_GIT)(SUITE, () => {
  let repo: string;
  let plan: CommitPlan;

  beforeEach(() => {
    repo = initRepo();
    // The preflight runs before the artefact exists, exactly as it does in
    // production, and it runs against real git rather than a declared state.
    const preflight = preflightAutoCommit(repo, defaultGitRunner);
    expect(preflight).not.toBeNull();
    plan = preflight as CommitPlan;
  });

  afterEach(() => {
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* temp dir */ }
  });

  it("pins the git behaviour the staging step exists for: an unstaged path is refused", () => {
    // This is the defect the fake-seam suite could not see, stated as a fact
    // about git rather than as a comment. Committing a pathspec git has
    // never heard of does not commit nothing — it FAILS, and it says so.
    // If a future git ever stopped refusing, this test would go red and the
    // staging step could be revisited on evidence instead of on belief.
    const artefact = writeArtefact(repo);
    const unstaged = spawnSync(
      "git",
      ["commit", "--only", "-m", "would-be promotion", "--", artefact],
      { cwd: repo, encoding: "utf8" },
    );
    expect(unstaged.status).not.toBe(0);
    expect(`${unstaged.stderr}${unstaged.stdout}`).toMatch(/did not match any file/);
    // Nothing was published by the failed attempt.
    expect(lines(sh(repo, ["ls-files"]))).not.toContain(ARTEFACT_REL);
  });

  it("commits a brand-new untracked artefact, and sweeps in nothing standing beside it", () => {
    // Unrelated work is sitting in the tree while Taste publishes: one file
    // git has never seen, and one tracked file the human has edited but not
    // committed. Neither may end up in Taste's commit.
    writeFileSync(join(repo, "unrelated.txt"), "not taste's\n");
    writeFileSync(join(repo, "README.md"), "seed, edited by a human\n");
    const artefact = writeArtefact(repo);

    const argv = commitArtefact(plan, repo, artefact, candidate(), defaultGitRunner);
    expect(argv).toEqual([
      "commit",
      "--only",
      "-m",
      "taste: promote skill preference pc_real01 (project scope)",
      "--",
      artefact,
    ]);

    // The artefact is tracked: real git accepted the write, which it cannot
    // do unless the path was staged first.
    const tracked = lines(sh(repo, ["ls-files"]));
    expect(tracked).toContain(ARTEFACT_REL);
    expect(tracked).not.toContain("unrelated.txt");
    // HEAD carries the artefact and only the artefact — the human's edited
    // README stayed out of the commit even though it was dirty.
    expect(filesIn(repo, "HEAD")).toEqual([ARTEFACT_REL]);
    expect(sh(repo, ["status", "--porcelain"])).toContain("unrelated.txt");
    expect(sh(repo, ["status", "--porcelain"])).toContain("README.md");
  });

  it("records the deletion of a tracked artefact", () => {
    const artefact = writeArtefact(repo);
    commitArtefact(plan, repo, artefact, candidate(), defaultGitRunner);
    expect(lines(sh(repo, ["ls-files"]))).toContain(ARTEFACT_REL);

    // A forget deletes the file first; the writer records that deletion.
    rmSync(artefact);
    const argv = commitRemoval(plan, repo, artefact, "pl_real01", defaultGitRunner);
    expect(argv).toEqual([
      "commit",
      "--only",
      "-m",
      "taste: forget promotion pl_real01",
      "--",
      artefact,
    ]);

    expect(lines(sh(repo, ["ls-files"]))).not.toContain(ARTEFACT_REL);
    expect(filesIn(repo, "HEAD")).toEqual([ARTEFACT_REL]);
    expect(existsSync(artefact)).toBe(false);
    // The subtree is clean again, which is the whole point of committing the
    // deletion: the next promotion's preflight must not find it dirty.
    expect(sh(repo, ["status", "--porcelain", "--", plan.tasteRoot]).trim()).toBe("");
  });

  it("REFUSES a directory pathspec, and real git is left with its contents untracked", () => {
    // The control for the whole type check, against the binary rather than
    // against a fake: `git add` on a directory stages EVERYTHING under it,
    // so if the refusal is ever removed this repository ends up publishing
    // files Taste never wrote. Both files below sit inside the taste
    // subtree, so the subtree check passes the directory happily — the type
    // check is the only thing standing between them and the index.
    const artefact = writeArtefact(repo);
    const dir = dirname(artefact);
    const bystander = join(dir, "NOTES.md");
    writeFileSync(bystander, "someone else's file\n");

    expect(() => commitArtefact(plan, repo, dir, candidate(), defaultGitRunner)).toThrow(
      /pathspec is a directory/,
    );

    // Nothing reached the index. Real git still calls both paths untracked,
    // and HEAD is the seed commit it was before.
    expect(lines(sh(repo, ["diff", "--cached", "--name-only"]))).toEqual([]);
    expect(lines(sh(repo, ["ls-files"]))).toEqual(["README.md"]);
    const untracked = sh(repo, ["status", "--porcelain", "--untracked-files=all"]);
    expect(untracked).toContain(`?? ${ARTEFACT_REL}`);
    expect(untracked).toContain("?? .omp/skills/taste-pc_real01/NOTES.md");
    expect(filesIn(repo, "HEAD")).toEqual(["README.md"]);
  });

  it("still refuses every widening, irreversible or verification-skipping argument", () => {
    // Each key the module itself declares forbidden, driven through the same
    // guard every argv in the module passes through.
    const forbidden = Object.keys(FORBIDDEN_GIT_ARGS);
    expect(forbidden.length).toBeGreaterThan(0);
    for (const arg of forbidden) {
      expect(() => assertNarrowArgv(["commit", arg])).toThrow(
        `taste git: forbidden argument in git argv: ${arg}`,
      );
    }
    // The history-rewrite flag by name, so the guard cannot quietly lose it.
    expect(forbidden).toContain("--amend");
    // The opt-out family — every option that switches a repository's own
    // verification back off — is refused wholesale by shape rather than
    // enumerated, so a harmless representative and an option git has never
    // heard of prove the rule just as well as the dangerous members do, and
    // this repository never has to spell those out.
    for (const arg of ["--no-pager", "--no-option-git-has-not-invented-yet"]) {
      expect(() => assertNarrowArgv(["commit", arg])).toThrow(
        `taste git: forbidden argument in git argv: ${arg}`,
      );
    }

    // And the guard is on the live path, not merely exported: a whole real
    // publication reaches git with no forbidden argument in any argv, and its
    // staging call names exactly one explicit pathspec.
    const seen: string[][] = [];
    const watched: GitRunner = {
      run: (cwd, args) => { seen.push(args); return defaultGitRunner.run(cwd, args); },
      exists: (path) => defaultGitRunner.exists(path),
      pathKind: (path) => defaultGitRunner.pathKind(path),
    };
    const artefact = writeArtefact(repo);
    commitArtefact(plan, repo, artefact, candidate(), watched);
    expect(lines(sh(repo, ["ls-files"]))).toContain(ARTEFACT_REL);
    expect(seen.filter((a) => a[0] === "add")).toEqual([["add", "--", artefact]]);
    for (const argv of seen) {
      for (const arg of argv) {
        expect(FORBIDDEN_GIT_ARGS[arg]).toBeUndefined();
        expect(arg.startsWith("--no-")).toBe(false);
      }
    }
  });
});
