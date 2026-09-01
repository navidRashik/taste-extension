import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { __setTasteStateDir, rollupTouch, type RollupSignal } from "../src/rollup.js";
import { promote, readPromotionLedger, subjectForCandidate } from "../src/promote.js";
import type { MemoryWriter, SkillWriter } from "../src/writers.js";
import type { PreferenceCandidate, PreferenceClass, PromotionTarget } from "../src/schema.js";

let stateDir: string;
let cwd: string;
const prevHome = process.env.OMP_TASTE_HOME;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "taste-promote-state-"));
  cwd = mkdtempSync(join(tmpdir(), "taste-promote-cwd-"));
  __setTasteStateDir(stateDir);
  process.env.OMP_TASTE_HOME = mkdtempSync(join(tmpdir(), "taste-promote-home-"));
});

afterEach(() => {
  __setTasteStateDir(null);
  if (prevHome === undefined) delete process.env.OMP_TASTE_HOME;
  else process.env.OMP_TASTE_HOME = prevHome;
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
});

function sig(id: string, subject: string, over: Partial<RollupSignal> = {}): RollupSignal {
  return {
    id,
    kind: "reject",
    strength: 2,
    subject,
    scopeHint: "project",
    repo: "git:acme/app",
    at: 1_700_000_000_000,
    ...over,
  };
}

// Seed the in-memory rollup so subjectForCandidate can resolve the
// candidate's evidence ids back to the subject the pre-filter needs. The
// production data path is capture → rollup, then inference produces
// candidates whose evidence ids point back into that rollup.
function seedRollup(subject: string, ...ids: string[]): void {
  for (const id of ids) rollupTouch(sig(id, subject));
}

function candidate(over: Partial<PreferenceCandidate> = {}): PreferenceCandidate {
  return {
    id: "pc_abc123",
    statement: "Use pnpm, not npm, for installs.",
    class: "implementer",
    target: "skill",
    confidence: 0.9,
    scope: "project",
    evidence: ["sig_1"],
    ...over,
  };
}

function fakeCtx(): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

function stubWriters(): { skill: SkillWriter; memory: MemoryWriter; skillCalls: number; memoryCalls: number } {
  const state = { skillCalls: 0, memoryCalls: 0 };
  const skill: SkillWriter = { write: () => { state.skillCalls += 1; return "/tmp/fake-skill.md"; } };
  const memory: MemoryWriter = { write: async () => { state.memoryCalls += 1; return "/tmp/fake-memory.json"; } };
  return { skill, memory, get skillCalls() { return state.skillCalls; }, get memoryCalls() { return state.memoryCalls; } };
}

describe("promote: class filter refuses non-implementer candidates on the auto path", () => {
  const classes: PreferenceClass[] = ["scope", "behaviour", "commitment"];
  for (const cls of classes) {
    it(`queues ${cls}-class candidates instead of arming them`, async () => {
      seedRollup("bash:pnpm add *", "sig_1");
      const stubs = stubWriters();
      const result = await promote(candidate({ class: cls }), fakeCtx(), { skillWriter: stubs.skill, memoryWriter: stubs.memory });
      expect(result.outcome).toBe("queued");
      expect(result.reason).toBe(`decision-class:${cls}`);
      expect(stubs.skillCalls).toBe(0);
      expect(stubs.memoryCalls).toBe(0);
      expect(readPromotionLedger()).toHaveLength(0);
    });
  }
});

describe("promote: irreversible pre-filter overrides an implementer label", () => {
  it("queues an implementer-labelled candidate whose subject touches rm", async () => {
    seedRollup("bash:rm *", "sig_1");
    const stubs = stubWriters();
    // The MODEL called this implementer-class — the deterministic pre-filter
    // MUST override that and refuse the auto-promotion regardless.
    const result = await promote(candidate({ class: "implementer" }), fakeCtx(), { skillWriter: stubs.skill, memoryWriter: stubs.memory });
    expect(result.outcome).toBe("queued");
    expect(result.reason).toBe("irreversible-family:bash:rm");
    expect(stubs.skillCalls).toBe(0);
    expect(readPromotionLedger()).toHaveLength(0);
  });

  it("queues an implementer-labelled candidate whose subject touches git push", async () => {
    seedRollup("bash:git push *", "sig_1");
    const stubs = stubWriters();
    const result = await promote(candidate({ class: "implementer" }), fakeCtx(), { skillWriter: stubs.skill, memoryWriter: stubs.memory });
    expect(result.outcome).toBe("queued");
    expect(result.reason).toBe("irreversible-family:bash:git push");
  });

  it("still promotes a benign implementer candidate whose subject is not on the denylist", async () => {
    seedRollup("bash:pnpm add *", "sig_1");
    const stubs = stubWriters();
    const result = await promote(candidate(), fakeCtx(), { skillWriter: stubs.skill, memoryWriter: stubs.memory });
    expect(result.outcome).toBe("promoted");
    expect(stubs.skillCalls).toBe(1);
  });
});

