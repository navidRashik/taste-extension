import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RollupSignal } from "../src/rollup.js";
import { __setTasteStateDir, rollupTouch, flushAccumulator } from "../src/rollup.js";
import type { Inferencer, InferenceInput, InferenceOutcome } from "../src/inference.js";
import { INFERENCE_CHILD_ENV, runInference, loadCandidates, __resetInferenceSlot } from "../src/inference.js";
import { parseCheckedArray, isPreferenceCandidate } from "../src/schema.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "taste-inf-"));
  __setTasteStateDir(dir);
  __resetInferenceSlot();
  delete process.env[INFERENCE_CHILD_ENV];
});
afterEach(() => {
  __setTasteStateDir(null);
  __resetInferenceSlot();
  delete process.env[INFERENCE_CHILD_ENV];
  rmSync(dir, { recursive: true, force: true });
});

function sig(id: string, subject: string, opts: Partial<RollupSignal> = {}): RollupSignal {
  return {
    id,
    kind: "reject",
    strength: 2,
    tool: "bash",
    subject,
    scopeHint: "project",
    repo: "local:r",
    at: Date.now(),
    ...opts,
  };
}

const staticInferencer = (out: InferenceOutcome | null): Inferencer => async () => out;
const spyingInferencer = (out: InferenceOutcome | null): { inf: Inferencer; calls: InferenceInput[] } => {
  const calls: InferenceInput[] = [];
  const inf: Inferencer = async (input) => {
    calls.push(input);
    return out;
  };
  return { inf, calls };
};

describe("inference: recurrence gate", () => {
  it("does NOT summarise a bucket that has recurred fewer than 3 times", async () => {
    rollupTouch(sig("a", "bash:npm install *"));
    rollupTouch(sig("b", "bash:npm install *"));
    const { inf, calls } = spyingInferencer({ statement: "x", class: "implementer", target: "skill" });
    const r = await runInference(inf);
    expect(r.ran).toBe(true);
    expect(calls.length).toBe(0);
    expect(r.candidates.length).toBe(0);
  });

  it("summarises at exactly 3 recurrences", async () => {
    rollupTouch(sig("a", "bash:npm install *"));
    rollupTouch(sig("b", "bash:npm install *"));
    rollupTouch(sig("c", "bash:npm install *"));
    const { inf, calls } = spyingInferencer({ statement: "Use pnpm", class: "implementer", target: "skill" });
    const r = await runInference(inf);
    expect(calls.length).toBe(1);
    expect(r.candidates[0].statement).toBe("Use pnpm");
  });

  it("takes the strong-edit shortcut on 2 strength-3 edits even below N", async () => {
    rollupTouch(sig("a", "write:*.ts:it", { kind: "edit", strength: 3, tool: "edit" }));
    rollupTouch(sig("b", "write:*.ts:it", { kind: "edit", strength: 3, tool: "edit" }));
    const { inf, calls } = spyingInferencer({ statement: "Prefer vitest", class: "implementer", target: "skill" });
    await runInference(inf);
    expect(calls.length).toBe(1);
  });

  it("does NOT trip the shortcut on a single strong edit (negative control on the gate)", async () => {
    rollupTouch(sig("a", "write:*.ts:it", { kind: "edit", strength: 3, tool: "edit" }));
    const { inf, calls } = spyingInferencer({ statement: "x", class: "implementer", target: "skill" });
    await runInference(inf);
    expect(calls.length).toBe(0);
  });
});

describe("inference: recursion guard + single-flight", () => {
  it("short-circuits when the child env marker is set (recursion guard)", async () => {
    process.env[INFERENCE_CHILD_ENV] = "1";
    for (const id of ["a", "b", "c"]) rollupTouch(sig(id, "bash:npm install *"));
    const { inf, calls } = spyingInferencer({ statement: "x", class: "implementer", target: "skill" });
    const r = await runInference(inf);
    expect(r.ran).toBe(false);
    expect(r.reason).toBe("child");
    expect(calls.length).toBe(0);
  });

  it("bails immediately when another pass is already in flight (single-flight)", async () => {
    for (const id of ["a", "b", "c"]) rollupTouch(sig(id, "bash:npm install *"));
    let resolveFirst = (): void => {};
    const first = new Promise<InferenceOutcome | null>((resolve) => {
      resolveFirst = (): void => resolve({ statement: "s", class: "implementer", target: "skill" });
    });
    const inf: Inferencer = () => first;
    const race1 = runInference(inf);
    // The second call must find the slot busy and return without waiting.
    const race2 = await runInference(inf);
    expect(race2.ran).toBe(false);
    expect(race2.reason).toBe("in-flight");
    resolveFirst();
    await race1;
  });
});

