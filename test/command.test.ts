import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { __setTasteStateDir, rollupTouch } from "../src/rollup.js";
import { clearTasteConfigCache, resolveTasteConfig } from "../src/config.js";
import { readPromotionLedger } from "../src/promote.js";
import { TOMBSTONE_PREFIX } from "../src/apply.js";
import { parseTasteArgs, registerTasteCommand, runTasteCommand, tasteSettingsFile, type CommandDeps } from "../src/command.js";
import type { PreferenceCandidate, PromotionLedgerEntry } from "../src/schema.js";

let stateDir: string;
let cwd: string;
const prevHome = process.env.OMP_TASTE_HOME;

const DEPS: CommandDeps = {
  health: () => ({ errors: 0, recent: [] }),
  isSubagent: () => false,
  record: () => {},
};

function fakeCtx(): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

function candidate(over: Partial<PreferenceCandidate> = {}): PreferenceCandidate {
  return {
    id: "cand_1",
    statement: "this repo uses pnpm",
    class: "implementer",
    target: "skill",
    confidence: 0.9,
    scope: "project",
    evidence: ["sig_1"],
    ...over,
  };
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

function seedCandidates(cands: PreferenceCandidate[]): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "candidates.json"), JSON.stringify(cands));
}

function seedLedger(entries: PromotionLedgerEntry[]): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "promotion-ledger.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function put(path: string, body: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function enableScope(over: Record<string, unknown> = {}): void {
  const dir = join(cwd, ".omp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ taste: { enabled: true, autoPromote: true, ...over } }));
  clearTasteConfigCache();
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "taste-cmd-state-"));
  cwd = mkdtempSync(join(tmpdir(), "taste-cmd-cwd-"));
  __setTasteStateDir(stateDir);
  process.env.OMP_TASTE_HOME = mkdtempSync(join(tmpdir(), "taste-cmd-home-"));
  clearTasteConfigCache();
});

afterEach(() => {
  __setTasteStateDir(null);
  if (prevHome === undefined) delete process.env.OMP_TASTE_HOME;
  else process.env.OMP_TASTE_HOME = prevHome;
  clearTasteConfigCache();
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* temp dir */ }
  try { rmSync(cwd, { recursive: true, force: true }); } catch { /* temp dir */ }
});

describe("/taste: the argument surface", () => {
  it("treats a bare invocation as status", () => {
    expect(parseTasteArgs("").sub).toBe("status");
    expect(parseTasteArgs("   ").sub).toBe("status");
  });

  it("reads a subcommand and its positional argument", () => {
    const parsed = parseTasteArgs("forget pl_1");
    expect(parsed.sub).toBe("forget");
    expect(parsed.positional).toEqual(["pl_1"]);
  });

  it("reads --all and both --scope spellings", () => {
    expect(parseTasteArgs("forget --all").all).toBe(true);
    expect(parseTasteArgs("forget --all --scope user").scope).toBe("user");
    expect(parseTasteArgs("forget --all --scope=project").scope).toBe("project");
  });

  it("ignores a scope that is not a real scope", () => {
    expect(parseTasteArgs("forget --all --scope everything").scope).toBeUndefined();
  });

  it("has no publish or fetch verb — a project promotion is published by its own commit", async () => {
    for (const verb of ["push", "pull", "sync"]) {
      const lines = await runTasteCommand(verb, fakeCtx(), DEPS);
      expect(lines.join("\n")).toContain("unknown subcommand");
    }
  });
});

