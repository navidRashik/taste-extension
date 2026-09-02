import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { __setTasteStateDir, rollupTouch, type RollupSignal } from "../src/rollup.js";
import { promote, readPromotionLedger } from "../src/promote.js";
import {
  allowlistedFamily,
  approvalGlobFor,
  assertAllowlistWellFormed,
  NON_MUTATING_FAMILIES,
} from "../src/allowlist.js";
import { irreversibleFamily } from "../src/denylist.js";
import { defaultApprovalWriter, mergeApprovalRule, isCommandApprovalRule } from "../src/approval.js";
import { commitMessageFor, type GitRunner } from "../src/gitcommit.js";
import { defaultSkillWriter, type MemoryWriter, type SkillWriter } from "../src/writers.js";
import type { PreferenceCandidate } from "../src/schema.js";

let stateDir: string;
let cwd: string;
let home: string;
const prevHome = process.env.OMP_TASTE_HOME;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "taste-approval-state-"));
  cwd = mkdtempSync(join(tmpdir(), "taste-approval-cwd-"));
  home = mkdtempSync(join(tmpdir(), "taste-approval-home-"));
  __setTasteStateDir(stateDir);
  process.env.OMP_TASTE_HOME = home;
});

afterEach(() => {
  __setTasteStateDir(null);
  if (prevHome === undefined) delete process.env.OMP_TASTE_HOME;
  else process.env.OMP_TASTE_HOME = prevHome;
  for (const d of [stateDir, cwd, home]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function seed(subject: string, ...ids: string[]): void {
  for (const id of ids) {
    const s: RollupSignal = {
      id, kind: "reject", strength: 2, subject,
      scopeHint: "project", repo: "git:acme/app", at: 1_700_000_000_000,
    };
    rollupTouch(s);
  }
}

function fakeCtx(): ExtensionContext { return { cwd } as unknown as ExtensionContext; }

function candidate(over: Partial<PreferenceCandidate> = {}): PreferenceCandidate {
  return {
    id: "pc_ap0001",
    statement: "Stop re-confirming read-only status checks.",
    class: "implementer",
    target: "approval",
    confidence: 0.9,
    scope: "project",
    evidence: ["sig_ap1"],
    ...over,
  };
}

function unusedSkillWriter(): SkillWriter { return { write: () => { throw new Error("skill writer must not be called"); } }; }
function unusedMemoryWriter(): MemoryWriter { return { write: async () => { throw new Error("memory writer must not be called"); } }; }

/**
 * Arguments that must never reach git on any code path. Staging itself is
 * how a brand-new artefact becomes committable, so the verb is legitimate;
 * what must never appear is a flag that widens the write past the single
 * pathspec, rewrites history, or publishes.
 */
const NEVER_ARGS = ["-A", "--all", "-a", "-f", "--force", "--amend", "push"];

interface RepoState {
  root: string;
  branch?: string;
  markers?: string[];
  ignored?: boolean;
  dirty?: string;
  statusFails?: boolean;
  commitStatus?: number;
  addStatus?: number;
}

interface FakeGit extends GitRunner {
  calls: string[][];
}

/**
 * A git seam that spawns nothing. It answers each probe from a declared
 * repository state and records EVERY argv it is handed, so a test can assert
 * both the exact commit shape and the absence of any widening argument
 * across the whole promotion — probes included.
 */
function fakeGit(state: RepoState): FakeGit {
  const calls: string[][] = [];
  const gitDir = join(state.root, ".git");
  return {
    calls,
    exists(path) {
      if (path === gitDir) return true;
      for (const marker of state.markers ?? []) if (path === join(gitDir, marker)) return true;
      return false;
    },
    run(_cwd, args) {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--absolute-git-dir") return { status: 0, stdout: `${gitDir}\n` };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { status: 0, stdout: `${state.branch ?? "main"}\n` };
      if (args[0] === "check-ignore") return { status: state.ignored ? 0 : 1, stdout: "" };
      if (args[0] === "status") return state.statusFails ? { status: 128, stdout: "" } : { status: 0, stdout: state.dirty ?? "" };
      if (args[0] === "add") return { status: state.addStatus ?? 0, stdout: "" };
      if (args[0] === "commit") return { status: state.commitStatus ?? 0, stdout: "" };
      return { status: 1, stdout: "" };
    },
  };
}

/** A seam for a directory that is not a repository at all. */
function noRepoGit(): FakeGit {
  const calls: string[][] = [];
  return { calls, exists: () => false, run: (_c, args) => { calls.push(args); return { status: 1, stdout: "" }; } };
}

describe("allowlist: only explicitly non-mutating command families may become a learned auto-approval", () => {
  it("matches an allowlisted family and every argument shape the fingerprinter emits for it", () => {
    expect(allowlistedFamily("bash:git status *")).toBe("bash:git status");
    expect(allowlistedFamily("bash:ls *")).toBe("bash:ls");
    expect(allowlistedFamily("bash:ls src *")).toBe("bash:ls");
  });

  it("refuses a command that merely shares a prefix with an allowlisted one", () => {
    // `lsof` opens file descriptors; it is a different binary and the
    // trailing-space prefix must never reach it from `ls`.
    expect(allowlistedFamily("bash:lsof *")).toBeUndefined();
    expect(allowlistedFamily("bash:catalog *")).toBeUndefined();
    expect(allowlistedFamily("bash:findmnt *")).toBeUndefined();
  });

  it("refuses every mutating family, including the irreversible ones", () => {
    for (const subject of ["bash:rm *", "bash:git push *", "bash:git commit *", "bash:npm publish *", "bash:gh auth *"]) {
      expect(allowlistedFamily(subject)).toBeUndefined();
    }
  });

  it("holds no entry that overlaps an irreversible family", () => {
    expect(() => assertAllowlistWellFormed()).not.toThrow();
    for (const family of Object.keys(NON_MUTATING_FAMILIES)) {
      expect(irreversibleFamily(`${family} *`)).toBeUndefined();
    }
  });

  it("globs a single-token family with a space so the wildcard cannot cross into another binary", () => {
    expect(approvalGlobFor("bash:ls")).toBe("ls *");
    expect(approvalGlobFor("bash:git status")).toBe("git status*");
    // The property the space buys: the emitted glob cannot select `lsof`.
    const glob = approvalGlobFor("bash:ls");
    const rx = new RegExp(`^${glob.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    expect(rx.test("ls -la src")).toBe(true);
    expect(rx.test("lsof -i")).toBe(false);
  });
});

describe("approval writer: the allowlist gate is fail-closed", () => {
  it("REFUSES to write an approval for a command family that is not on the non-mutating allowlist", () => {
    expect(() => defaultApprovalWriter.write(candidate(), cwd, "bash:curl *"))
      .toThrow(/not on the non-mutating allowlist/);
    expect(existsSync(join(cwd, ".omp", "config.yml"))).toBe(false);
  });

  it("REFUSES to write an approval for an irreversible family even if it somehow reached the writer", () => {
    for (const subject of ["bash:rm *", "bash:git push *"]) {
      expect(() => defaultApprovalWriter.write(candidate(), cwd, subject)).toThrow(/allowlist|irreversible/);
    }
    expect(existsSync(join(cwd, ".omp", "config.yml"))).toBe(false);
  });

  it("rejects a rule whose glob is not a single non-empty line", () => {
    expect(isCommandApprovalRule({ match: "ls *", approval: "allow" })).toBe(true);
    expect(isCommandApprovalRule({ match: "", approval: "allow" })).toBe(false);
    expect(isCommandApprovalRule({ match: "ls *\napproval: allow", approval: "allow" })).toBe(false);
    expect(isCommandApprovalRule({ match: "ls *", approval: "yes" })).toBe(false);
  });
});

describe("approval writer: the structural merge adds one entry and disturbs nothing else", () => {
  it("creates the scoped config file with a bash.patterns block when none exists", () => {
    const file = defaultApprovalWriter.write(candidate(), cwd, "bash:git status *");
    expect(file).toBe(join(cwd, ".omp", "config.yml"));
    const body = readFileSync(file, "utf8");
    expect(body).toContain("bash:");
    expect(body).toContain("  patterns:");
    expect(body).toContain(`    - match: "git status*"`);
    expect(body).toContain("      approval: allow");
  });

  it("writes user-scope entries into the agent directory, never the repo", () => {
    const file = defaultApprovalWriter.write(candidate({ scope: "user" }), cwd, "bash:git log *");
    expect(file).toBe(join(home, ".omp", "agent", "config.yml"));
    expect(existsSync(join(cwd, ".omp", "config.yml"))).toBe(false);
  });

  it("appends to an existing pattern list, preserving every other key, comment and ordering byte-for-byte", () => {
    const prior = [
      "# hand-written, do not reformat",
      "theme:",
      "  dark: obsidian",
      "bash:",
      "  patterns:",
      `    - match: "git push*"`,
      "      approval: deny",
      "  autoBackground:",
      "    enabled: true",
      "tools:",
      "  approvalMode: write",
      "",
    ].join("\n");
    mkdirSync(join(cwd, ".omp"), { recursive: true });
    writeFileSync(join(cwd, ".omp", "config.yml"), prior);

    const file = defaultApprovalWriter.write(candidate(), cwd, "bash:git status *");
    const after = readFileSync(file, "utf8").split("\n");
    // Exactly two lines were added, and removing them recovers the original.
    expect(after).toHaveLength(prior.split("\n").length + 2);
    const inserted = after.indexOf(`    - match: "git status*"`);
    expect(inserted).toBeGreaterThan(-1);
    // Appended AFTER the human's deny rule: the first matching rule wins, so
    // a learned allow can never override a hand-written deny.
    expect(inserted).toBeGreaterThan(after.indexOf(`    - match: "git push*"`));
    expect(after[inserted + 1]).toBe("      approval: allow");
    const recovered = [...after];
    recovered.splice(inserted, 2);
    expect(recovered.join("\n")).toBe(prior);
  });

  it("is idempotent — a repeated promotion of the same family adds no second entry", () => {
    const file = defaultApprovalWriter.write(candidate(), cwd, "bash:git status *");
    const once = readFileSync(file, "utf8");
    defaultApprovalWriter.write(candidate(), cwd, "bash:git status *");
    expect(readFileSync(file, "utf8")).toBe(once);
  });

  it("refuses a config whose bash key carries an inline value rather than rewriting it", () => {
    mkdirSync(join(cwd, ".omp"), { recursive: true });
    writeFileSync(join(cwd, ".omp", "config.yml"), "bash: {}\n");
    expect(() => defaultApprovalWriter.write(candidate(), cwd, "bash:git status *"))
      .toThrow(/unsupported bash config shape/);
  });

  it("reports the exact line insertion so the write can be proven reversible", () => {
    const prior = "theme:\n  dark: obsidian\n";
    const merge = mergeApprovalRule(prior, { match: "ls *", approval: "allow" });
    expect(merge).not.toBeNull();
    const lines = merge!.next.split("\n");
    const recovered = [...lines];
    recovered.splice(merge!.at, merge!.inserted.length);
    expect(recovered.join("\n")).toBe(prior);
  });
});

describe("promote: approval target end-to-end", () => {
  it("promotes an allowlisted approval candidate and ledgers the config path", async () => {
    seed("bash:git status *", "sig_ap1");
    const result = await promote(candidate(), fakeCtx(), {
      skillWriter: unusedSkillWriter(),
      memoryWriter: unusedMemoryWriter(),
      git: noRepoGit(),
    });
    expect(result.outcome).toBe("promoted");
    expect(result.entry?.path).toBe(join(cwd, ".omp", "config.yml"));
    expect(readFileSync(result.entry!.path, "utf8")).toContain(`    - match: "git status*"`);
  });

  it("QUARANTINES an approval candidate for a non-allowlisted command and writes no config at all", async () => {
    seed("bash:curl *", "sig_ap2");
    const result = await promote(candidate({ evidence: ["sig_ap2"] }), fakeCtx(), {
      skillWriter: unusedSkillWriter(),
      memoryWriter: unusedMemoryWriter(),
      git: noRepoGit(),
    });
    expect(result.outcome).toBe("quarantined");
    expect(result.reason).toMatch(/not on the non-mutating allowlist/);
    expect(existsSync(join(cwd, ".omp", "config.yml"))).toBe(false);
    expect(readPromotionLedger()[0].quarantined).toBe(true);
  });

  it("QUEUES before the writer is ever reached when the command is an irreversible family", async () => {
    seed("bash:git push *", "sig_ap3");
    const result = await promote(candidate({ evidence: ["sig_ap3"] }), fakeCtx(), {
      skillWriter: unusedSkillWriter(),
      memoryWriter: unusedMemoryWriter(),
      git: noRepoGit(),
    });
    expect(result.outcome).toBe("queued");
    expect(result.reason).toBe("irreversible-family:bash:git push");
    expect(existsSync(join(cwd, ".omp", "config.yml"))).toBe(false);
  });

  it("quarantines when the structural merge cannot preserve the existing config", async () => {
    seed("bash:git status *", "sig_ap4");
    mkdirSync(join(cwd, ".omp"), { recursive: true });
    writeFileSync(join(cwd, ".omp", "config.yml"), "bash: {}\n");
    const result = await promote(candidate({ evidence: ["sig_ap4"] }), fakeCtx(), {
      skillWriter: unusedSkillWriter(),
      memoryWriter: unusedMemoryWriter(),
      git: noRepoGit(),
    });
    expect(result.outcome).toBe("quarantined");
    expect(readFileSync(join(cwd, ".omp", "config.yml"), "utf8")).toBe("bash: {}\n");
  });
});

describe("auto-commit: the git write is one staged path and one narrow pathspec commit", () => {
  it("stages exactly the artefact, then commits it with `commit --only -m <msg> -- <path>` and nothing else", async () => {
    seed("bash:pnpm add *", "sig_g1");
    const git = fakeGit({ root: cwd });
    const result = await promote(
      candidate({ id: "pc_skill01", target: "skill", evidence: ["sig_g1"] }),
      fakeCtx(),
      { skillWriter: defaultSkillWriter, memoryWriter: unusedMemoryWriter(), git },
    );
    expect(result.outcome).toBe("promoted");
    const writes = git.calls.filter((a) => a[0] === "add" || a[0] === "commit");
    const artefact = join(cwd, ".omp", "skills", "taste-pc_skill01", "SKILL.md");
    // The publication is exactly two invocations: the one artefact path into
    // the index, then a commit bounded to that same path.
    expect(writes).toEqual([
      ["add", "--", artefact],
      ["commit", "--only", "-m", "taste: promote skill preference pc_skill01 (project scope)", "--", artefact],
    ]);
  });

  it("never hands git a widening, force, amend or push argument on ANY probe or write", async () => {
    seed("bash:pnpm add *", "sig_g2");
    const git = fakeGit({ root: cwd });
    const result = await promote(
      candidate({ id: "pc_skill02", target: "skill", evidence: ["sig_g2"] }),
      fakeCtx(),
      { skillWriter: defaultSkillWriter, memoryWriter: unusedMemoryWriter(), git },
    );
    // The promotion must actually have reached the commit, otherwise the
    // scan below would pass simply because nothing was ever handed to git.
    expect(result.outcome).toBe("promoted");
    expect(git.calls.filter((a) => a[0] === "commit")).toHaveLength(1);
    // Staging is permitted, but only ever as one explicit pathspec.
    for (const argv of git.calls.filter((a) => a[0] === "add")) {
      expect(argv).toHaveLength(3);
      expect(argv[1]).toBe("--");
    }
    for (const argv of git.calls) {
      for (const forbidden of NEVER_ARGS) expect(argv).not.toContain(forbidden);
      expect(argv.some((a) => a.startsWith("--no-"))).toBe(false);
    }
  });

  it("commits an approval config entry through the identical narrow path", async () => {
    seed("bash:git status *", "sig_g3");
    const git = fakeGit({ root: cwd });
    const result = await promote(candidate({ evidence: ["sig_g3"] }), fakeCtx(), {
      skillWriter: unusedSkillWriter(), memoryWriter: unusedMemoryWriter(), git,
    });
    expect(result.outcome).toBe("promoted");
    const config = join(cwd, ".omp", "config.yml");
    expect(git.calls.filter((a) => a[0] === "add" || a[0] === "commit")).toEqual([
      ["add", "--", config],
      ["commit", "--only", "-m", "taste: promote approval preference pc_ap0001 (project scope)", "--", config],
    ]);
  });

  it("builds a commit message carrying no assistant-attribution token", () => {
    expect(commitMessageFor(candidate())).toBe("taste: promote approval preference pc_ap0001 (project scope)");
    expect(() => commitMessageFor(candidate({ id: "pc_gpt_written" }))).toThrow(/attribution token/);
  });
});

describe("auto-commit: fires only for project scope, and only for repo artefacts", () => {
  it("NEVER touches git for a user-scope promotion", async () => {
    seed("bash:git log *", "sig_u1");
    const git = fakeGit({ root: cwd });
    const result = await promote(
      candidate({ scope: "user", evidence: ["sig_u1"] }),
      fakeCtx(),
      { skillWriter: unusedSkillWriter(), memoryWriter: unusedMemoryWriter(), git },
    );
    // The no-git guarantee is asserted first: a scope-guard regression must
    // surface as "git was called", not as a downstream quarantine.
    expect(git.calls).toEqual([]);
    expect(result.outcome).toBe("promoted");
    expect(result.entry?.path).toBe(join(home, ".omp", "agent", "config.yml"));
  });

  it("never commits a memory promotion — it has no file in the repo to commit", async () => {
    seed("bash:pnpm add *", "sig_m1");
    const git = fakeGit({ root: cwd });
    const memory: MemoryWriter = { write: async () => "memory:runtime" };
    const result = await promote(
      candidate({ target: "memory", evidence: ["sig_m1"] }),
      fakeCtx(),
      { skillWriter: unusedSkillWriter(), memoryWriter: memory, git },
    );
    expect(result.outcome).toBe("promoted");
    expect(git.calls).toEqual([]);
  });

  it("writes the artefact and commits nothing when the directory is not a git repository", async () => {
    seed("bash:pnpm add *", "sig_n1");
    const git = noRepoGit();
    const result = await promote(
      candidate({ id: "pc_skill03", target: "skill", evidence: ["sig_n1"] }),
      fakeCtx(),
      { skillWriter: defaultSkillWriter, memoryWriter: unusedMemoryWriter(), git },
    );
    expect(result.outcome).toBe("promoted");
    expect(existsSync(join(cwd, ".omp", "skills", "taste-pc_skill03", "SKILL.md"))).toBe(true);
    expect(git.calls).toEqual([]);
  });
});

describe("auto-commit: unsafe repository states refuse the promotion and leave the artefact unwritten", () => {
  const artefact = () => join(cwd, ".omp", "skills", "taste-pc_skill04", "SKILL.md");

  async function promoteInto(state: RepoState): Promise<{ outcome: string; reason?: string; git: FakeGit }> {
    seed("bash:pnpm add *", "sig_r1");
    const git = fakeGit(state);
    const res = await promote(
      candidate({ id: "pc_skill04", target: "skill", evidence: ["sig_r1"] }),
      fakeCtx(),
      { skillWriter: defaultSkillWriter, memoryWriter: unusedMemoryWriter(), git },
    );
    return { outcome: res.outcome, reason: res.reason, git };
  }

  it("refuses on a detached HEAD", async () => {
    const { outcome, reason, git } = await promoteInto({ root: cwd, branch: "HEAD" });
    expect(outcome).toBe("quarantined");
    expect(reason).toMatch(/HEAD is detached/);
    expect(existsSync(artefact())).toBe(false);
    expect(git.calls.filter((a) => a[0] === "commit")).toHaveLength(0);
  });

  for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "BISECT_LOG", "CHERRY_PICK_HEAD"]) {
    it(`refuses while ${marker} marks an operation in progress`, async () => {
      const { outcome, reason } = await promoteInto({ root: cwd, markers: [marker] });
      expect(outcome).toBe("quarantined");
      expect(reason).toBe(`taste git: repository has an operation in progress (${marker})`);
      expect(existsSync(artefact())).toBe(false);
    });
  }

  it("refuses when the taste subtree is gitignored — the repo said not to commit it", async () => {
    const { outcome, reason } = await promoteInto({ root: cwd, ignored: true });
    expect(outcome).toBe("quarantined");
    expect(reason).toMatch(/gitignored/);
    expect(existsSync(artefact())).toBe(false);
  });

  it("refuses when the taste subtree already carries modifications that are not Taste's own", async () => {
    const { outcome, reason } = await promoteInto({ root: cwd, dirty: " M .omp/rules/hand-written.md\n" });
    expect(outcome).toBe("quarantined");
    expect(reason).toMatch(/working-tree modifications/);
    expect(existsSync(artefact())).toBe(false);
  });

  it("refuses when the working-tree status cannot be read", async () => {
    const { outcome, reason } = await promoteInto({ root: cwd, statusFails: true });
    expect(outcome).toBe("quarantined");
    expect(reason).toMatch(/status is unreadable/);
    expect(existsSync(artefact())).toBe(false);
  });

  it("quarantines when git itself refuses the commit", async () => {
    const { outcome, reason } = await promoteInto({ root: cwd, commitStatus: 1 });
    expect(outcome).toBe("quarantined");
    expect(reason).toMatch(/commit refused with status 1/);
  });

  it("quarantines when git refuses to stage the artefact", async () => {
    const { outcome, reason, git } = await promoteInto({ root: cwd, addStatus: 1 });
    expect(outcome).toBe("quarantined");
    expect(reason).toMatch(/staging refused with status 1/);
    // A failed staging must stop the publication, not fall through to a
    // commit that would then name a path git has never heard of.
    expect(git.calls.filter((a) => a[0] === "commit")).toHaveLength(0);
  });

  it("refuses a pathspec that escapes the taste-owned subtree", async () => {
    seed("bash:pnpm add *", "sig_e1");
    const git = fakeGit({ root: cwd });
    const escaping: SkillWriter = { write: () => join(cwd, "src", "not-taste.md") };
    const result = await promote(
      candidate({ target: "skill", evidence: ["sig_e1"] }),
      fakeCtx(),
      { skillWriter: escaping, memoryWriter: unusedMemoryWriter(), git },
    );
    expect(result.outcome).toBe("quarantined");
    expect(result.reason).toMatch(/pathspec escapes the taste subtree/);
    // Nothing outside the taste subtree may even reach the index.
    expect(git.calls.filter((a) => a[0] === "add" || a[0] === "commit")).toEqual([]);
  });
});
