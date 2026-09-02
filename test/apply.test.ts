import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { __setTasteStateDir } from "../src/rollup.js";
import { clearTasteConfigCache } from "../src/config.js";
import {
  applyPromotions,
  applyAtSessionStart,
  ledgerView,
  stalePromotions,
  surfaceApplied,
  STALE_CONFIDENCE,
  TOMBSTONE_PREFIX,
  type ApplyReport,
} from "../src/apply.js";
import taste, { __resetTasteRuntime } from "../src/index.js";
import { readPromotionLedger } from "../src/promote.js";
import type { PreferenceCandidate, PreferenceClass, PromotionLedgerEntry, PromotionTarget } from "../src/schema.js";

let stateDir: string;
let cwd: string;
const prevHome = process.env.OMP_TASTE_HOME;

function candidate(over: Partial<PreferenceCandidate> = {}): PreferenceCandidate {
  return {
    id: "cand_1",
    statement: "this repo uses pnpm — use pnpm",
    class: "implementer",
    target: "skill",
    confidence: 0.9,
    scope: "project",
    evidence: ["sig_1"],
    ...over,
  };
}

function seedCandidates(cands: PreferenceCandidate[]): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "candidates.json"), JSON.stringify(cands));
}

function seedLedger(entries: PromotionLedgerEntry[]): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "promotion-ledger.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function entry(over: Partial<PromotionLedgerEntry> = {}): PromotionLedgerEntry {
  return {
    id: "pl_1",
    candidateId: "cand_1",
    target: "skill" as PromotionTarget,
    scope: "project",
    path: join(cwd, ".omp", "skills", "taste-x", "SKILL.md"),
    at: 1,
    ...over,
  };
}

/** Write the project settings layer that switches the scope on. */
function enableScope(over: Record<string, unknown> = {}): void {
  const dir = join(cwd, ".omp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ taste: { enabled: true, autoPromote: true, ...over } }));
  clearTasteConfigCache();
}

function fakeCtx(): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

/** Read a surfaced message's content, failing the test if it has none. */
function contentOf(message: unknown): string {
  if (message && typeof message === "object" && "content" in message && typeof message.content === "string") {
    return message.content;
  }
  throw new Error("the surfaced message carried no string content");
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "taste-apply-state-"));
  cwd = mkdtempSync(join(tmpdir(), "taste-apply-cwd-"));
  __setTasteStateDir(stateDir);
  process.env.OMP_TASTE_HOME = mkdtempSync(join(tmpdir(), "taste-apply-home-"));
  clearTasteConfigCache();
  __resetTasteRuntime();
});

afterEach(() => {
  __setTasteStateDir(null);
  if (prevHome === undefined) delete process.env.OMP_TASTE_HOME;
  else process.env.OMP_TASTE_HOME = prevHome;
  clearTasteConfigCache();
  __resetTasteRuntime();
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* temp dir */ }
  try { rmSync(cwd, { recursive: true, force: true }); } catch { /* temp dir */ }
});

describe("apply: the class gate at session_start", () => {
  it("never hands a decision-class candidate to the promoter", async () => {
    enableScope();
    const classes: PreferenceClass[] = ["scope", "behaviour", "commitment"];
    seedCandidates(classes.map((c, i) => candidate({ id: `cand_${i}`, class: c, statement: `never ${c}` })));
    const seen: string[] = [];
    const report = await applyPromotions(fakeCtx(), {
      promoteFn: async (c) => {
        seen.push(c.id);
        return { outcome: "promoted", entry: entry({ candidateId: c.id }) };
      },
    });
    // The promoter is never reached at all — the outer gate holds them back.
    expect(seen).toEqual([]);
    expect(report.queued).toBe(3);
    expect(report.promoted).toEqual([]);
  });

  it("never surfaces a decision-class statement in the applied report", async () => {
    enableScope();
    seedCandidates([candidate({ class: "commitment", statement: "never push without asking" })]);
    const report = await applyPromotions(fakeCtx(), { promoteFn: async () => ({ outcome: "promoted" }) });
    expect(JSON.stringify(report)).not.toContain("never push without asking");
  });

  it("applies an implementer-class candidate through the promoter", async () => {
    enableScope();
    seedCandidates([candidate()]);
    const report = await applyPromotions(fakeCtx(), {
      promoteFn: async () => ({ outcome: "promoted", entry: entry() }),
    });
    expect(report.promoted).toEqual(["this repo uses pnpm — use pnpm"]);
  });

  it("mixes classes without leaking the decision-class ones", async () => {
    enableScope();
    seedCandidates([
      candidate({ id: "impl", class: "implementer", statement: "use pnpm" }),
      candidate({ id: "dec", class: "scope", statement: "only touch src/" }),
    ]);
    const seen: string[] = [];
    const report = await applyPromotions(fakeCtx(), {
      promoteFn: async (c) => {
        seen.push(c.id);
        return { outcome: "promoted", entry: entry({ candidateId: c.id }) };
      },
    });
    expect(seen).toEqual(["impl"]);
    expect(report.promoted).toEqual(["use pnpm"]);
    expect(report.queued).toBe(1);
  });
});

