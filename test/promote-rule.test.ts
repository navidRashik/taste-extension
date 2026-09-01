import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { __setTasteStateDir, rollupTouch, type RollupSignal } from "../src/rollup.js";
import { conditionForSubject, promote, readPromotionLedger } from "../src/promote.js";
import { defaultRuleWriter, type MemoryWriter, type RuleWriter, type SkillWriter } from "../src/writers.js";
import type { TtsrRunner } from "../src/ttsr.js";
import type { PreferenceCandidate, PreferenceClass } from "../src/schema.js";

let stateDir: string;
let cwd: string;
let home: string;
const prevHome = process.env.OMP_TASTE_HOME;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "taste-rulepromote-state-"));
  cwd = mkdtempSync(join(tmpdir(), "taste-rulepromote-cwd-"));
  home = mkdtempSync(join(tmpdir(), "taste-rulepromote-home-"));
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

function sig(id: string, subject: string, over: Partial<RollupSignal> = {}): RollupSignal {
  return {
    id, kind: "reject", strength: 2, subject,
    scopeHint: "project", repo: "git:acme/app", at: 1_700_000_000_000,
    ...over,
  };
}

function seed(subject: string, ...ids: string[]): void {
  for (const id of ids) rollupTouch(sig(id, subject));
}

function fakeCtx(): ExtensionContext { return { cwd } as unknown as ExtensionContext; }

function ruleCandidate(over: Partial<PreferenceCandidate> = {}): PreferenceCandidate {
  return {
    id: "pc_rule001",
    statement: "Use pnpm, not npm, for installs.",
    class: "implementer",
    target: "rule",
    confidence: 0.9,
    scope: "project",
    evidence: ["sig_1"],
    controls: { positive: "npm install recharts", negative: "pnpm add recharts" },
    ...over,
  };
}

/**
 * A TTSR runner that mirrors the real omp behaviour for the pnpm/npm family:
 * triggers on any command matching the derived regex (bash `npm install`),
 * silent on anything else. Backs every "happy path" test here without any
 * subprocess I/O.
 */
function twoSidedRunner(): TtsrRunner {
  return {
    test: (ruleFile, snippet) => {
      const body = readFileSync(ruleFile, "utf8");
      const m = body.match(/condition: (".*")/);
      if (!m) return false;
      const source: unknown = JSON.parse(m[1]);
      if (typeof source !== "string") return false;
      const rx = new RegExp(source);
      return rx.test(snippet);
    },
  };
}

function unusedSkillWriter(): SkillWriter { return { write: () => { throw new Error("skill writer must not be called"); } }; }
function unusedMemoryWriter(): MemoryWriter { return { write: async () => { throw new Error("memory writer must not be called"); } }; }

describe("promote: rule target — auto path arms only on implementer + irreversible-clean + two-sided pass", () => {
  it("promotes a well-formed implementer rule candidate and writes the .md into <cwd>/.omp/rules", async () => {
    seed("bash:npm install *", "sig_1");
    const result = await promote(ruleCandidate(), fakeCtx(), {
      skillWriter: unusedSkillWriter(),
      memoryWriter: unusedMemoryWriter(),
      ruleWriter: defaultRuleWriter,
      ttsr: twoSidedRunner(),
    });
    expect(result.outcome).toBe("promoted");
    expect(result.entry?.target).toBe("rule");
    expect(result.entry?.path.startsWith(join(cwd, ".omp", "rules"))).toBe(true);
    expect(existsSync(result.entry!.path)).toBe(true);
    const body = readFileSync(result.entry!.path, "utf8");
    expect(body).toContain("interruptMode: tool-only");
    expect(body).toContain("condition: ");
  });

  const decisionClasses: PreferenceClass[] = ["scope", "behaviour", "commitment"];
  for (const cls of decisionClasses) {
    it(`refuses to auto-arm a ${cls}-class rule (class filter, no rule file left on disk)`, async () => {
      seed("bash:npm install *", "sig_1");
      const written: string[] = [];
      const writer: RuleWriter = { write: (c, cw, cond) => { const p = defaultRuleWriter.write(c, cw, cond); written.push(p); return p; } };
      const result = await promote(ruleCandidate({ class: cls }), fakeCtx(), {
        skillWriter: unusedSkillWriter(),
        memoryWriter: unusedMemoryWriter(),
        ruleWriter: writer,
        ttsr: twoSidedRunner(),
      });
      expect(result.outcome).toBe("queued");
      expect(result.reason).toBe(`decision-class:${cls}`);
      // The rule writer must never even be reached — the class filter
      // gates before any file is created.
      expect(written).toHaveLength(0);
      expect(readPromotionLedger()).toHaveLength(0);
    });
  }

  it("refuses to auto-arm a rule whose subject is on the irreversible-action denylist even when the model labelled it implementer", async () => {
    seed("bash:git push *", "sig_1");
    const written: string[] = [];
    const writer: RuleWriter = { write: (c, cw, cond) => { const p = defaultRuleWriter.write(c, cw, cond); written.push(p); return p; } };
    const result = await promote(
      ruleCandidate({ controls: { positive: "git push origin main", negative: "git status" } }),
      fakeCtx(),
      {
        skillWriter: unusedSkillWriter(),
        memoryWriter: unusedMemoryWriter(),
        ruleWriter: writer,
        ttsr: twoSidedRunner(),
      },
    );
    expect(result.outcome).toBe("queued");
    expect(result.reason).toBe("irreversible-family:bash:git push");
    expect(written).toHaveLength(0);
  });
});

