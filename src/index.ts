// index.ts — the Taste extension entry point and its fail-open scaffold.
//
// The default export registers exactly the handler surface Taste needs and
// routes each handler through the `safely` wrapper. Adding a new capture
// event happens here (registration) plus in ./capture (body); the wrapper's
// contract stays uniform for every handler.
//
// safely enforces three invariants on every handler:
//   • fail-open — a throw in a handler never propagates into the session
//   • inert-when-disabled — the enabled flag is re-read per call (mtime-cached),
//     so the kill switch takes effect immediately, no restart
//   • main-session-only — a subagent session has no human to learn from, so its
//     signals are suppressed via the session-file-leaf predicate
//
// A handful of fork-docs events (ttsr_triggered, session_stop,
// tool_approval_resolved) exist on the shipped omp runtime but are absent
// from the upstream ExtensionAPI type union. Registering them needs one
// narrow cast, confined to onForkEvent so the rest of the file stays typed.

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveTasteConfig } from "./config.js";
import {
  onToolCall,
  onToolResult,
  onInput,
  onTurnEnd,
  onSessionStop,
  onTtsrTriggered,
  onApprovalResolved,
  resetCaptureState,
} from "./capture.js";
import { ensureLoaded, flushAccumulator } from "./rollup.js";
import { runInference } from "./inference.js";
import { smolInferencer } from "./invoker.js";

// A subagent's session file is <dir>/<AgentName>.jsonl and is never the first
// session file the process opens; the main session is. Matching the leaf keeps
// us robust to both the parented and the sessionless-parent layouts.
const SESSION_LEAF = /\/([^/]+)\.jsonl$/;

interface Runtime {
  mainSessionFile: string | null;
}

// Process-wide so every session and subagent instance shares one view of which
// session file is the main one.
const G = globalThis as { __ompTasteRuntime?: Runtime };
const R: Runtime = (G.__ompTasteRuntime ??= { mainSessionFile: null });

/** Defensively read the current session file path; "" when unavailable. */
export function sessionFileOf(ctx: unknown): string {
  if (!ctx || typeof ctx !== "object" || !("sessionManager" in ctx)) return "";
  const manager = (ctx as Record<string, unknown>).sessionManager;
  if (!manager || typeof manager !== "object" || !("getSessionFile" in manager)) return "";
  const getter = (manager as Record<string, unknown>).getSessionFile;
  if (typeof getter !== "function") return "";
  try {
    const file: unknown = getter.call(manager);
    return typeof file === "string" ? file : "";
  } catch {
    return "";
  }
}

/**
 * True when this ctx belongs to a spawned subagent rather than the main session.
 * The main session file is the first one the process opens; any later session
 * file whose stem matches the leaf pattern is a subagent's.
 */
export function isSubagentSession(ctx: unknown): boolean {
  const file = sessionFileOf(ctx);
  if (!file) return false;
  if (R.mainSessionFile !== null && file === R.mainSessionFile) return false;
  if (R.mainSessionFile === null) return false; // main not yet known — treat as main
  return SESSION_LEAF.test(file);
}

/** Record the main session file the first time it is seen. */
function trackMainSession(ctx: unknown): void {
  const file = sessionFileOf(ctx);
  if (R.mainSessionFile === null && file) R.mainSessionFile = file;
}

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

// Bounded, in-memory health record: a rolling error counter plus a capped ring
// of the most-recent handler short-circuits. A silently-learning-nothing state
// must remain visible to the user, so `safely` records every fail-open here;
// a caller can read the record via `tasteHealth()` and future work can flush
// it to disk and surface it in a diagnostic command.
const HEALTH_CAP = 20;

interface HealthEntry {
  timestamp: number;
  handler: string; // internal registration label, e.g. "on:tool_call" — never user content
  errorClass: string; // constructor name — structurally safe, never secret-bearing
  // No free-form message here: an error's `.message` can carry a secret-bearing
  // token (a fetch URL with credentials, a rejected shell command line, ...).
  // Only structurally-safe fields are recorded — `handler` is our own internal
  // label and `errorClass` is a JS constructor name. Any diagnostic message
  // added later must be pushed through `redact()` before it lands here.
}

interface HealthRecord {
  errors: number; // rolling count since last clear
  recent: HealthEntry[]; // most-recent last, capped at HEALTH_CAP
}

// Process-wide health slot, shared across sessions like the runtime block above.
const GH = globalThis as { __ompTasteHealth?: HealthRecord };
const H: HealthRecord = (GH.__ompTasteHealth ??= { errors: 0, recent: [] });

