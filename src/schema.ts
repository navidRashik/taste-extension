// schema.ts — Taste's on-disk contracts and the runtime validators every disk
// read is parsed through.
//
// These types are the shared contract every capture, inference, and promotion
// caller depends on. The validators exist to keep the fail-open posture
// honest: a malformed entry on disk parses to null, never a throw, so a corrupt
// ledger degrades the learner to "learns nothing" rather than crashing a session.

export type SignalKind = "accept" | "reject" | "edit";
export type SignalStrength = 1 | 2 | 3; // accept=1, reject=2, edit=3
export type ScopeHint = "project" | "user";
export type PreferenceClass = "scope" | "behaviour" | "commitment" | "implementer";
export type PromotionTarget = "skill" | "memory" | "rule" | "approval";
export type PreferenceScope = "project" | "user";

/** Redacted evidence backing a signal; secrets/payloads are stripped upstream. */
export interface SignalEvidence {
  before?: string; // edit: the agent's own output before the human rewrote it
  after?: string; // edit: the human's rewrite
  correction?: string; // reject: the human's next-turn instruction
  rule?: string; // reject(block): the guard that fired
}

/** One observed accept/reject/edit signal — the raw preference evidence. */
export interface TasteSignal {
  id: string; // ulid
  kind: SignalKind;
  strength: SignalStrength;
  tool: string;
  subject: string; // stable, redacted fingerprint recurrence is counted over
  evidence: SignalEvidence;
  scopeHint: ScopeHint;
  repo: string; // git remote fingerprint (not a path)
  turn: number;
  at: number; // epoch ms
}

/**
 * Two-sided control for a `rule`-target candidate. The positive is drawn from
 * real backing evidence; the negative must belong to the same subject family
 * as the positive, so the two together specify what the rule accepts and what
 * it rejects. A candidate lacking either side is quarantined, never armed.
 */
export interface PreferenceControls {
  positive: string;
  negative: string;
}

/** A distilled preference statement plus its proposed class and target. */
export interface PreferenceCandidate {
  id: string;
  statement: string;
  class: PreferenceClass;
  target: PromotionTarget;
  confidence: number; // 0..1 from recurrence + signal strength
  scope: PreferenceScope;
  evidence: string[]; // signal ids backing it
  controls?: PreferenceControls; // populated only for rule targets
}

/**
 * One promotion record. `approvedBy` is the on-disk approval token that makes
 * "was this human-approved?" a fact rather than an inference: no automatic
 * path may write this field, so its presence is proof a human approved the
 * promotion — the audit trail is the record itself, not a runtime guess.
 */
export interface PromotionLedgerEntry {
  id: string;
  candidateId: string;
  target: PromotionTarget;
  scope: PreferenceScope;
  path: string; // artefact path written
  at: number;
  approvedBy?: string; // present iff a human approved a decision-class promotion
  quarantined?: boolean;
  quarantineReason?: string;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isString(x: unknown): x is string {
  return typeof x === "string";
}
function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

const SIGNAL_KINDS: ReadonlySet<string> = new Set<SignalKind>(["accept", "reject", "edit"]);
const CLASSES: ReadonlySet<string> = new Set<PreferenceClass>(["scope", "behaviour", "commitment", "implementer"]);
const TARGETS: ReadonlySet<string> = new Set<PromotionTarget>(["skill", "memory", "rule", "approval"]);
const SCOPES: ReadonlySet<string> = new Set<PreferenceScope>(["project", "user"]);

export function isTasteSignal(x: unknown): x is TasteSignal {
  if (!isRecord(x)) return false;
  return (
    isString(x.id) &&
    isString(x.kind) &&
    SIGNAL_KINDS.has(x.kind) &&
    (x.strength === 1 || x.strength === 2 || x.strength === 3) &&
    isString(x.tool) &&
    isString(x.subject) &&
    isRecord(x.evidence) &&
    isString(x.scopeHint) &&
    SCOPES.has(x.scopeHint) &&
    isString(x.repo) &&
    isFiniteNumber(x.turn) &&
    isFiniteNumber(x.at)
  );
}

export function isPreferenceCandidate(x: unknown): x is PreferenceCandidate {
  if (!isRecord(x)) return false;
  if (
    !(
      isString(x.id) &&
      isString(x.statement) &&
      isString(x.class) &&
      CLASSES.has(x.class) &&
      isString(x.target) &&
      TARGETS.has(x.target) &&
      isFiniteNumber(x.confidence) &&
      isString(x.scope) &&
      SCOPES.has(x.scope) &&
      Array.isArray(x.evidence) &&
      x.evidence.every(isString)
    )
  ) {
    return false;
  }
  if (x.controls !== undefined) {
    if (!isRecord(x.controls) || !isString(x.controls.positive) || !isString(x.controls.negative)) return false;
  }
  return true;
}

export function isPromotionLedgerEntry(x: unknown): x is PromotionLedgerEntry {
  if (!isRecord(x)) return false;
  if (
    !(
      isString(x.id) &&
      isString(x.candidateId) &&
      isString(x.target) &&
      TARGETS.has(x.target) &&
      isString(x.scope) &&
      SCOPES.has(x.scope) &&
      isString(x.path) &&
      isFiniteNumber(x.at)
    )
  ) {
    return false;
  }
  if (x.approvedBy !== undefined && !isString(x.approvedBy)) return false;
  if (x.quarantined !== undefined && typeof x.quarantined !== "boolean") return false;
  if (x.quarantineReason !== undefined && !isString(x.quarantineReason)) return false;
  return true;
}

/**
 * Parse a single JSON object and validate its shape. Returns null on any
 * malformed input — the fail-open contract every disk read relies on.
 */
export function parseChecked<T>(raw: string, guard: (x: unknown) => x is T): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return guard(parsed) ? parsed : null;
}

/**
 * Parse a JSON array and validate every element. Returns null if the payload is
 * not an array or any element fails its guard — one bad row rejects the batch
 * rather than silently dropping it.
 */
export function parseCheckedArray<T>(raw: string, guard: (x: unknown) => x is T): T[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: T[] = [];
  for (const item of parsed) {
    if (!guard(item)) return null;
    out.push(item);
  }
  return out;
}