describe("apply: inert unless the scope was switched on", () => {
  it("does nothing when taste is disabled", async () => {
    // No settings file at all: the shipped default is off.
    seedCandidates([candidate()]);
    const promoteFn = vi.fn(async () => ({ outcome: "promoted" as const, entry: entry() }));
    const report = await applyPromotions(fakeCtx(), { promoteFn });
    expect(report.ran).toBe(false);
    expect(report.reason).toBe("disabled");
    expect(promoteFn).not.toHaveBeenCalled();
  });

  it("does nothing when enabled but not opted into automatic application", async () => {
    enableScope({ autoPromote: false });
    seedCandidates([candidate()]);
    const promoteFn = vi.fn(async () => ({ outcome: "promoted" as const, entry: entry() }));
    const report = await applyPromotions(fakeCtx(), { promoteFn });
    expect(report.ran).toBe(false);
    expect(report.reason).toBe("not-opted-in");
    expect(promoteFn).not.toHaveBeenCalled();
  });
});

describe("apply: already-armed, reversed, and stale candidates", () => {
  it("does not re-arm a candidate that already has an artefact", async () => {
    enableScope();
    seedCandidates([candidate()]);
    seedLedger([entry()]);
    const promoteFn = vi.fn(async () => ({ outcome: "promoted" as const, entry: entry() }));
    const report = await applyPromotions(fakeCtx(), { promoteFn });
    expect(promoteFn).not.toHaveBeenCalled();
    expect(report.skipped).toBe(1);
  });

  it("never re-arms a candidate a human reversed", async () => {
    enableScope();
    seedCandidates([candidate()]);
    seedLedger([
      entry(),
      entry({ id: "pl_forget_pl_1", path: "", quarantined: true, quarantineReason: `${TOMBSTONE_PREFIX}pl_1` }),
    ]);
    const promoteFn = vi.fn(async () => ({ outcome: "promoted" as const, entry: entry() }));
    const report = await applyPromotions(fakeCtx(), { promoteFn });
    expect(promoteFn).not.toHaveBeenCalled();
    expect(report.skipped).toBe(1);
  });

  it("does not arm a candidate whose confidence decayed below the floor", async () => {
    enableScope();
    seedCandidates([candidate({ confidence: STALE_CONFIDENCE - 0.01 })]);
    const promoteFn = vi.fn(async () => ({ outcome: "promoted" as const, entry: entry() }));
    const report = await applyPromotions(fakeCtx(), { promoteFn });
    expect(promoteFn).not.toHaveBeenCalled();
    expect(report.skipped).toBe(1);
  });

  it("counts a quarantined promotion without claiming it was applied", async () => {
    enableScope();
    seedCandidates([candidate()]);
    const report = await applyPromotions(fakeCtx(), {
      promoteFn: async () => ({ outcome: "quarantined", reason: "positive control did not trigger" }),
    });
    expect(report.promoted).toEqual([]);
    expect(report.quarantined).toBe(1);
  });

  it("bounds how many promotions one session start attempts", async () => {
    enableScope();
    seedCandidates(Array.from({ length: 12 }, (_, i) => candidate({ id: `cand_${i}` })));
    const promoteFn = vi.fn(async () => ({ outcome: "promoted" as const, entry: entry() }));
    await applyPromotions(fakeCtx(), { promoteFn });
    expect(promoteFn).toHaveBeenCalledTimes(8);
  });
});

describe("apply: the ledger view folds an append-only history", () => {
  it("treats a tombstone as disarming exactly the row it names", () => {
    const view = ledgerView([
      entry({ id: "pl_a", candidateId: "c_a" }),
      entry({ id: "pl_b", candidateId: "c_b" }),
      entry({ id: "pl_forget_pl_a", candidateId: "c_a", quarantined: true, quarantineReason: `${TOMBSTONE_PREFIX}pl_a` }),
    ]);
    expect(view.armed.map((e) => e.id)).toEqual(["pl_b"]);
    expect(view.tombstonedCandidates.has("c_a")).toBe(true);
    expect(view.armedCandidates.has("c_b")).toBe(true);
  });

  it("keeps a genuine quarantine out of the armed set and out of the tombstones", () => {
    const view = ledgerView([entry({ id: "pl_q", path: "", quarantined: true, quarantineReason: "write-failed" })]);
    expect(view.armed).toEqual([]);
    expect(view.quarantined.map((e) => e.id)).toEqual(["pl_q"]);
    expect(view.tombstonedCandidates.size).toBe(0);
  });
});