describe("promote: rule target — two-sided negative control gates arming", () => {
  it("quarantines when the positive control does NOT trigger (rule broken, not a guard)", async () => {
    seed("bash:npm install *", "sig_1");
    // A runner that never fires; the positive check must fail closed.
    const silent: TtsrRunner = { test: () => false };
    const stagedPaths: string[] = [];
    const writer: RuleWriter = { write: (c, cw, cond) => { const p = defaultRuleWriter.write(c, cw, cond); stagedPaths.push(p); return p; } };
    const result = await promote(ruleCandidate(), fakeCtx(), {
      skillWriter: unusedSkillWriter(),
      memoryWriter: unusedMemoryWriter(),
      ruleWriter: writer,
      ttsr: silent,
    });
    expect(result.outcome).toBe("quarantined");
    expect(result.reason).toBe("taste rule: positive control did not trigger");
    // The staged file must be cleaned up so session_start never loads a
    // failed-control rule.
    expect(stagedPaths).toHaveLength(1);
    expect(existsSync(stagedPaths[0])).toBe(false);
    const ledger = readPromotionLedger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].quarantined).toBe(true);
  });

  it("quarantines when the negative control DOES fire on a benign same-family snippet", async () => {
    seed("bash:npm install *", "sig_1");
    // A runner that fires on everything — the negative check must catch this.
    const chatter: TtsrRunner = { test: () => true };
    const stagedPaths: string[] = [];
    const writer: RuleWriter = { write: (c, cw, cond) => { const p = defaultRuleWriter.write(c, cw, cond); stagedPaths.push(p); return p; } };
    const result = await promote(ruleCandidate(), fakeCtx(), {
      skillWriter: unusedSkillWriter(),
      memoryWriter: unusedMemoryWriter(),
      ruleWriter: writer,
      ttsr: chatter,
    });
    expect(result.outcome).toBe("quarantined");
    expect(result.reason).toBe("taste rule: negative control fired on benign snippet");
    expect(existsSync(stagedPaths[0])).toBe(false);
    expect(readPromotionLedger()[0].quarantined).toBe(true);
  });

  it("quarantines when the candidate carries no controls at all — never armed on a positive-only proof", async () => {
    seed("bash:npm install *", "sig_1");
    const called = { runner: 0, writer: 0 };
    const runner: TtsrRunner = { test: () => { called.runner += 1; return true; } };
    const writer: RuleWriter = { write: () => { called.writer += 1; return "/tmp/never"; } };
    const result = await promote(
      ruleCandidate({ controls: undefined }),
      fakeCtx(),
      {
        skillWriter: unusedSkillWriter(),
        memoryWriter: unusedMemoryWriter(),
        ruleWriter: writer,
        ttsr: runner,
      },
    );
    expect(result.outcome).toBe("quarantined");
    expect(result.reason).toBe("taste rule: missing two-sided controls");
    expect(called.writer).toBe(0);
    expect(called.runner).toBe(0);
    expect(readPromotionLedger()[0].quarantined).toBe(true);
  });

  it("quarantines when only the negative side is supplied (partial-control refusal)", async () => {
    seed("bash:npm install *", "sig_1");
    const runner: TtsrRunner = { test: () => true };
    const writer: RuleWriter = { write: () => { throw new Error("must not reach writer"); } };
    const result = await promote(
      ruleCandidate({ controls: { positive: "", negative: "pnpm add recharts" } }),
      fakeCtx(),
      { skillWriter: unusedSkillWriter(), memoryWriter: unusedMemoryWriter(), ruleWriter: writer, ttsr: runner },
    );
    expect(result.outcome).toBe("quarantined");
    expect(result.reason).toBe("taste rule: missing two-sided controls");
  });
});

