// apply.ts — the session_start application path plus the ledger and
// staleness views the `/taste` panel reads.
//
// Application adds no new machinery: every promotion target is a slot the
// harness already reads at startup, so a promoted preference is
// indistinguishable from a hand-authored one by the time it takes effect. A
// managed skill is surfaced by being on disk when the catalog is scanned, a
// memory by the harness's own auto-recall, a guard rule by being loaded and
// stream-matched, and an approval entry by the config read at launch. What
// this module owns is the TRIGGER: the lifecycle point at which an already-
// inferred candidate is turned into that artefact.
//
// Three invariants hold here, each independent of the promoter's own gates:
//   • decision-class candidates are never handed to the automatic path and
//     never surfaced — they wait silently in the review queue until a human
//     pulls them, so a session start is never interrupted by a pending
//     preference decision;
//   • auto-promotion runs only for a scope whose human explicitly switched
//     it on; an untouched scope stays inert;
//   • a stale candidate is never armed, and staleness never retracts an
//     artefact that is already armed — it is surfaced for review only.
//
// The report this module returns deliberately carries no decision-class
// prose. Only implementer-class statements can reach the surfacing path,
// because only those are in the report at all.

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveTasteConfig } from "./config.js";
import { loadCandidates } from "./inference.js";
import { promote, readPromotionLedger, type PromoteResult } from "./promote.js";
import type { PreferenceCandidate, PromotionLedgerEntry } from "./schema.js";

/**
 * Below this confidence a promotion is treated as stale. Inference already
 * folds time decay and supersession into the confidence it derives, so one
 * threshold covers both drift shapes. The value is a floor rather than a
 * measurement: a candidate this weak has either idled for several half-lives
 * or been contradicted by newer signals, and neither is worth arming
 * unprompted. Raising or lowering it can only change what is surfaced and
 * what auto-arms; it can never cause an armed artefact to be retracted.
 */
export const STALE_CONFIDENCE = 0.25;

/** Cap on promotions attempted per session start, so the lifecycle hook's
 * cost stays bounded no matter how many candidates accumulated. */
const MAX_APPLY_PER_START = 8;

/**
 * A ledger row whose quarantine reason starts with this marker is a
 * tombstone: it records that the promotion it names was reversed by a human
 * and is no longer on disk. The ledger is append-only, so reversal is
 * recorded by appending rather than by rewriting history.
 */
export const TOMBSTONE_PREFIX = "forgotten:";

export interface LedgerView {
  /** Promotions that wrote an artefact and have not been reversed. */
  armed: PromotionLedgerEntry[];
  /** Candidate ids with an artefact currently on disk. */
  armedCandidates: Set<string>;
  /** Candidate ids a human reversed; the automatic path never re-arms them. */
  tombstonedCandidates: Set<string>;
  /** Promotions that failed a gate and were never armed. */
  quarantined: PromotionLedgerEntry[];
}

/**
 * Fold the append-only ledger into the current state of every promotion.
 * Rows are replayed in order, so a promotion, its reversal, and a later
 * human re-promotion of the same candidate resolve to the last thing that
 * actually happened.
 */
export function ledgerView(entries: readonly PromotionLedgerEntry[]): LedgerView {
  const armed = new Map<string, PromotionLedgerEntry>();
  const tombstonedCandidates = new Set<string>();
  const quarantined: PromotionLedgerEntry[] = [];
  for (const entry of entries) {
    const reason = entry.quarantineReason ?? "";
    if (entry.quarantined && reason.startsWith(TOMBSTONE_PREFIX)) {
      armed.delete(reason.slice(TOMBSTONE_PREFIX.length));
      tombstonedCandidates.add(entry.candidateId);
      continue;
    }
    if (entry.quarantined) {
      quarantined.push(entry);
      continue;
    }
    armed.set(entry.id, entry);
  }
  const rows = [...armed.values()];
  return {
    armed: rows,
    armedCandidates: new Set(rows.map((e) => e.candidateId)),
    tombstonedCandidates,
    quarantined,
  };
}

export type StaleReason = "decayed" | "orphaned";

export interface StalePromotion {
  entry: PromotionLedgerEntry;
  reason: StaleReason;
  /** Current confidence, absent when the backing candidate is gone. */
  confidence?: number;
  statement: string;
}

/**
 * Armed promotions whose backing preference no longer holds up: either its
 * confidence has decayed or been cut by a contradicting signal, or its
 * candidate has aged out of the accumulator entirely. Both are surfaced for
 * review; neither disarms anything, because retracting an artefact a human
 * has been relying on is a decision only that human may take.
 */