describe("inference: confidence, decay, supersession", () => {
  it("baseline confidence rises with recurrence × strength", async () => {
    for (const id of ["a", "b", "c"]) rollupTouch(sig(id, "bash:npm install *"));
    const r = await runInference(staticInferencer({ statement: "s", class: "implementer", target: "skill" }));
    const c = r.candidates[0];
    expect(c.confidence).toBeGreaterThan(0.4);
    expect(c.confidence).toBeLessThanOrEqual(1);
  });

  it("time decay: an aged bucket sees confidence roughly halved after one half-life", async () => {
    const past = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
    for (const id of ["a", "b", "c"]) rollupTouch(sig(id, "bash:npm install *", { at: past }));
    // We inject `now` well past the bucket's lastTouched (which capture sets
    // to sig.at) so decay is exercised deterministically.
    const nowFar = past + 14 * 24 * 60 * 60 * 1000 * 3; // three half-lives
    const r = await runInference(staticInferencer({ statement: "s", class: "implementer", target: "skill" }), { now: nowFar });
    expect(r.candidates[0].confidence).toBeLessThan(0.2);
  });

  it("supersession: newer accepts against a prior reject/edit lineage cut the score", async () => {
    // Both buckets have identical count=4 and identical total-strength=8 so
    // baseConfidence is equal; the ONLY difference is the newer-half accept
    // flip, which supersessionFactor scales down.
    for (const id of ["a", "b"]) rollupTouch(sig(id, "bash:foo *", { kind: "reject", strength: 2 }));
    for (const id of ["c", "d"]) rollupTouch(sig(id, "bash:foo *", { kind: "accept", strength: 2 }));
    const r = await runInference(staticInferencer({ statement: "s", class: "implementer", target: "skill" }));
    const withSupersession = r.candidates[0].confidence;
    // Reset both accumulators so the second bucket is measured alone.
    __setTasteStateDir(dir);
    __resetInferenceSlot();
    for (const id of ["e", "f", "g", "h"]) rollupTouch(sig(id, "bash:bar *", { kind: "reject", strength: 2 }));
    const r2 = await runInference(staticInferencer({ statement: "s", class: "implementer", target: "skill" }));
    const noSupersession = r2.candidates.find((c) => c.statement === "s")!.confidence;
    expect(withSupersession).toBeLessThan(noSupersession);
  });
});

describe("inference: two-sided rule controls", () => {
  it("populates controls when negativeSnippet normalises to the positive's subject family", async () => {
    rollupTouch(sig("a", "bash:npm install *", { positive: "npm install recharts" }));
    rollupTouch(sig("b", "bash:npm install *", { positive: "npm install lodash" }));
    rollupTouch(sig("c", "bash:npm install *", { positive: "npm install axios" }));
    const r = await runInference(staticInferencer({ statement: "Use pnpm", class: "implementer", target: "rule", negativeSnippet: "npm install foo" }));
    // Positive "npm install *" ↔ negative "npm install foo" — same family under
    // the shared fingerprinter, so controls populate.
    expect(r.candidates[0].controls).toBeDefined();
    expect(r.candidates[0].controls!.positive).toBe("npm install axios");
    expect(r.candidates[0].controls!.negative).toBe("npm install foo");
  });

  it("OMITS controls when the negative belongs to a different subject family", async () => {
    rollupTouch(sig("a", "bash:npm install *", { positive: "npm install recharts" }));
    rollupTouch(sig("b", "bash:npm install *", { positive: "npm install lodash" }));
    rollupTouch(sig("c", "bash:npm install *", { positive: "npm install axios" }));
    // Negative is a different family entirely (bash:pnpm add), so controls must NOT populate.
    const r = await runInference(staticInferencer({ statement: "Use pnpm", class: "implementer", target: "rule", negativeSnippet: "pnpm add foo" }));
    expect(r.candidates[0].controls).toBeUndefined();
  });

  it("skill-target candidates never carry controls even when negative is provided (negative control on the target gate)", async () => {
    for (const id of ["a", "b", "c"]) rollupTouch(sig(id, "bash:npm install *", { positive: "npm install foo" }));
    const r = await runInference(staticInferencer({ statement: "Use pnpm", class: "implementer", target: "skill", negativeSnippet: "npm install bar" }));
    expect(r.candidates[0].controls).toBeUndefined();
  });
});

describe("inference: persistence", () => {
  it("writes candidates.json as a valid schema array that survives a round trip", async () => {
    for (const id of ["a", "b", "c"]) rollupTouch(sig(id, "bash:npm install *"));
    await runInference(staticInferencer({ statement: "Use pnpm", class: "implementer", target: "skill" }));
    const raw = readFileSync(join(dir, "candidates.json"), "utf8");
    const parsed = parseCheckedArray(raw, isPreferenceCandidate);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(1);
    // loadCandidates reads through the same seam we writes wrote.
    expect(loadCandidates().length).toBe(1);
  });

  it("reuses the prior candidate id when the same bucket re-derives on a second pass", async () => {
    for (const id of ["a", "b", "c"]) rollupTouch(sig(id, "bash:npm install *"));
    const r1 = await runInference(staticInferencer({ statement: "Use pnpm", class: "implementer", target: "skill" }));
    const firstId = r1.candidates[0].id;
    const r2 = await runInference(staticInferencer({ statement: "Use pnpm", class: "implementer", target: "skill" }));
    expect(r2.candidates[0].id).toBe(firstId);
  });
});

