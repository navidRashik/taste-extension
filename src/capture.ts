// capture.ts — Taste's capture handlers.
//
// Turns the harness event stream into typed, redacted TasteSignal entries in
// the current session's ledger via `pi.appendEntry("sh.omp.taste.signal", …)`,
// and mirrors each banked signal into the cross-session rollup so recurrence
// is countable across sessions.
//
// The five signal shapes produced here:
//   • edit                — a write/edit/apply_patch tool_result stores an
//                           agent-write snapshot; the next `input` compares
//                           the current file against that snapshot and, if
//                           the human rewrote it, emits ONE strength-3 edit.
//   • reject(block)       — a `ttsr_triggered` event names the offending
//                           rule and the tool action that provoked it.
//   • reject(denial)      — a rejected `tool_approval_resolved` names the
//                           tool action the human refused.
//   • reject(correction)  — an `input` whose text carries a correction verb
//                           after a specific prior action is a heuristic
//                           reject bound to that action's fingerprint.
//   • accept              — a two-state machine: `turn_end` queues a pending
//                           accept for the turn's unchallenged agent action;
//                           the next `input` finalises it iff no correction
//                           landed in the window (checked AFTER the correction
//                           path runs, so a correction cancels rather than
//                           banks); `session_stop` finalises any still-pending
//                           accept when the session ends before a next input.
//                           An accept is the ONLY signal never banked at the
//                           moment it was observed.
//
// Snapshot, last-action, and pending-accept state are session-local, kept in
// a WeakMap keyed on the ExtensionContext object so each session's capture
// state dies with its ctx. Subagent traffic is dropped upstream by the
// session-file-leaf predicate in the safely() wrapper and never reaches this
// module, so cross-contamination between a main session and a subagent is
// structurally impossible. The snapshot store is bounded per session so a
// pathological writer cannot balloon memory.

import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { isAbsolute, resolve as pathResolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SignalKind, SignalStrength, SignalEvidence, TasteSignal, ScopeHint } from "./schema.js";
import { redact, capHunk, isBinary, HUNK_CAP } from "./redact.js";
import { subjectOf, readStringField } from "./fingerprint.js";
import { rollupTouch } from "./rollup.js";