export function stalePromotions(
  view: LedgerView,
  candidates: readonly PreferenceCandidate[],
): StalePromotion[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out: StalePromotion[] = [];
  for (const entry of view.armed) {
    const candidate = byId.get(entry.candidateId);
    if (!candidate) {
      out.push({ entry, reason: "orphaned", statement: "" });
    } else if (candidate.confidence < STALE_CONFIDENCE) {
      out.push({ entry, reason: "decayed", confidence: candidate.confidence, statement: candidate.statement });
    }
  }
  return out;
}

/** The promoter seam, so a test can observe exactly which candidates the
 * application path is willing to hand to the automatic promotion path. */
export type PromoteFn = (candidate: PreferenceCandidate, ctx: ExtensionContext) => Promise<PromoteResult>;

export interface ApplyOptions {
  promoteFn?: PromoteFn;
}

export interface ApplyReport {
  ran: boolean;
  /** Why nothing ran; absent when the path executed. */
  reason?: "disabled" | "not-opted-in";
  /** Statements of the implementer-class preferences armed by this pass. */
  promoted: string[];
  /** How many candidates the class gate held back. Counted, never quoted. */
  queued: number;
  /** How many were skipped as already armed, reversed, or stale. */
  skipped: number;
  /** How many promotion attempts came back quarantined. */
  quarantined: number;
}

const EMPTY: Omit<ApplyReport, "ran" | "reason"> = { promoted: [], queued: 0, skipped: 0, quarantined: 0 };

/**
 * Run the application path for one session start. Every gate below is
 * deliberate and none of them is the promoter's:
 *
 *   • the scope must be switched on, and switched on for automatic
 *     promotion specifically — learning without arming is a configuration a
 *     human may legitimately want;
 *   • only implementer-class candidates reach the promoter at all. The
 *     promoter refuses a decision-class candidate on the automatic path too;
 *     this gate is the outer one, and it means a decision-class statement is
 *     never even read into an artefact write;
 *   • a candidate already armed, already reversed by a human, or stale is
 *     skipped rather than re-armed.
 *
 * The promoter itself still owns the irreversible-action pre-filter, the
 * class filter, the negative controls, and the ledger; this path never
 * reaches around any of them.
 */
export async function applyPromotions(ctx: ExtensionContext, opts: ApplyOptions = {}): Promise<ApplyReport> {
  const config = resolveTasteConfig(ctx.cwd);
  if (!config.enabled) return { ran: false, reason: "disabled", ...EMPTY };
  if (!config.autoPromote) return { ran: false, reason: "not-opted-in", ...EMPTY };

  const promoteFn: PromoteFn = opts.promoteFn ?? ((candidate, c) => promote(candidate, c));
  const view = ledgerView(readPromotionLedger());
  const report: ApplyReport = { ran: true, promoted: [], queued: 0, skipped: 0, quarantined: 0 };
  let attempts = 0;
  for (const candidate of loadCandidates()) {
    if (candidate.class !== "implementer") {
      report.queued += 1;
      continue;
    }
    if (
      view.armedCandidates.has(candidate.id) ||
      view.tombstonedCandidates.has(candidate.id) ||
      candidate.confidence < STALE_CONFIDENCE
    ) {
      report.skipped += 1;
      continue;
    }
    if (attempts >= MAX_APPLY_PER_START) {
      report.skipped += 1;
      continue;
    }
    attempts += 1;
    const result = await promoteFn(candidate, ctx);
    if (result.outcome === "promoted") report.promoted.push(candidate.statement);
    else if (result.outcome === "quarantined") report.quarantined += 1;
    else report.skipped += 1;
  }
  return report;
}

/**
 * Tell the human what was armed, without interrupting them. The message is
 * delivered for the next turn and triggers no turn of its own, so a session
 * start is never derailed by it, and it is emitted only when something
 * actually changed. Nothing pending or decision-class is mentioned: those
 * are pulled on demand through the review queue, never pushed.
 */
export function surfaceApplied(pi: ExtensionAPI, report: ApplyReport): void {
  if (report.promoted.length === 0) return;
  const lines = [
    `taste applied ${report.promoted.length} learned preference${report.promoted.length === 1 ? "" : "s"}:`,
    ...report.promoted.map((s) => `  - ${s}`),
  ];
  pi.sendMessage(
    { customType: "sh.omp.taste.applied", content: lines.join("\n"), display: true },
    { deliverAs: "nextTurn" },
  );
}

/** The lifecycle entry point: apply, then surface what changed. */
export async function applyAtSessionStart(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  opts: ApplyOptions = {},
): Promise<ApplyReport> {
  const report = await applyPromotions(ctx, opts);
  surfaceApplied(pi, report);
  return report;
}