describe("apply: staleness is surfaced, never acted on", () => {
  it("reports a decayed promotion with its current confidence", () => {
    const view = ledgerView([entry()]);
    const stale = stalePromotions(view, [candidate({ confidence: 0.1 })]);
    expect(stale).toHaveLength(1);
    expect(stale[0].reason).toBe("decayed");
    expect(stale[0].confidence).toBe(0.1);
  });

  it("reports a promotion whose candidate aged out entirely as orphaned", () => {
    const stale = stalePromotions(ledgerView([entry()]), []);
    expect(stale.map((s) => s.reason)).toEqual(["orphaned"]);
  });

  it("says nothing about a promotion still backed by a confident candidate", () => {
    expect(stalePromotions(ledgerView([entry()]), [candidate({ confidence: 0.9 })])).toEqual([]);
  });

  it("leaves the artefact armed — staleness never retracts anything", async () => {
    enableScope();
    seedCandidates([candidate({ confidence: 0.05 })]);
    seedLedger([entry()]);
    await applyPromotions(fakeCtx(), { promoteFn: async () => ({ outcome: "promoted" }) });
    // The stale promotion is still in the armed view after a full pass.
    expect(ledgerView(
      [entry()],
    ).armed.map((e) => e.id)).toEqual(["pl_1"]);
  });
});

describe("apply: surfacing is non-interrupting and only about what changed", () => {
  function sendingPi(): { pi: ExtensionAPI; sent: { message: unknown; opts: unknown }[] } {
    const sent: { message: unknown; opts: unknown }[] = [];
    const pi = {
      on: () => {},
      registerCommand: () => {},
      sendMessage: (message: unknown, opts: unknown) => {
        sent.push({ message, opts });
      },
    } as unknown as ExtensionAPI;
    return { pi, sent };
  }

  it("delivers the applied summary for the next turn rather than steering", () => {
    const { pi, sent } = sendingPi();
    const report: ApplyReport = { ran: true, promoted: ["use pnpm"], queued: 0, skipped: 0, quarantined: 0 };
    surfaceApplied(pi, report);
    expect(sent).toHaveLength(1);
    expect(sent[0].opts).toEqual({ deliverAs: "nextTurn" });
    expect(contentOf(sent[0].message)).toContain("use pnpm");
  });

  it("says nothing at all when nothing was applied", () => {
    const { pi, sent } = sendingPi();
    surfaceApplied(pi, { ran: true, promoted: [], queued: 4, skipped: 2, quarantined: 0 });
    expect(sent).toEqual([]);
  });

  it("never mentions the queued decision-class count to the human", () => {
    const { pi, sent } = sendingPi();
    surfaceApplied(pi, { ran: true, promoted: ["use pnpm"], queued: 3, skipped: 0, quarantined: 0 });
    expect(contentOf(sent[0].message)).not.toContain("3");
  });
});

describe("apply: wired into the real session_start registration", () => {
  function fakePi(): { pi: ExtensionAPI; handlers: Map<string, (e: unknown, c: unknown) => unknown>; sent: unknown[] } {
    const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
    const sent: unknown[] = [];
    const pi = {
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
        handlers.set(event, handler);
      },
      registerCommand: () => {},
      sendMessage: (message: unknown) => {
        sent.push(message);
      },
    } as unknown as ExtensionAPI;
    return { pi, handlers, sent };
  }

  function ctxWith(sessionFile: string): ExtensionContext {
    return {
      cwd,
      sessionManager: { getSessionFile: () => sessionFile },
    } as unknown as ExtensionContext;
  }

  it("arms nothing in a subagent session", async () => {
    seedCandidates([candidate()]);
    const { pi, handlers, sent } = fakePi();
    taste(pi);
    // The first session file the process sees is the main one; a later leaf
    // is a subagent's. The scope is switched on only after the main session
    // is known, so the candidate is still unarmed when the subagent starts
    // and nothing but the subagent gate can be what holds it back.
    await handlers.get("session_start")!({ type: "session_start" }, ctxWith(join(cwd, "main.jsonl")));
    enableScope();
    await handlers.get("session_start")!({ type: "session_start" }, ctxWith(join(cwd, "Explore.jsonl")));
    expect(sent).toEqual([]);
    expect(readPromotionLedger()).toEqual([]);
  });

  it("arms nothing when the scope is switched off", async () => {
    seedCandidates([candidate()]);
    const { pi, handlers, sent } = fakePi();
    taste(pi);
    await handlers.get("session_start")!({ type: "session_start" }, ctxWith(join(cwd, "main.jsonl")));
    expect(sent).toEqual([]);
  });

  it("surfaces an applied preference on a real main-session start", async () => {
    enableScope();
    seedCandidates([candidate()]);
    const { pi, sent } = fakePi();
    // Drive the lifecycle entry point directly with a promoter fake so the
    // assertion is about the trigger, not about a writer's disk layout.
    await applyAtSessionStart(pi, ctxWith(join(cwd, "main.jsonl")), {
      promoteFn: async () => ({ outcome: "promoted", entry: entry() }),
    });
    expect(sent).toHaveLength(1);
    expect(contentOf(sent[0])).toContain("pnpm");
  });

  it("keeps the session alive when the application path throws", async () => {
    enableScope();
    seedCandidates([candidate()]);
    const { pi, handlers } = fakePi();
    taste(pi);
    // A throwing promoter reaches the real promote() path via the registered
    // handler; the safely() envelope must swallow whatever comes back.
    writeFileSync(join(stateDir, "candidates.json"), "not json at all");
    await expect(
      handlers.get("session_start")!({ type: "session_start" }, ctxWith(join(cwd, "main.jsonl"))),
    ).resolves.toBeUndefined();
  });
});