describe("promote: implementer-class + supported target auto-promotes and ledgers", () => {
  it("skill target writes via skillWriter and appends a ledger entry", async () => {
    seedRollup("bash:pnpm add *", "sig_1");
    const stubs = stubWriters();
    const result = await promote(candidate(), fakeCtx(), { skillWriter: stubs.skill, memoryWriter: stubs.memory });
    expect(result.outcome).toBe("promoted");
    expect(stubs.skillCalls).toBe(1);
    const ledger = readPromotionLedger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].target).toBe("skill");
    expect(ledger[0].candidateId).toBe("pc_abc123");
    expect(ledger[0].approvedBy).toBeUndefined();
  });

  it("memory target writes via memoryWriter and passes the resolved subject through", async () => {
    seedRollup("bash:pnpm add *", "sig_1");
    let subjectSeen = "";
    const memory: MemoryWriter = { write: async (_c, _ctx, subject) => { subjectSeen = subject; return "/tmp/mem.json"; } };
    const skill: SkillWriter = { write: () => "/tmp/unused" };
    const result = await promote(candidate({ target: "memory" }), fakeCtx(), { skillWriter: skill, memoryWriter: memory });
    expect(result.outcome).toBe("promoted");
    expect(subjectSeen).toBe("bash:pnpm add *");
  });
});

describe("promote: approval target dispatches to the approval writer", () => {
  it("routes an approval candidate to the approval writer with the resolved subject, leaving skill/memory untouched", async () => {
    seedRollup("bash:git status *", "sig_1");
    const stubs = stubWriters();
    let seen = "";
    const result = await promote(candidate({ target: "approval" }), fakeCtx(), {
      skillWriter: stubs.skill,
      memoryWriter: stubs.memory,
      approvalWriter: { write: (_c, _cwd, subject) => { seen = subject; return join(cwd, ".omp", "config.yml"); } },
    });
    expect(result.outcome).toBe("promoted");
    expect(seen).toBe("bash:git status *");
    expect(stubs.skillCalls).toBe(0);
    expect(stubs.memoryCalls).toBe(0);
    expect(readPromotionLedger()[0].target).toBe("approval");
  });
});

describe("promote: fail-closed — a writer throw quarantines rather than half-arming", () => {
  it("captures the error to a quarantine ledger entry", async () => {
    seedRollup("bash:pnpm add *", "sig_1");
    const throwing: SkillWriter = { write: () => { throw new Error("disk full"); } };
    const stubMem: MemoryWriter = { write: async () => "/tmp/unused" };
    const result = await promote(candidate(), fakeCtx(), { skillWriter: throwing, memoryWriter: stubMem });
    expect(result.outcome).toBe("quarantined");
    expect(result.reason).toBe("disk full");
    const ledger = readPromotionLedger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].quarantined).toBe(true);
    expect(ledger[0].quarantineReason).toBe("disk full");
    expect(ledger[0].path).toBe("");
    expect(ledger[0].approvedBy).toBeUndefined();
  });
});

describe("promote: human-approved review path (approvedBy) bypasses the class filter", () => {
  it("promotes a commitment-class candidate when approvedBy is set", async () => {
    seedRollup("bash:pnpm add *", "sig_1");
    const stubs = stubWriters();
    const result = await promote(candidate({ class: "commitment" }), fakeCtx(), {
      skillWriter: stubs.skill,
      memoryWriter: stubs.memory,
      approvedBy: "user:navid",
    });
    expect(result.outcome).toBe("promoted");
    expect(stubs.skillCalls).toBe(1);
    const ledger = readPromotionLedger();
    expect(ledger[0].approvedBy).toBe("user:navid");
  });

  it("promotes even an irreversible-family candidate when approvedBy is set", async () => {
    seedRollup("bash:rm *", "sig_1");
    const stubs = stubWriters();
    const result = await promote(candidate({ class: "commitment" }), fakeCtx(), {
      skillWriter: stubs.skill,
      memoryWriter: stubs.memory,
      approvedBy: "user:navid",
    });
    expect(result.outcome).toBe("promoted");
    const ledger = readPromotionLedger();
    expect(ledger[0].approvedBy).toBe("user:navid");
  });
});

describe("promote: subjectForCandidate resolves from the rollup", () => {
  it("returns the bucket subject when any evidence id matches", () => {
    seedRollup("bash:pnpm add *", "sig_x", "sig_y");
    expect(subjectForCandidate(candidate({ evidence: ["sig_y", "sig_missing"] }))).toBe("bash:pnpm add *");
  });

  it("returns empty when no evidence id is in the rollup", () => {
    expect(subjectForCandidate(candidate({ evidence: ["sig_unknown"] }))).toBe("");
  });
});

describe("promote: ledger persistence tolerates one bad row without dropping others", () => {
  it("skips a corrupted row and keeps the valid ones", async () => {
    seedRollup("bash:pnpm add *", "sig_1");
    const stubs = stubWriters();
    await promote(candidate(), fakeCtx(), { skillWriter: stubs.skill, memoryWriter: stubs.memory });
    // Hand-write a corrupt row into the ledger; readPromotionLedger must
    // still return the well-formed one rather than throwing.
    const file = join(stateDir, "promotion-ledger.jsonl");
    expect(existsSync(file)).toBe(true);
    const prior = readFileSync(file, "utf8");
    writeFileSync(file, `${prior}not-json\n`);
    const entries = readPromotionLedger();
    expect(entries).toHaveLength(1);
  });
});

describe("promote: cross-cutting — vi.spyOn writer receives the candidate itself", () => {
  it("hands the exact candidate object to the skill writer", async () => {
    seedRollup("bash:pnpm add *", "sig_1");
    const skillSpy = vi.fn().mockReturnValue("/tmp/skill.md");
    const memory: MemoryWriter = { write: async () => "/tmp/unused" };
    const c = candidate();
    await promote(c, fakeCtx(), { skillWriter: { write: skillSpy }, memoryWriter: memory });
    expect(skillSpy).toHaveBeenCalledWith(c, cwd);
  });
});