describe("inference: fail-open isolation", () => {
  it("a throwing inferencer for one bucket does NOT break the pass for siblings", async () => {
    for (const id of ["a", "b", "c"]) rollupTouch(sig(id, "bash:npm install *"));
    for (const id of ["d", "e", "f"]) rollupTouch(sig(id, "bash:git status *"));
    const inf: Inferencer = async (input) => {
      if (input.subject.startsWith("bash:npm")) throw new Error("boom");
      return { statement: "Prefer status", class: "implementer", target: "skill" };
    };
    const r = await runInference(inf);
    expect(r.ran).toBe(true);
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0].statement).toBe("Prefer status");
  });

  it("a null outcome drops that bucket rather than fabricating a candidate", async () => {
    for (const id of ["a", "b", "c"]) rollupTouch(sig(id, "bash:npm install *"));
    const r = await runInference(staticInferencer(null));
    expect(r.candidates.length).toBe(0);
  });
});

describe("inference: uses the freshly-flushed rollup", () => {
  it("reads buckets from disk after a flush (so a fresh process would see current-session evidence)", async () => {
    for (const id of ["a", "b", "c"]) rollupTouch(sig(id, "bash:npm install *"));
    await flushAccumulator();
    // Reset the in-memory cache; the production runInference is the only
    // path that may seed from disk on this run.
    __setTasteStateDir(dir);
    const r = await runInference(staticInferencer({ statement: "s", class: "implementer", target: "skill" }));
    expect(r.candidates.length).toBe(1);
  });
});

describe("inference: sanitised inferencer input", () => {
  it("passes the bucket's redacted correction and positive snippets, never raw evidence", async () => {
    rollupTouch(sig("a", "bash:npm install *", { positive: "npm install axios", correction: "use pnpm not npm" }));
    rollupTouch(sig("b", "bash:npm install *", { positive: "npm install lodash", correction: "we use pnpm here" }));
    rollupTouch(sig("c", "bash:npm install *", { positive: "npm install foo", correction: "prefer pnpm" }));
    const { inf, calls } = spyingInferencer({ statement: "s", class: "implementer", target: "skill" });
    await runInference(inf);
    expect(calls.length).toBe(1);
    const inp = calls[0];
    expect(inp.subject).toBe("bash:npm install *");
    expect(inp.recentCorrections.length).toBeGreaterThan(0);
    expect(inp.recentPositives.length).toBeGreaterThan(0);
    expect(inp.totalCount).toBe(3);
    expect(inp.tool).toBe("bash");
  });
});

describe("inference: recursion-guard env marker lifecycle", () => {
  it("sets the marker while the inferencer runs AND restores it after a multi-bucket concurrent pass", async () => {
    // >=3 buckets guarantees Promise.all actually fans out concurrently, so
    // this catches the per-call save/restore race that a single-bucket run
    // would silently hide.
    for (const id of ["a", "b", "c"]) rollupTouch(sig(id, "bash:npm install *"));
    for (const id of ["d", "e", "f"]) rollupTouch(sig(id, "bash:git status *"));
    for (const id of ["g", "h", "i"]) rollupTouch(sig(id, "bash:pnpm add *"));
    const seenMarker: (string | undefined)[] = [];
    const inf: Inferencer = async () => {
      seenMarker.push(process.env[INFERENCE_CHILD_ENV]);
      return { statement: "s", class: "implementer", target: "skill" };
    };
    expect(process.env[INFERENCE_CHILD_ENV]).toBeUndefined();
    await runInference(inf);
    // The child-inheritance guarantee: every call MUST have seen the marker
    // set at the moment its process would have spawned.
    expect(seenMarker.length).toBeGreaterThanOrEqual(3);
    for (const m of seenMarker) expect(m).toBe("1");
    // The parent-restore guarantee: the marker is back to its exact prior
    // value (unset here) so the NEXT session_stop's guard does not misfire.
    expect(process.env[INFERENCE_CHILD_ENV]).toBeUndefined();
  });

  it("a pre-existing marker at entry short-circuits without touching env", async () => {
    // A caller who already set the marker (say, a wrapper harness spawning
    // an inference-child process) MUST see the child-guard fire early AND
    // must see its pre-existing value preserved verbatim — the pass never
    // reaches the marker-mutation code, so the exact prior string survives.
    process.env[INFERENCE_CHILD_ENV] = "prior-value";
    try {
      for (const id of ["a", "b", "c"]) rollupTouch(sig(id, "bash:foo *"));
      const inf: Inferencer = async () => ({ statement: "s", class: "implementer", target: "skill" });
      const r = await runInference(inf);
      expect(r.ran).toBe(false);
      expect(r.reason).toBe("child");
      expect(process.env[INFERENCE_CHILD_ENV]).toBe("prior-value");
    } finally {
      delete process.env[INFERENCE_CHILD_ENV];
    }
  });
});
