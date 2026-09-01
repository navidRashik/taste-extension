// inference.ts — turns the cross-session rollup into classed preference
// candidates via a cheap off-thread summarisation pass at session_stop.
//
// The pipeline is fail-open at every layer: a throw, timeout, or unreadable
// disk means Taste learns nothing this pass, never a session-breaking throw.
// Two invariants keep it honest:
//   • recursion guard — if the current process was spawned by an inference
//     invocation (env marker set by the spawner), it does nothing at all;
//   • single-flight — one pass per process at a time; a second stop-hook
//     racing the first returns immediately.
//
// PR3 produces candidates only. No promotion, no rules, no commits — the
// writers live in later slices and consume this pass's candidates.json.

import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Bucket, RollupSignal } from "./rollup.js";
import { ensureLoaded, rollupBuckets, tasteStateDir } from "./rollup.js";
import type { PreferenceCandidate, PreferenceClass, PreferenceControls, PreferenceScope, PromotionTarget } from "./schema.js";
import { isPreferenceCandidate, parseCheckedArray } from "./schema.js";
import { subjectOf } from "./fingerprint.js";

/** Env marker a spawner sets before launching a child; a process finding
 * it set MUST NOT run its own inference — it serves the parent's one call. */
export const INFERENCE_CHILD_ENV = "OMP_TASTE_INFERENCE_CHILD";

// Recurrence thresholds. The 3-signal gate catches a preference that
// recurred three sessions running; the 2-edit shortcut lets a single strong
// signal class (a human rewrote the agent's output twice) speak louder than
// three lighter accepts. Counts are deduped by signal id upstream.
const MIN_RECURRENCE = 3;
const MIN_STRONG_EDITS = 2;
// Halve raw confidence per this much idle time — exponential, so a long-idle
// bucket asymptotes to zero rather than crossing it.
const DECAY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PASS_BUCKETS = 64;
const DEFAULT_PASS_TIMEOUT_MS = 30_000;

/** Sanitised, redacted input handed to the summariser for one bucket. */
export interface InferenceInput {
  subject: string;
  scope: PreferenceScope;
  repo: string;
  tool: string;
  recentCorrections: string[];
  recentPositives: string[];
  totalCount: number;
  strongEditCount: number;
}
/** Fixed-shape summariser response; free-form prose is discarded upstream. */
export interface InferenceOutcome {
  statement: string;
  class: PreferenceClass;
  target: PromotionTarget;
  negativeSnippet?: string;
}
export type Inferencer = (input: InferenceInput) => Promise<InferenceOutcome | null>;

interface InferenceSlot { running: boolean }
const G = globalThis as { __ompTasteInference?: InferenceSlot };
const SLOT: InferenceSlot = (G.__ompTasteInference ??= { running: false });

/** Test seam so a hermetic run does not inherit a stuck flag. */
export function __resetInferenceSlot(): void { SLOT.running = false; }

export interface RunOptions { timeoutMs?: number; now?: number }
export interface RunResult { ran: boolean; candidates: PreferenceCandidate[]; reason?: string }

export function loadCandidates(): PreferenceCandidate[] {
  const file = join(tasteStateDir(), "candidates.json");
  if (!existsSync(file)) return [];
  return parseCheckedArray(readFileSync(file, "utf8"), isPreferenceCandidate) ?? [];
}

// Atomic write-temp-and-rename — single-flight makes concurrent writers from
// within this process impossible; a peer process's write is best-effort.
function saveCandidates(cs: PreferenceCandidate[]): void {
  const dir = tasteStateDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "candidates.json");
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(cs));
  renameSync(tmp, file);
}

function passesGate(b: Bucket): boolean {
  if (b.count >= MIN_RECURRENCE) return true;
  let edits = 0;
  for (const s of b.signals) if (s.strength === 3) edits += 1;
  return edits >= MIN_STRONG_EDITS;
}

function buildInput(b: Bucket): InferenceInput {
  const corrections: string[] = [];
  const positives: string[] = [];
  let tool = "";
  let strong = 0;
  // Walk newest-first so caps trim oldest evidence first.
  for (let i = b.signals.length - 1; i >= 0; i--) {
    const s = b.signals[i];
    if (!tool && s.tool) tool = s.tool;
    if (s.strength === 3) strong += 1;
    if (s.correction && corrections.length < 4) corrections.push(s.correction);
    if (s.positive && positives.length < 4) positives.push(s.positive);
  }
  return {
    subject: b.subject, scope: b.scopeHint, repo: b.repo, tool,
    recentCorrections: corrections, recentPositives: positives,
    totalCount: b.count, strongEditCount: strong,
  };
}

// Twelve is the calibration point: three recurrences of an average-strength
// reject signal saturates to ~1.0, matching the recurrence gate at N=3.
function baseConfidence(b: Bucket): number {
  if (b.signals.length === 0) return 0;
  let sum = 0;
  for (const s of b.signals) sum += s.strength;
  const raw = (b.count * (sum / b.signals.length)) / 12;
  return raw > 1 ? 1 : raw < 0 ? 0 : raw;
}

