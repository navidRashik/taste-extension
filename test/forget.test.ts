import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { __setTasteStateDir, rollupTouch, tasteStateDir } from "../src/rollup.js";
import { readPromotionLedger } from "../src/promote.js";
import { TOMBSTONE_PREFIX, ledgerView } from "../src/apply.js";
import { forgetPromotion, forgetPromotions, removeApprovalRule } from "../src/forget.js";
import type { GitRunner } from "../src/gitcommit.js";
import type { PreferenceCandidate, PromotionLedgerEntry } from "../src/schema.js";

let stateDir: string;
let cwd: string;
const prevHome = process.env.OMP_TASTE_HOME;

function fakeCtx(): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

function entry(over: Partial<PromotionLedgerEntry> = {}): PromotionLedgerEntry {
  return {
    id: "pl_1",
    candidateId: "cand_1",
    target: "skill",
    scope: "project",
    path: join(cwd, ".omp", "skills", "taste-pnpm", "SKILL.md"),
    at: 1,
    ...over,
  };
}

function candidate(over: Partial<PreferenceCandidate> = {}): PreferenceCandidate {
  return {
    id: "cand_1",
    statement: "this repo uses pnpm",
    class: "implementer",
    target: "approval",
    confidence: 0.9,
    scope: "project",
    evidence: ["sig_1"],
    ...over,
  };
}

/** Write a file and every directory above it. */
function put(path: string, body: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
}

/** A git runner that records every argv and reports a clean repository. */
function recordingGit(over: Partial<{ statusOut: string; commitStatus: number }> = {}): {
  git: GitRunner;
  argvs: string[][];
} {
  const argvs: string[][] = [];
  const git: GitRunner = {
    run(_cwd, args) {
      argvs.push(args);
      if (args[0] === "rev-parse" && args[1] === "--absolute-git-dir") return { status: 0, stdout: join(cwd, ".git") };
      if (args[0] === "rev-parse") return { status: 0, stdout: "main" };
      if (args[0] === "check-ignore") return { status: 1, stdout: "" };
      if (args[0] === "status") return { status: 0, stdout: over.statusOut ?? "" };
      if (args[0] === "commit") return { status: over.commitStatus ?? 0, stdout: "" };
      return { status: 0, stdout: "" };
    },
    exists: (path) => path === join(cwd, ".git") || existsSync(path),
  };
  return { git, argvs };
}

/** A git runner for a directory that is not a repository at all. */
const NO_REPO_GIT: GitRunner = { run: () => ({ status: 1, stdout: "" }), exists: () => false };

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "taste-forget-state-"));
  cwd = mkdtempSync(join(tmpdir(), "taste-forget-cwd-"));
  __setTasteStateDir(stateDir);
  process.env.OMP_TASTE_HOME = mkdtempSync(join(tmpdir(), "taste-forget-home-"));
});

afterEach(() => {
  __setTasteStateDir(null);
  if (prevHome === undefined) delete process.env.OMP_TASTE_HOME;
  else process.env.OMP_TASTE_HOME = prevHome;
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* temp dir */ }
  try { rmSync(cwd, { recursive: true, force: true }); } catch { /* temp dir */ }
});