function errorClassOf(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

function recordHealth(label: string, err: unknown): void {
  H.errors += 1;
  H.recent.push({
    timestamp: Date.now(),
    handler: label,
    errorClass: errorClassOf(err),
  });
  if (H.recent.length > HEALTH_CAP) H.recent.splice(0, H.recent.length - HEALTH_CAP);
}

/** Read-only snapshot of the health record — the sole read seam callers use. */
export function tasteHealth(): HealthRecord {
  return { errors: H.errors, recent: [...H.recent] };
}

/**
 * Wrap a capture handler so it is fail-open, inert when Taste is disabled for
 * the ctx's cwd, and suppressed inside subagent sessions. Exported so the
 * gating contract can be tested directly against a spy body.
 */
export function safely(label: string, handler: Handler): (event: unknown, ctx: ExtensionContext) => Promise<void> {
  return async (event: unknown, ctx: ExtensionContext): Promise<void> => {
    try {
      const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
      if (!resolveTasteConfig(cwd).enabled) return;
      if (isSubagentSession(ctx)) return;
      await handler(event, ctx);
    } catch (err) {
      // Fail open: a learner that can break a session is worse than one that
      // learns nothing. The short-circuit is recorded (never rethrown) so a
      // silently-learning-nothing state stays visible via `tasteHealth()`.
      recordHealth(label, err);
    }
  };
}

// The registered handler set now covers every signal edge Taste captures.
// `turn_end` queues a pending accept; `session_stop` finalises any still-pending
// accept and then flushes the in-memory rollup into the JSON accumulator so a
// peer session stopping at the same moment merges with these signals rather
// than clobbers them.

// The three fork-docs event names, isolated so the cast lives in exactly one
// place. Typed as a string overload of pi.on, which is sound at runtime.
type ForkDocsEvent = "ttsr_triggered" | "session_stop" | "tool_approval_resolved";
function onForkEvent(
  pi: ExtensionAPI,
  event: ForkDocsEvent,
  handler: (event: unknown, ctx: ExtensionContext) => Promise<void>,
): void {
  (pi.on as unknown as (e: string, h: Handler) => void)(event, handler);
}

/** Test-only: reset the process-wide main-session + health bookkeeping. */
export function __resetTasteRuntime(): void {
  R.mainSessionFile = null;
  H.errors = 0;
  H.recent.length = 0;
}

export default function taste(pi: ExtensionAPI): void {
  // session_start tracks the main session file unconditionally — the subagent
  // predicate depends on it even for a scope that is currently disabled — and
  // resets the ctx-local capture state so a fresh session starts clean. It
  // also seeds the in-memory rollup from disk on demand, so this session's
  // recurrence view starts from the merged state that any prior session left.
  pi.on("session_start", async (event, ctx) => {
    trackMainSession(ctx);
    await safely("on:session_start", (_e, c) => {
      resetCaptureState(c);
      ensureLoaded();
    })(event, ctx);
  });

  // Typed capture events — each wraps the capture handler through safely()
  // so the fail-open + subagent-suppression contract runs uniformly.
  pi.on("tool_call", safely("on:tool_call", (event, ctx) => onToolCall(pi, event, ctx)));
  pi.on("tool_result", safely("on:tool_result", (event, ctx) => onToolResult(pi, event, ctx)));
  pi.on("input", safely("on:input", (event, ctx) => onInput(pi, event, ctx)));
  pi.on("turn_end", safely("on:turn_end", (event, ctx) => onTurnEnd(pi, event, ctx)));

  // Fork-docs capture events (see header): registered through the one cast seam.
  onForkEvent(pi, "ttsr_triggered", safely("on:ttsr_triggered", (event, ctx) => onTtsrTriggered(pi, event, ctx)));
  onForkEvent(pi, "tool_approval_resolved", safely("on:tool_approval_resolved", (event, ctx) => onApprovalResolved(pi, event, ctx)));

  // session_stop closes the pending-accept two-state machine, flushes the
  // in-memory rollup into the JSON accumulator (read-modify-write with a
  // lockfile + atomic rename so peer sessions merge rather than clobber),
  // and THEN runs one off-thread inference pass. Order matters: the pass is
  // a summariser over the freshly-flushed rollup, so flushing first ensures
  // the current session's contribution counts toward recurrence. The pass
  // is single-flight, recursion-guarded (a child spawned by this pass sees
  // the env marker and short-circuits) and wrapped by safely so a timeout
  // or exec failure records to health without escaping the session.
  onForkEvent(pi, "session_stop", safely("on:session_stop", async (event, ctx) => {
    onSessionStop(pi, event, ctx);
    await flushAccumulator();
    await runInference(smolInferencer(pi));
  }));
}