describe("promote: rule target — the two-sided control gates the human-approved path exactly like the auto path", () => {
  it("arms a rule a human approved when both controls pass", async () => {
    seed("bash:npm install *", "sig_1");
    // A commitment-class rule the auto path would refuse, approved by hand.
    const result = await promote(
      ruleCandidate({ class: "commitment" }),
      fakeCtx(),
      { ruleWriter: defaultRuleWriter, ttsr: twoSidedRunner(), approvedBy: "user:navid" },
    );
    expect(result.outcome).toBe("promoted");
    expect(result.entry?.approvedBy).toBe("user:navid");
  });

  it("still quarantines an approved rule whose negative control fires — approval does not weaken safety", async () => {
    seed("bash:npm install *", "sig_1");
    const chatter: TtsrRunner = { test: () => true };
    const result = await promote(
      ruleCandidate({ class: "commitment" }),
      fakeCtx(),
      { ruleWriter: defaultRuleWriter, ttsr: chatter, approvedBy: "user:navid" },
    );
    expect(result.outcome).toBe("quarantined");
    expect(result.reason).toBe("taste rule: negative control fired on benign snippet");
  });
});

describe("promote: rule target — writer receives the derived condition, not raw prose", () => {
  it("hands the writer a condition regex derived from the subject family, never from the statement", async () => {
    seed("bash:npm install *", "sig_1");
    const spy = vi.fn().mockReturnValue("/tmp/fake-rule.md");
    const writer: RuleWriter = { write: spy };
    await promote(ruleCandidate(), fakeCtx(), {
      skillWriter: unusedSkillWriter(),
      memoryWriter: unusedMemoryWriter(),
      ruleWriter: writer,
      ttsr: { test: () => spy.mock.calls.length > 0 && spy.mock.calls[0][2] === "\\bnpm install\\b" },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][2]).toBe("\\bnpm install\\b");
  });
});

describe("conditionForSubject: bounded family-space derivation", () => {
  it("emits an anchored \\b-wrapped head for a bash argv+subcommand subject", () => {
    expect(conditionForSubject("bash:npm install *")).toBe("\\bnpm install\\b");
    expect(conditionForSubject("bash:git push *")).toBe("\\bgit push\\b");
  });

  it("emits an anchored \\b-wrapped head for a single-token bash subject", () => {
    expect(conditionForSubject("bash:rm *")).toBe("\\brm\\b");
  });

  it("throws on any tool other than bash — the writer never guesses a rule shape it did not verify", () => {
    expect(() => conditionForSubject("write:*.ts:jest")).toThrow(/unsupported subject shape/);
    expect(() => conditionForSubject("edit:*.py:def")).toThrow(/unsupported subject shape/);
  });

  it("throws on a subject head that carries shell metacharacters — the regex builder never welds unsafe bytes in", () => {
    expect(() => conditionForSubject("bash:$(rm -rf /) *")).toThrow(/unsafe characters/);
    expect(() => conditionForSubject("bash:foo;bar *")).toThrow(/unsafe characters/);
  });

  it("throws on an empty subject head (fingerprint resolution missed)", () => {
    expect(() => conditionForSubject("bash: *")).toThrow(/empty subject head/);
  });
});