export const SIGNAL_CUSTOM_TYPE = "sh.omp.taste.signal";
const SNAPSHOT_CAP = 128; // per-session distinct paths tracked
const MAX_SNAPSHOT_BYTES = 256 * 1024; // never diff files this large
const CORRECTION_RX = /\b(?:no|not|don't|do not|use|instead|prefer|avoid|never|stop|rewrite|revert)\b/i;

interface Snapshot {
  content: string;
  at: number;
}
interface LastAction {
  tool: string;
  subject: string;
  at: number;
  turn: number; // captured on tool_call; identifies the action's turn window
  // Bounded, redacted raw args snippet. Present only for tools whose args map
  // cleanly to a stream-matchable snippet (bash today) — inference reads it
  // as the `positive` control for a rule candidate without inventing text.
  rawArgs?: string;
}
interface PendingAccept {
  tool: string;
  subject: string;
  turn: number;
  at: number;
}
interface CaptureState {
  turn: number;
  snapshots: Map<string, Snapshot>;
  // lastAction is the most recent agent action still eligible to become an
  // accept or a reject. A reject firing against it (block, denial, or a
  // matching correction) nulls it out — so at turn_end a non-null lastAction
  // is by definition unchallenged and safe to queue as pending accept.
  lastAction: LastAction | null;
  pending: PendingAccept | null;
}

// One capture state per ctx — dies with the ctx, so subagent contamination
// is structurally impossible even if a subagent handler ever slipped through.
const STATE = new WeakMap<object, CaptureState>();

function stateFor(ctx: ExtensionContext): CaptureState {
  let s = STATE.get(ctx);
  if (!s) {
    s = { turn: 0, snapshots: new Map(), lastAction: null, pending: null };
    STATE.set(ctx, s);
  }
  return s;
}

/** Read a nested unknown field from an event without an inline cast. */
function readUnknownField(event: unknown, key: string): unknown {
  if (typeof event !== "object" || event === null) return undefined;
  if (!(key in event)) return undefined;
  return (event as { [k: string]: unknown })[key];
}

/** Reset the ctx-local capture state — bound to session_start. */
export function resetCaptureState(ctx: ExtensionContext): void {
  STATE.delete(ctx);
}

function readSnapshotSafely(absPath: string): string | null {
  try {
    if (!existsSync(absPath)) return null;
    const st = statSync(absPath);
    if (!st.isFile()) return null;
    if (st.size > MAX_SNAPSHOT_BYTES) return null;
    const buf = readFileSync(absPath, "utf8");
    if (isBinary(buf)) return null;
    return buf;
  } catch {
    return null;
  }
}

function scopeHintFor(): ScopeHint {
  // Every signal defaults to project scope. The user-scope hint requires
  // config-plus-repo plumbing that this module does not yet own; when it
  // lands here, refine the hint rather than fabricating one.
  return "project";
}

function repoFingerprintOf(ctx: ExtensionContext): string {
  const cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
  // Cheap, stable, secret-free: the basename of the project cwd. The ledger
  // entry only needs "same-source" equality, which the basename satisfies; a
  // richer git-remote fingerprint is a future refinement of this function.
  const parts = cwd.split("/").filter((p) => p.length > 0);
  return parts.length > 0 ? `local:${parts[parts.length - 1]}` : "local:unknown";
}

function makeSignal(
  kind: SignalKind,
  strength: SignalStrength,
  tool: string,
  subject: string,
  evidence: SignalEvidence,
  ctx: ExtensionContext,
): TasteSignal {
  return {
    id: randomUUID(),
    kind,
    strength,
    tool,
    subject,
    evidence,
    scopeHint: scopeHintFor(),
    repo: repoFingerprintOf(ctx),
    turn: stateFor(ctx).turn,
    at: Date.now(),
  };
}

/** Bank a signal: write it to the session ledger AND mirror it into the
 * cross-session rollup. Every appendEntry-with-a-signal call in this module
 * goes through here so the two writes never diverge — if a future handler
 * appends to the ledger without touching the rollup, the recurrence gate
 * will silently under-count that subject. */
// Cap for a rollup-side snippet: enough to reconstruct a bash command family,
// tight enough not to widen egress. Redaction has already run upstream.
const ROLLUP_SNIPPET_CAP = 200;

function capSnippet(s: string): string {
  return s.length > ROLLUP_SNIPPET_CAP ? s.slice(0, ROLLUP_SNIPPET_CAP) : s;
}

function bank(pi: ExtensionAPI, sig: TasteSignal, positive?: string): void {
  pi.appendEntry(SIGNAL_CUSTOM_TYPE, sig);
  // Explicit projection so no field silently leaks into the rollup file: only
  // the fingerprint, counts, and the two bounded snippets inference needs to
  // build a rule-candidate's controls without invention.
  const projected = {
    id: sig.id,
    kind: sig.kind,
    strength: sig.strength,
    tool: sig.tool,
    subject: sig.subject,
    scopeHint: sig.scopeHint,
    repo: sig.repo,
    at: sig.at,
    ...(positive ? { positive: capSnippet(positive) } : {}),
    ...(sig.evidence.correction ? { correction: capSnippet(sig.evidence.correction) } : {}),
  };
  rollupTouch(projected);
}

/** tool_call: remember the last agent action so a correcting next-input has a
 * fingerprint to bind to. Never emits a signal itself. */
export function onToolCall(_pi: ExtensionAPI, event: unknown, ctx: ExtensionContext): void {
  const s = stateFor(ctx);
  const tool = readStringField(event, "toolName");
  if (!tool) return;
  const input = readUnknownField(event, "input");
  const rawCommand = tool.toLowerCase() === "bash" ? redact(readStringField(input, "command")).trim() : "";
  s.lastAction = {
    tool,
    subject: subjectOf(tool, input),
    at: Date.now(),
    turn: s.turn,
    ...(rawCommand ? { rawArgs: capSnippet(rawCommand) } : {}),
  };
}

/** tool_result: for write/edit/apply_patch snapshot the file the agent wrote
 * so the next `input` can compute the human's rewrite. Never banks a signal. */
export function onToolResult(_pi: ExtensionAPI, event: unknown, ctx: ExtensionContext): void {
  const tool = readStringField(event, "toolName");
  if (tool !== "write" && tool !== "edit" && tool !== "apply_patch") return;
  const path = readStringField(readUnknownField(event, "input"), "path");
  if (!path) return;
  const cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
  const abs = isAbsolute(path) ? path : pathResolve(cwd, path);
  const content = readSnapshotSafely(abs);
  if (content === null) return; // binary, oversize, or unreadable
  const s = stateFor(ctx);
  // Bound the store: oldest-out on cap breach so a pathological writer cannot
  // exhaust memory over a session. A fresh write to the same path IS the newer
  // snapshot, so it replaces without evicting anyone.
  if (s.snapshots.size >= SNAPSHOT_CAP && !s.snapshots.has(abs)) {
    const oldestKey = s.snapshots.keys().next().value;
    if (typeof oldestKey === "string") s.snapshots.delete(oldestKey);
  }
  s.snapshots.set(abs, { content, at: Date.now() });
}

/** input: bump the turn counter, compare stored snapshots against the current
 * file (emit edit signals for divergences), heuristic-check the input text for
 * a correction of the last agent action, and — LAST — finalise any pending
 * accept iff no correction landed in the same input against its subject. The
 * ordering matters: a correction in this input cancels the queued accept
 * rather than banking it, which is the whole point of the two-state machine.
 * The `session_stop` finaliser handles the case where no next input arrives. */
export function onInput(pi: ExtensionAPI, event: unknown, ctx: ExtensionContext): void {
  const s = stateFor(ctx);
  s.turn += 1;
  const text = readStringField(event, "text");
  // 1) Edit signals: any snapshot whose file diverges got human-rewritten.
  for (const [abs, snap] of s.snapshots) {
    const now = readSnapshotSafely(abs);
    if (now === null) {
      s.snapshots.delete(abs);
      continue;
    }
    if (now === snap.content) continue;
    const evidence: SignalEvidence = {
      before: capHunk(redact(snap.content), HUNK_CAP),
      after: capHunk(redact(now), HUNK_CAP),
    };
    // The subject encodes the write construct — never the raw path — so it
    // is stable across sessions and secret-free by construction.
    const subject = subjectOf("edit", { path: abs, newText: snap.content });
    bank(pi, makeSignal("edit", 3, "edit", subject, evidence, ctx));
    s.snapshots.delete(abs);
  }
  // 2) Correction reject: a heuristic. Only fires when a prior action's
  // fingerprint is on record; otherwise we have nothing to bind it to.
  let correctedSubject: string | null = null;
  if (text && s.lastAction && CORRECTION_RX.test(text)) {
    const evidence: SignalEvidence = { correction: capHunk(redact(text), HUNK_CAP) };
    bank(pi, makeSignal("reject", 2, s.lastAction.tool, s.lastAction.subject, evidence, ctx), s.lastAction.rawArgs);
    correctedSubject = s.lastAction.subject;
    s.lastAction = null; // consume it — one correction per action
  }
  // 3) Pending-accept finalisation. Runs AFTER the correction path so a
  // matching correction in the same input drops the pending accept instead
  // of finalising it. An unmatched pending survives and is banked as the
  // canonical positive signal for the prior turn's unchallenged action.
  if (s.pending) {
    if (correctedSubject !== s.pending.subject) {
      bank(pi, makeSignal("accept", 1, s.pending.tool, s.pending.subject, {}, ctx));
    }
    s.pending = null;
  }
}

/** ttsr_triggered: a guard rule fired against the agent's own tool args. Also
 * marks the last action challenged, so turn_end will not queue it as pending
 * accept — it is no longer unchallenged. */
export function onTtsrTriggered(pi: ExtensionAPI, event: unknown, ctx: ExtensionContext): void {
  const s = stateFor(ctx);
  const rules = readUnknownField(event, "rules");
  let ruleName = "unknown";
  if (Array.isArray(rules) && rules.length > 0) {
    const first: unknown = rules[0];
    const n = readStringField(first, "name") || readStringField(first, "id");
    if (n) ruleName = n;
  }
  const action = s.lastAction ?? { tool: "unknown", subject: "unknown:*", at: Date.now(), turn: 0 } as LastAction;
  const evidence: SignalEvidence = { rule: redact(ruleName) };
  bank(pi, makeSignal("reject", 2, action.tool, action.subject, evidence, ctx), action.rawArgs);
  s.lastAction = null; // the action was challenged; do not queue it as accept
}

/** tool_approval_resolved: a denial is a reject against the refused action.
 * Also marks the last action challenged for the same reason as ttsr above. */
export function onApprovalResolved(pi: ExtensionAPI, event: unknown, ctx: ExtensionContext): void {
  const decision = readStringField(event, "decision") || readStringField(event, "resolution");
  const approvedFlag = readUnknownField(event, "approved");
  const denied =
    decision === "rejected" ||
    decision === "denied" ||
    decision === "reject" ||
    decision === "deny" ||
    approvedFlag === false;
  if (!denied) return;
  const s = stateFor(ctx);
  const eventTool = readStringField(event, "toolName");
  const eventArgs = readUnknownField(event, "args");
  const tool = eventTool || s.lastAction?.tool || "unknown";
  const subject = eventTool ? subjectOf(eventTool, eventArgs ?? {}) : (s.lastAction?.subject ?? "unknown:*");
  // On a denied approval whose event carried explicit args, prefer their
  // stringified redacted form as the positive; else fall back to whatever raw
  // args the pending lastAction retained (redacted at tool_call time).
  const explicitPositive = eventTool && typeof eventArgs === "object" && eventArgs !== null
    ? redact(readStringField(eventArgs, "command") || JSON.stringify(eventArgs)).trim()
    : "";
  const positive = explicitPositive || s.lastAction?.rawArgs;
  bank(pi, makeSignal("reject", 2, tool, subject, {}, ctx), positive);
  s.lastAction = null;
}

/** turn_end: queue a pending accept for the turn's unchallenged agent action.
 * A challenged action nulls lastAction above, so a non-null lastAction here
 * is by construction the turn's last unrejected action. The accept is never
 * banked at this point — the next input finalises it, or session_stop does. */
export function onTurnEnd(_pi: ExtensionAPI, _event: unknown, ctx: ExtensionContext): void {
  const s = stateFor(ctx);
  if (!s.lastAction) return;
  s.pending = { tool: s.lastAction.tool, subject: s.lastAction.subject, turn: s.turn, at: Date.now() };
}

/** session_stop: finalise any still-pending accept. The two-state machine
 * normally closes at the next input, but the session may end before then; a
 * pending accept that survived to session_stop had no correcting input, so
 * banking it here is the last chance to record the accept before the session ends. */
export function onSessionStop(pi: ExtensionAPI, _event: unknown, ctx: ExtensionContext): void {
  const s = stateFor(ctx);
  if (!s.pending) return;
  bank(pi, makeSignal("accept", 1, s.pending.tool, s.pending.subject, {}, ctx));
  s.pending = null;
}