// Supersession: split the bucket in half; if the older half was reject/edit
// and the newer half flipped to accept, cut the score proportionally — the
// human's taste changed. Returns a factor in [0, 1].
function supersessionFactor(signals: readonly RollupSignal[]): number {
  if (signals.length < 2) return 1;
  const half = Math.floor(signals.length / 2);
  let olderNeg = 0, newerNeg = 0, newerAccept = 0;
  for (let i = 0; i < signals.length; i++) {
    const s = signals[i];
    if (i < half) {
      if (s.kind === "reject" || s.kind === "edit") olderNeg += s.strength;
    } else {
      if (s.kind === "reject" || s.kind === "edit") newerNeg += s.strength;
      else if (s.kind === "accept") newerAccept += s.strength;
    }
  }
  if (olderNeg > 0 && newerAccept > 0 && newerNeg < olderNeg) {
    const ratio = 1 - newerAccept / (olderNeg + newerAccept);
    return ratio < 0 ? 0 : ratio;
  }
  return 1;
}

// Rule-target controls: positive is the newest banked raw args on the
// bucket (redacted at capture time, never invented). Negative is the
// summariser's proposal, accepted only if it normalises to the positive's
// subject family under the shared fingerprinter; otherwise both sides are
// dropped and the downstream writer quarantines rather than arming on a
// synthesised proof.
function controlsFor(outcome: InferenceOutcome, b: Bucket, input: InferenceInput): PreferenceControls | undefined {
  if (outcome.target !== "rule") return undefined;
  const positive = input.recentPositives[0];
  const negative = outcome.negativeSnippet?.trim();
  if (!positive || !negative) return undefined;
  if (subjectOf(input.tool || "bash", { command: negative }) !== b.subject) return undefined;
  return { positive, negative };
}

async function candidateFor(b: Bucket, inferencer: Inferencer, now: number, prior: PreferenceCandidate | undefined): Promise<PreferenceCandidate | null> {
  const input = buildInput(b);
  let outcome: InferenceOutcome | null;
  try {
    outcome = await inferencer(input);
  } catch {
    return null;
  }
  if (!outcome || !outcome.statement) return null;
  const age = now - b.lastTouched;
  const decay = age <= 0 ? 1 : Math.pow(0.5, age / DECAY_HALF_LIFE_MS);
  const raw = baseConfidence(b) * decay * supersessionFactor(b.signals);
  const controls = controlsFor(outcome, b, input);
  return {
    // Reuse the prior id so a subject's candidate identity is stable across
    // passes — a re-derivation updates the confidence, not the row count.
    id: prior?.id ?? `pc_${randomBytes(8).toString("hex")}`,
    statement: outcome.statement,
    class: outcome.class,
    target: outcome.target,
    confidence: raw > 1 ? 1 : raw < 0 ? 0 : raw,
    scope: b.scopeHint,
    evidence: b.signals.map((s) => s.id),
    ...(controls ? { controls } : {}),
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("taste inference: timeout")), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** One inference pass. Fail-open at every layer — no throw escapes to the
 * caller from any of load, gate, summarise, derive, or persist. */
export async function runInference(inferencer: Inferencer, opts: RunOptions = {}): Promise<RunResult> {
  // Single-flight FIRST — a second call from within this process is a
  // sibling in the same batch (we set the env marker outself, below), not
  // a spawned child. Checking the marker before single-flight would
  // mis-classify the sibling as a child.
  if (SLOT.running) return { ran: false, candidates: [], reason: "in-flight" };
  if (process.env[INFERENCE_CHILD_ENV]) return { ran: false, candidates: [], reason: "child" };
  SLOT.running = true;
  // Set the recursion-guard env marker ONCE around the whole batch, not per
  // call. process.env is process-global; a per-call save/set/restore inside
  // the concurrent Promise.all would race on the restore and leave the
  // marker set in the parent after the batch. Single-flight above guarantees
  // no other runInference will race this outer window, and the child-guard
  // above guarantees the marker was unset at entry — so the finally always
  // deletes.
  process.env[INFERENCE_CHILD_ENV] = "1";
  try {
    ensureLoaded();
    const now = opts.now ?? Date.now();
    const priors = loadCandidates();
    const ordered: Bucket[] = [];
    for (const b of rollupBuckets().values()) if (passesGate(b)) ordered.push(b);
    ordered.sort((a, b) => b.lastTouched - a.lastTouched);
    if (ordered.length > MAX_PASS_BUCKETS) ordered.length = MAX_PASS_BUCKETS;
    // A prior candidate that shares an evidence id AND scope with a bucket
    // describes the same subject family — reuse its id so a re-derivation
    // updates the row's confidence rather than adding a duplicate.
    const derived: PreferenceCandidate[] = [];
    await withTimeout(Promise.all(ordered.map(async (b) => {
      let prior: PreferenceCandidate | undefined;
      for (const c of priors) {
        if (c.scope !== b.scopeHint) continue;
        for (const id of c.evidence) if (b.seenIds.includes(id)) { prior = c; break; }
        if (prior) break;
      }
      const cand = await candidateFor(b, inferencer, now, prior);
      if (cand) derived.push(cand);
    })), opts.timeoutMs ?? DEFAULT_PASS_TIMEOUT_MS);
    saveCandidates(derived);
    return { ran: true, candidates: derived };
  } catch (err) {
    return { ran: false, candidates: [], reason: err instanceof Error ? err.message : "error" };
  } finally {
    delete process.env[INFERENCE_CHILD_ENV];
    SLOT.running = false;
  }
}