describe("/taste status", () => {
  it("names the reason the learner is silent when the scope is off", async () => {
    const lines = await runTasteCommand("", fakeCtx(), DEPS);
    expect(lines[0]).toContain("learning off");
    expect(lines.join("\n")).toContain("/taste enable");
  });

  it("names a subagent session as the reason for silence", async () => {
    enableScope();
    const lines = await runTasteCommand("", fakeCtx(), { ...DEPS, isSubagent: () => true });
    expect(lines.join("\n")).toContain("subagent session");
  });

  it("counts what is armed, queued, and quarantined", async () => {
    enableScope();
    seedCandidates([candidate({ id: "c1" }), candidate({ id: "c2", class: "behaviour" })]);
    seedLedger([entry(), entry({ id: "pl_q", path: "", quarantined: true, quarantineReason: "write-failed" })]);
    const lines = await runTasteCommand("status", fakeCtx(), DEPS);
    expect(lines[1]).toContain("armed 1");
    expect(lines[1]).toContain("review queue 1");
    expect(lines[1]).toContain("quarantined 1");
  });

  it("surfaces a decayed promotion with the reversal that fixes it", async () => {
    enableScope();
    seedCandidates([candidate({ confidence: 0.05 })]);
    seedLedger([entry()]);
    const lines = await runTasteCommand("status", fakeCtx(), DEPS);
    const stale = lines.find((l) => l.startsWith("stale:"));
    expect(stale).toContain("pl_1");
    expect(stale).toContain("/taste forget pl_1");
  });

  it("surfaces an orphaned promotion whose candidate aged out", async () => {
    enableScope();
    seedLedger([entry()]);
    const lines = await runTasteCommand("status", fakeCtx(), DEPS);
    expect(lines.find((l) => l.startsWith("stale:"))).toContain("evidence is gone");
  });

  it("reports handler errors so a silently-failing learner stays visible", async () => {
    const lines = await runTasteCommand("", fakeCtx(), {
      ...DEPS,
      health: () => ({ errors: 3, recent: [{ timestamp: 1, handler: "on:input", errorClass: "TypeError" }] }),
    });
    const health = lines.find((l) => l.startsWith("health:"));
    expect(health).toContain("3 handler error");
    expect(health).toContain("on:input");
  });
});