describe("forget: the artefact actually leaves disk", () => {
  it("deletes the promoted skill file and its now-empty managed directory", () => {
    const file = put(entry().path, "# managed skill\n");
    const outcome = forgetPromotion(entry(), fakeCtx(), { git: NO_REPO_GIT });
    expect(outcome.removed).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(file, ".."))).toBe(false);
  });

  it("deletes a promoted rule file", () => {
    const path = join(cwd, ".omp", "rules", "pnpm.md");
    put(path, "rule body\n");
    const outcome = forgetPromotion(entry({ target: "rule", path }), fakeCtx(), { git: NO_REPO_GIT });
    expect(outcome.removed).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("deletes a staged memory row from the profile state root", () => {
    const path = join(tasteStateDir(), "pending-memories", "cand_1.json");
    put(path, "{}\n");
    const outcome = forgetPromotion(entry({ target: "memory", scope: "user", path }), fakeCtx(), { git: NO_REPO_GIT });
    expect(outcome.removed).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("leaves a directory that still holds someone else's file", () => {
    const file = put(entry().path, "# managed skill\n");
    const sibling = put(join(file, "..", "NOTES.md"), "hand written\n");
    forgetPromotion(entry(), fakeCtx(), { git: NO_REPO_GIT });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  it("completes a half-finished earlier reversal rather than jamming", () => {
    // The artefact is already gone; the reversal still tombstones the row.
    const outcome = forgetPromotion(entry(), fakeCtx(), { git: NO_REPO_GIT });
    expect(outcome.removed).toBe(true);
    expect(outcome.reason).toBeUndefined();
  });
});

describe("forget: a path outside the scoped roots is refused untouched", () => {
  it("refuses an absolute path outside the project and profile roots", () => {
    const outside = put(join(cwd, "..", `taste-forget-outsider-${process.pid}.md`), "not taste's\n");
    const outcome = forgetPromotion(entry({ path: outside }), fakeCtx(), { git: NO_REPO_GIT });
    expect(outcome.removed).toBe(false);
    expect(outcome.reason).toContain("escapes the scoped roots");
    expect(existsSync(outside)).toBe(true);
    rmSync(outside, { force: true });
  });

  it("refuses a traversal that climbs out of the project scope root", () => {
    const victim = put(join(cwd, "important.txt"), "keep me\n");
    const traversal = join(cwd, ".omp", "skills", "..", "..", "important.txt");
    const outcome = forgetPromotion(entry({ path: traversal }), fakeCtx(), { git: NO_REPO_GIT });
    expect(outcome.removed).toBe(false);
    expect(outcome.reason).toContain("escapes the scoped roots");
    expect(readFileSync(victim, "utf8")).toBe("keep me\n");
  });

  it("refuses a user-scope row that names a path in the project tree", () => {
    // The row claims user scope, so the project subtree is not one of its
    // roots and the artefact must survive.
    const projectFile = put(join(cwd, ".omp", "skills", "taste-x", "SKILL.md"), "project\n");
    const outcome = forgetPromotion(entry({ scope: "user", path: projectFile }), fakeCtx(), { git: NO_REPO_GIT });
    expect(outcome.removed).toBe(false);
    expect(existsSync(projectFile)).toBe(true);
  });

  it("refuses a home-directory path that only looks like the user root", () => {
    const lookalike = join(homedir(), ".omp-not-taste", "SKILL.md");
    const outcome = forgetPromotion(entry({ scope: "user", path: lookalike }), fakeCtx(), { git: NO_REPO_GIT });
    expect(outcome.removed).toBe(false);
    expect(outcome.reason).toContain("escapes the scoped roots");
  });

  it("refuses a row that names no artefact at all", () => {
    const outcome = forgetPromotion(entry({ path: "" }), fakeCtx(), { git: NO_REPO_GIT });
    expect(outcome.removed).toBe(false);
    expect(outcome.reason).toContain("no artefact");
  });

  it("reports that a memory held by the harness runtime cannot be removed", () => {
    const outcome = forgetPromotion(entry({ target: "memory", path: "memory:runtime" }), fakeCtx(), { git: NO_REPO_GIT });
    expect(outcome.removed).toBe(false);
    expect(outcome.reason).toContain("runtime");
  });
});

describe("forget: an approval is reversed by lifting out exactly its own lines", () => {
  const CONFIG = [
    "tools:",
    "  approval:",
    '    - match: "ls *"',
    "      approval: auto",
    '    - match: "git status *"',
    "      approval: auto",
    "",
  ].join("\n");

  it("removes only the learned rule and leaves the rest byte-for-byte", () => {
    const path = put(join(cwd, ".omp", "config.yml"), CONFIG);
    const c = candidate({ evidence: ["sig_ls"] });
    // subjectForCandidate resolves evidence ids through the rollup, exactly
    // as the writer did when the approval was promoted.
    rollupTouch({
      id: "sig_ls",
      kind: "reject",
      strength: 2,
      subject: "bash:ls *",
      scopeHint: "project",
      repo: "git:acme/app",
      at: 1_700_000_000_000,
    });
    const outcome = forgetPromotion(
      entry({ target: "approval", path }),
      fakeCtx(),
      { git: NO_REPO_GIT, candidates: [c] },
    );
    // The candidate's own subject decides which rule is lifted out.
    expect(outcome.removed).toBe(true);
    const after = readFileSync(path, "utf8");
    expect(after).toContain('- match: "git status *"');
    expect(after.split("\n").length).toBe(CONFIG.split("\n").length - 2);
  });

  it("refuses when the candidate backing the entry is gone", () => {
    const path = put(join(cwd, ".omp", "config.yml"), CONFIG);
    const outcome = forgetPromotion(entry({ target: "approval", path }), fakeCtx(), { git: NO_REPO_GIT, candidates: [] });
    expect(outcome.removed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(CONFIG);
  });

  it("never deletes the shared config file itself", () => {
    const path = put(join(cwd, ".omp", "config.yml"), CONFIG);
    forgetPromotion(entry({ target: "approval", path }), fakeCtx(), { git: NO_REPO_GIT, candidates: [candidate()] });
    expect(existsSync(path)).toBe(true);
  });

  it("removes the rule and its policy line as one unit", () => {
    const next = removeApprovalRule(CONFIG, "ls *");
    expect(next).not.toBeNull();
    expect(next).not.toContain('"ls *"');
    expect(next).toContain('"git status *"');
  });

  it("reports a rule that is not present rather than corrupting the file", () => {
    expect(removeApprovalRule(CONFIG, "cargo build *")).toBeNull();
  });
});

describe("forget: the removal is published exactly as narrowly as the promotion", () => {
  it("commits the deletion with the one narrow argv and nothing else", () => {
    const file = put(entry().path, "# managed skill\n");
    const { git, argvs } = recordingGit();
    const outcome = forgetPromotion(entry(), fakeCtx(), { git });
    expect(outcome.removed).toBe(true);
    expect(outcome.committed).toBe(true);
    const commits = argvs.filter((a) => a[0] === "commit");
    expect(commits).toEqual([["commit", "--only", resolve(file), "-m", "taste: forget promotion pl_1"]]);
  });

  it("never runs git for a user-scope reversal", () => {
    const path = join(tasteStateDir(), "pending-memories", "cand_1.json");
    put(path, "{}\n");
    const { git, argvs } = recordingGit();
    const outcome = forgetPromotion(entry({ target: "memory", scope: "user", path }), fakeCtx(), { git });
    expect(outcome.removed).toBe(true);
    expect(outcome.committed).toBe(false);
    expect(argvs).toEqual([]);
  });

  it("removes the artefact anyway when the subtree was already dirty", () => {
    const file = put(entry().path, "# managed skill\n");
    // Somebody else's edit is sitting in the subtree: the plan cannot be
    // taken, but undo must still work.
    const { git, argvs } = recordingGit({ statusOut: " M .omp/notes.md\n" });
    const outcome = forgetPromotion(entry(), fakeCtx(), { git });
    expect(existsSync(file)).toBe(false);
    expect(outcome.removed).toBe(true);
    expect(outcome.committed).toBe(false);
    expect(outcome.reason).toContain("not published");
    expect(argvs.filter((a) => a[0] === "commit")).toEqual([]);
  });

  it("reports an unpublished removal when the commit itself is refused", () => {
    const file = put(entry().path, "# managed skill\n");
    const { git } = recordingGit({ commitStatus: 1 });
    const outcome = forgetPromotion(entry(), fakeCtx(), { git });
    expect(existsSync(file)).toBe(false);
    expect(outcome.removed).toBe(true);
    expect(outcome.committed).toBe(false);
    expect(outcome.reason).toContain("not published");
  });

  it("does not try to commit a memory promotion, which is never committed", () => {
    const path = join(cwd, ".omp", "pending-memories", "cand_1.json");
    put(path, "{}\n");
    const { git, argvs } = recordingGit();
    forgetPromotion(entry({ target: "memory", path }), fakeCtx(), { git });
    expect(argvs).toEqual([]);
  });
});

describe("forget: the reversal is a fact on disk", () => {
  it("appends a tombstone naming the row it reverses", () => {
    put(entry().path, "# managed skill\n");
    forgetPromotion(entry(), fakeCtx(), { git: NO_REPO_GIT, now: 42 });
    const rows = readPromotionLedger();
    expect(rows).toHaveLength(1);
    expect(rows[0].quarantineReason).toBe(`${TOMBSTONE_PREFIX}pl_1`);
    expect(rows[0].at).toBe(42);
  });

  it("takes the promotion out of the armed view once reversed", () => {
    const file = join(stateDir, "promotion-ledger.jsonl");
    put(file, `${JSON.stringify(entry())}\n`);
    put(entry().path, "# managed skill\n");
    forgetPromotion(entry(), fakeCtx(), { git: NO_REPO_GIT });
    expect(ledgerView(readPromotionLedger()).armed).toEqual([]);
  });

  it("keeps going through a bulk reversal and reports each outcome", () => {
    const good = put(join(cwd, ".omp", "rules", "a.md"), "a\n");
    const outside = join(cwd, "..", `taste-forget-bulk-${process.pid}.md`);
    put(outside, "b\n");
    const outcomes = forgetPromotions(
      [entry({ id: "pl_a", target: "rule", path: good }), entry({ id: "pl_b", target: "rule", path: outside })],
      fakeCtx(),
      { git: NO_REPO_GIT },
    );
    expect(outcomes.map((o) => o.removed)).toEqual([true, false]);
    expect(existsSync(good)).toBe(false);
    expect(existsSync(outside)).toBe(true);
    rmSync(outside, { force: true });
  });
});