describe("/taste enable and disable", () => {
  it("writes the project opt-in to the local-override layer", async () => {
    const lines = await runTasteCommand("enable", fakeCtx(), DEPS);
    const file = tasteSettingsFile(cwd, "project");
    expect(file).toBe(join(cwd, ".omp", "settings.local.json"));
    expect(existsSync(file)).toBe(true);
    expect(resolveTasteConfig(cwd).enabled).toBe(true);
    expect(lines[0]).toContain("enabled");
  });

  it("writes the user opt-in to the user layer", async () => {
    await runTasteCommand("enable --user", fakeCtx(), DEPS);
    expect(existsSync(tasteSettingsFile(cwd, "user"))).toBe(true);
    expect(existsSync(join(cwd, ".omp", "settings.local.json"))).toBe(false);
  });

  it("switches the scope back off again", async () => {
    await runTasteCommand("enable", fakeCtx(), DEPS);
    await runTasteCommand("disable", fakeCtx(), DEPS);
    expect(resolveTasteConfig(cwd).enabled).toBe(false);
  });

  it("opts into automatic application when switched on, and only then", async () => {
    await runTasteCommand("enable", fakeCtx(), DEPS);
    expect(resolveTasteConfig(cwd).autoPromote).toBe(true);
    await runTasteCommand("disable", fakeCtx(), DEPS);
    expect(resolveTasteConfig(cwd).enabled).toBe(false);
  });

  it("keeps every unrelated setting in the file", async () => {
    const file = put(join(cwd, ".omp", "settings.local.json"), JSON.stringify({ model: "smol", taste: { scope: "user" } }));
    await runTasteCommand("enable", fakeCtx(), DEPS);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    expect(doc.model).toBe("smol");
    expect(doc.taste.scope).toBe("user");
    expect(doc.taste.enabled).toBe(true);
  });

  it("refuses to clobber a settings file it cannot parse", async () => {
    const file = put(join(cwd, ".omp", "settings.local.json"), "{ not json");
    const lines = await runTasteCommand("enable", fakeCtx(), DEPS);
    expect(lines.join("\n")).toContain("not valid JSON");
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("says so when a higher-precedence layer still overrides the toggle", async () => {
    put(join(cwd, ".omp", "settings.local.json"), JSON.stringify({ taste: { enabled: false } }));
    clearTasteConfigCache();
    const lines = await runTasteCommand("enable --scope user", fakeCtx(), DEPS);
    expect(lines.join("\n")).toContain("higher-precedence");
  });
});

describe("/taste review", () => {
  it("is the only place a decision-class candidate is ever shown", async () => {
    enableScope();
    seedCandidates([candidate({ id: "c_dec", class: "commitment", statement: "never push without asking" })]);
    const review = await runTasteCommand("review", fakeCtx(), DEPS);
    expect(review.join("\n")).toContain("never push without asking");
    expect(review.join("\n")).toContain("/taste promote c_dec");
    // The status panel counts it without quoting it.
    const status = await runTasteCommand("status", fakeCtx(), DEPS);
    expect(status.join("\n")).not.toContain("never push without asking");
  });

  it("queues an implementer-labelled candidate the irreversible pre-filter caught", async () => {
    enableScope();
    rollupTouch({
      id: "sig_rm",
      kind: "reject",
      strength: 2,
      subject: "bash:rm *",
      scopeHint: "project",
      repo: "git:acme/app",
      at: 1_700_000_000_000,
    });
    seedCandidates([candidate({ id: "c_rm", class: "implementer", evidence: ["sig_rm"] })]);
    const lines = await runTasteCommand("review", fakeCtx(), DEPS);
    expect(lines.join("\n")).toContain("irreversible family");
    expect(lines.join("\n")).toContain("c_rm");
  });

  it("lists quarantined promotions with the gate that refused them", async () => {
    seedLedger([entry({ id: "pl_q", path: "", quarantined: true, quarantineReason: "positive control did not trigger" })]);
    const lines = await runTasteCommand("review", fakeCtx(), DEPS);
    expect(lines.join("\n")).toContain("positive control did not trigger");
  });

  it("says the queue is empty rather than printing nothing", async () => {
    const lines = await runTasteCommand("review", fakeCtx(), DEPS);
    expect(lines.join("\n")).toContain("empty");
  });
});

describe("/taste promote — the human-approval path", () => {
  it("records the approver in the ledger", async () => {
    enableScope();
    seedCandidates([candidate({ id: "c_dec", class: "commitment", target: "skill" })]);
    const lines = await runTasteCommand("promote c_dec", fakeCtx(), DEPS);
    const rows = readPromotionLedger();
    expect(rows).toHaveLength(1);
    expect(rows[0].approvedBy).toMatch(/^human:/);
    expect(rows[0].candidateId).toBe("c_dec");
    expect(lines.join("\n")).toContain("approved by human:");
  });

  it("hands the approval token to the promoter rather than promoting silently", async () => {
    enableScope();
    seedCandidates([candidate({ id: "c_dec", class: "scope" })]);
    const seen: string[] = [];
    await runTasteCommand("promote c_dec", fakeCtx(), {
      ...DEPS,
      promoteFn: async (_c, _ctx, approvedBy) => {
        seen.push(approvedBy);
        return { outcome: "promoted", entry: entry() };
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^human:/);
  });

  it("reports a candidate id that does not exist", async () => {
    const lines = await runTasteCommand("promote nope", fakeCtx(), DEPS);
    expect(lines.join("\n")).toContain("no candidate with id nope");
  });

  it("asks for an id rather than promoting something arbitrary", async () => {
    seedCandidates([candidate()]);
    const lines = await runTasteCommand("promote", fakeCtx(), DEPS);
    expect(lines.join("\n")).toContain("usage:");
    expect(readPromotionLedger()).toEqual([]);
  });

  it("reports a refusal without claiming the preference was armed", async () => {
    seedCandidates([candidate({ id: "c1" })]);
    const lines = await runTasteCommand("promote c1", fakeCtx(), {
      ...DEPS,
      promoteFn: async () => ({ outcome: "quarantined", reason: "round-trip mismatch" }),
    });
    expect(lines.join("\n")).toContain("was not promoted");
    expect(lines.join("\n")).toContain("round-trip mismatch");
  });
});

describe("/taste forget", () => {
  it("reverses one promotion by id and takes the artefact off disk", async () => {
    const file = put(entry().path, "# managed skill\n");
    seedLedger([entry()]);
    const lines = await runTasteCommand("forget pl_1", fakeCtx(), DEPS);
    expect(existsSync(file)).toBe(false);
    expect(lines[0]).toContain("1 of 1");
    expect(readPromotionLedger().some((r) => r.quarantineReason === `${TOMBSTONE_PREFIX}pl_1`)).toBe(true);
  });

  it("accepts the candidate id as well as the ledger id", async () => {
    const file = put(entry().path, "# managed skill\n");
    seedLedger([entry()]);
    await runTasteCommand("forget cand_1", fakeCtx(), DEPS);
    expect(existsSync(file)).toBe(false);
  });

  it("reverses everything armed with --all", async () => {
    const a = put(join(cwd, ".omp", "rules", "a.md"), "a\n");
    const b = put(join(cwd, ".omp", "rules", "b.md"), "b\n");
    seedLedger([
      entry({ id: "pl_a", candidateId: "c_a", target: "rule", path: a }),
      entry({ id: "pl_b", candidateId: "c_b", target: "rule", path: b }),
    ]);
    const lines = await runTasteCommand("forget --all", fakeCtx(), DEPS);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(lines[0]).toContain("2 of 2");
  });

  it("narrows --all to one scope and leaves the other armed", async () => {
    const project = put(join(cwd, ".omp", "rules", "a.md"), "a\n");
    const user = put(join(process.env.OMP_TASTE_HOME ?? "", ".omp", "agent", "rules", "b.md"), "b\n");
    seedLedger([
      entry({ id: "pl_a", candidateId: "c_a", target: "rule", path: project }),
      entry({ id: "pl_b", candidateId: "c_b", target: "rule", scope: "user", path: user }),
    ]);
    await runTasteCommand("forget --all --scope user", fakeCtx(), DEPS);
    expect(existsSync(project)).toBe(true);
    expect(existsSync(user)).toBe(false);
  });

  it("refuses a bare forget rather than guessing what to reverse", async () => {
    const file = put(entry().path, "# managed skill\n");
    seedLedger([entry()]);
    const lines = await runTasteCommand("forget", fakeCtx(), DEPS);
    expect(lines.join("\n")).toContain("usage:");
    expect(existsSync(file)).toBe(true);
  });

  it("reports an id that is not armed", async () => {
    const lines = await runTasteCommand("forget pl_nope", fakeCtx(), DEPS);
    expect(lines.join("\n")).toContain("nothing armed with id");
  });

  it("never reverses a promotion twice", async () => {
    put(entry().path, "# managed skill\n");
    seedLedger([entry()]);
    await runTasteCommand("forget pl_1", fakeCtx(), DEPS);
    const second = await runTasteCommand("forget pl_1", fakeCtx(), DEPS);
    expect(second.join("\n")).toContain("nothing armed with id");
  });
});

describe("/taste: registration and the fail-open envelope", () => {
  function fakePi(): {
    pi: ExtensionAPI;
    registered: { name: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }[];
    sent: { message: unknown; opts: unknown }[];
  } {
    const registered: { name: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }[] = [];
    const sent: { message: unknown; opts: unknown }[] = [];
    const pi = {
      on: () => {},
      registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
        registered.push({ name, handler: options.handler });
      },
      sendMessage: (message: unknown, opts: unknown) => {
        sent.push({ message, opts });
      },
    } as unknown as ExtensionAPI;
    return { pi, registered, sent };
  }

  it("registers exactly one command, named taste", () => {
    const { pi, registered } = fakePi();
    registerTasteCommand(pi, DEPS);
    expect(registered.map((r) => r.name)).toEqual(["taste"]);
  });

  it("delivers the panel for the next turn rather than steering the agent", async () => {
    const { pi, registered, sent } = fakePi();
    registerTasteCommand(pi, DEPS);
    await registered[0].handler("", fakeCtx());
    expect(sent).toHaveLength(1);
    expect(sent[0].opts).toEqual({ deliverAs: "nextTurn" });
  });

  it("records an unexpected fault instead of breaking the session", async () => {
    const { pi, registered, sent } = fakePi();
    const record = vi.fn();
    registerTasteCommand(pi, { ...DEPS, record, health: () => { throw new Error("health exploded"); } });
    await expect(registered[0].handler("", fakeCtx())).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });
});
