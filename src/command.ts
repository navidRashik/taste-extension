// command.ts — the `/taste` command: the only user-visible surface, and the
// only place a human can see or steer what the learner has done.
//
// Six subcommands, and the omissions are as deliberate as the entries.
// There is no publish and no fetch verb: a project-scope promotion is
// committed to the repo when it is made, so the commit is the publication
// and a teammate's learned taste arrives with the branch like any other
// file.
//
//   status            what is on, what is armed, what is waiting, what has
//                     gone stale, and whether the learner is erroring
//   enable / disable  record a scope's explicit opt-in or opt-out
//   review            pull the decision-class queue and the quarantine —
//                     the only way either is ever shown, because a session
//                     start must never interrupt a human to ask about a
//                     pending preference
//   promote <id>      the human-approval path: promotes against an approval
//                     token recorded in the ledger, which is what allows a
//                     decision-class preference to be applied at all
//   forget <id>       the only undo, and the reason undo must come before
//   forget --all      uninstalling: removing the extension removes this
//                     command but leaves every artefact it wrote in effect
//
// The handler never throws. It is invoked by a human rather than by the
// event bus, so it is not wrapped by the event fail-open envelope and
// carries its own: an unexpected fault is recorded to the same health
// record and reported in the panel instead of breaking the session.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ledgerView, stalePromotions, STALE_CONFIDENCE, type LedgerView } from "./apply.js";
import { resolveTasteConfig, type TasteConfig } from "./config.js";
import { irreversibleFamily } from "./denylist.js";
import { forgetPromotions, type ForgetOptions, type ForgetOutcome } from "./forget.js";
import type { HealthRecord } from "./index.js";
import { loadCandidates } from "./inference.js";
import { promote, readPromotionLedger, subjectForCandidate, type PromoteResult } from "./promote.js";
import { ensureLoaded, rollupBuckets } from "./rollup.js";
import type { PreferenceCandidate, PromotionLedgerEntry } from "./schema.js";
import { atomicWrite, scopeRoot } from "./writers.js";

/** Seams the command needs from the extension entry point, injected rather
 * than imported so the command surface stays independently testable. */
export interface CommandDeps {
  health: () => HealthRecord;
  isSubagent: (ctx: unknown) => boolean;
  record: (label: string, err: unknown) => void;
  promoteFn?: (candidate: PreferenceCandidate, ctx: ExtensionContext, approvedBy: string) => Promise<PromoteResult>;
  forgetOptions?: ForgetOptions;
  now?: number;
}

interface ParsedArgs {
  sub: string;
  positional: string[];
  all: boolean;
  user: boolean;
  scope?: "project" | "user";
}

/** Split the raw argument string. Unknown flags are ignored rather than
 * rejected: a typo must never be the reason a human cannot read the panel. */
export function parseTasteArgs(raw: string): ParsedArgs {
  const tokens = raw.trim().split(/\s+/).filter((t) => t !== "");
  const out: ParsedArgs = { sub: "status", positional: [], all: false, user: false };
  // A bare `/taste` is the panel, so the subcommand is optional and only a
  // leading non-flag token can be one.
  if (tokens.length > 0 && !tokens[0].startsWith("-")) out.sub = tokens.shift() as string;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--all") out.all = true;
    else if (token === "--user") out.user = true;
    else if (token === "--scope" || token.startsWith("--scope=")) {
      const value = token === "--scope" ? tokens[++i] : token.slice("--scope=".length);
      if (value === "project" || value === "user") out.scope = value;
    } else if (!token.startsWith("-")) out.positional.push(token);
  }
  return out;
}

/**
 * The settings file a scope's opt-in is written to. The project toggle lands
 * in the uncommitted local-override layer, because that layer has the
 * highest precedence: a toggle a committed team file could silently outrank
 * would not be a toggle, and per-checkout enable/disable is exactly what
 * that layer is for. The user toggle lands in the user layer, which applies
 * to every checkout that has no local override of its own. Both paths are
 * derived from the same scoped-root helper the writers use, so there is one
 * notion of where a scope lives.
 */
export function tasteSettingsFile(cwd: string, scope: "project" | "user"): string {
  return scope === "user"
    ? join(scopeRoot("user", cwd), "settings.json")
    : join(scopeRoot("project", cwd), "settings.local.json");
}

/**
 * Record a scope's explicit opt-in or opt-out. Persisting the choice IS the
 * opt-in: a scope a human switched on stays on for every later session,
 * while a scope nobody ever touched keeps the shipped default and is never
 * auto-enabled. Switching a scope on also opts it into applying the safe,
 * implementer-class half automatically, which is what "learning" means once
 * it is on; a human who wants signals recorded but nothing ever armed can
 * still say so by hand in the same file.
 *
 * Every unrelated key survives, and a file that exists but does not parse is
 * refused rather than clobbered — discarding settings a human wrote by hand
 * is never the safe answer.
 */
function writeScopeOptIn(cwd: string, scope: "project" | "user", enabled: boolean): string {
  const file = tasteSettingsFile(cwd, scope);
  let doc: Record<string, unknown> = {};
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error(`taste: ${file} is not valid JSON and was left untouched`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`taste: ${file} is not a settings object and was left untouched`);
    }
    doc = parsed as Record<string, unknown>;
  }
  const prior = doc.taste;
  const taste: Record<string, unknown> =
    typeof prior === "object" && prior !== null && !Array.isArray(prior) ? { ...(prior as Record<string, unknown>) } : {};
  taste.enabled = enabled;
  if (enabled) taste.autoPromote = true;
  doc.taste = taste;
  mkdirSync(join(file, ".."), { recursive: true });
  atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}

/** Everything the panel reads, gathered once so every subcommand shows a
 * single consistent view of the learner's state. */
interface TasteState {
  config: TasteConfig;
  candidates: PreferenceCandidate[];
  view: LedgerView;
  subjects: number;
}

function readState(ctx: ExtensionContext): TasteState {
  ensureLoaded();
  return {
    config: resolveTasteConfig(ctx.cwd),
    candidates: loadCandidates(),
    view: ledgerView(readPromotionLedger()),
    subjects: rollupBuckets().size,
  };
}

/**
 * Candidates the automatic path will never apply: the decision-class ones,
 * plus the implementer-labelled ones whose subject the irreversible
 * pre-filter forced into the same queue. Both are shown only here, and both
 * can still be approved by a human.
 */
function reviewQueue(candidates: readonly PreferenceCandidate[]): { candidate: PreferenceCandidate; why: string }[] {
  const out: { candidate: PreferenceCandidate; why: string }[] = [];
  for (const candidate of candidates) {
    if (candidate.class !== "implementer") {
      out.push({ candidate, why: `${candidate.class}-class` });
      continue;
    }
    const family = irreversibleFamily(subjectForCandidate(candidate));
    if (family) out.push({ candidate, why: `irreversible family ${family}` });
  }
  return out;
}

function statusPanel(ctx: ExtensionContext, state: TasteState, deps: CommandDeps): string[] {
  const { config, view } = state;
  const queue = reviewQueue(state.candidates);
  const lines = [
    `taste — learning ${config.enabled ? "on" : "off"} · auto-apply ${config.autoPromote ? "on" : "off"} · writes to ${config.scope} scope`,
    `armed ${view.armed.length} · review queue ${queue.length} · quarantined ${view.quarantined.length} · subjects observed ${state.subjects}`,
  ];
  for (const stale of stalePromotions(view, state.candidates)) {
    const detail =
      stale.reason === "decayed"
        ? `confidence ${stale.confidence?.toFixed(2)} is below ${STALE_CONFIDENCE}`
        : "its backing evidence is gone";
    lines.push(`stale: ${stale.entry.id} (${stale.entry.target}) — ${detail}; /taste forget ${stale.entry.id} to reverse it`);
  }
  const health = deps.health();
  const last = health.recent[health.recent.length - 1];
  lines.push(
    health.errors === 0
      ? "health: no handler errors"
      : `health: ${health.errors} handler error(s), last ${last.handler} (${last.errorClass})`,
  );
  // A learner that is quietly doing nothing must never look the same as one
  // that is quietly failing, so the reason for silence is always named.
  if (!config.enabled) lines.push("inactive: taste is switched off here — /taste enable to opt this project in");
  else if (deps.isSubagent(ctx)) lines.push("inactive: this is a subagent session, which is never learned from");
  else if (state.subjects === 0 && state.candidates.length === 0) lines.push("inactive: nothing observed yet");
  return lines;
}

function reviewPanel(state: TasteState): string[] {
  const queue = reviewQueue(state.candidates);
  const lines: string[] = [];
  if (queue.length === 0) lines.push("review queue: empty — nothing is waiting on you");
  else lines.push(`review queue: ${queue.length} preference(s) awaiting your decision`);
  for (const { candidate, why } of queue) {
    lines.push(`  ${candidate.id} [${why}, confidence ${candidate.confidence.toFixed(2)}] ${candidate.statement}`);
    lines.push(`    approve with /taste promote ${candidate.id}`);
  }
  for (const entry of state.view.quarantined) {
    lines.push(`  quarantined ${entry.id} (${entry.target}) — ${entry.quarantineReason ?? "refused"}`);
  }
  return lines;
}

async function runPromote(
  ctx: ExtensionContext,
  state: TasteState,
  deps: CommandDeps,
  id: string,
): Promise<string[]> {
  if (!id) return ["usage: /taste promote <candidate-id>"];
  const candidate = state.candidates.find((c) => c.id === id);
  if (!candidate) return [`no candidate with id ${id} — /taste review lists what is waiting`];
  // The approver is recorded in the ledger, which is what makes "a human
  // approved this" a fact on disk rather than an inference — and what lets
  // the promoter accept a candidate its automatic path would refuse.
  const approvedBy = `human:${process.env.USER ?? process.env.LOGNAME ?? "unknown"}`;
  const promoteFn = deps.promoteFn ?? ((c, x, who) => promote(c, x, { approvedBy: who }));
  const result = await promoteFn(candidate, ctx, approvedBy);
  if (result.outcome === "promoted") {
    return [
      `promoted ${candidate.id} as ${candidate.target} (${candidate.scope} scope), approved by ${approvedBy}`,
      `  ${candidate.statement}`,
      `  reverse it with /taste forget ${result.entry?.id ?? candidate.id}`,
    ];
  }
  return [`${candidate.id} was not promoted: ${result.outcome}${result.reason ? ` — ${result.reason}` : ""}`];
}

function selectForForget(view: LedgerView, args: ParsedArgs): PromotionLedgerEntry[] | string {
  if (args.all) {
    const scope = args.scope;
    return view.armed.filter((entry) => scope === undefined || entry.scope === scope);
  }
  const id = args.positional[0];
  if (!id) return "usage: /taste forget <id> | /taste forget --all [--scope project|user]";
  const matches = view.armed.filter((entry) => entry.id === id || entry.candidateId === id);
  if (matches.length === 0) return `nothing armed with id ${id} — /taste shows what is armed`;
  return matches;
}

function forgetPanel(outcomes: readonly ForgetOutcome[]): string[] {
  const removed = outcomes.filter((o) => o.removed).length;
  const lines = [`forget: ${removed} of ${outcomes.length} promotion(s) reversed`];
  for (const outcome of outcomes) {
    const state = outcome.removed ? (outcome.committed ? "removed and committed" : "removed") : "refused";
    lines.push(`  ${outcome.entryId}: ${state}${outcome.reason ? ` — ${outcome.reason}` : ""}`);
  }
  return lines;
}

/** Run one `/taste` invocation and return the panel it should print.
 * Exported so the whole surface is testable without a live session. */
export async function runTasteCommand(args: string, ctx: ExtensionContext, deps: CommandDeps): Promise<string[]> {
  const parsed = parseTasteArgs(args);
  const state = readState(ctx);
  switch (parsed.sub) {
    case "status":
      return statusPanel(ctx, state, deps);
    case "enable":
    case "disable": {
      const enable = parsed.sub === "enable";
      const scope = parsed.user ? "user" : parsed.scope ?? "project";
      let file: string;
      try {
        file = writeScopeOptIn(ctx.cwd, scope, enable);
      } catch (err) {
        // A settings file this command will not touch is a refusal the human
        // has to see and fix, not a fault to record and hide.
        return [err instanceof Error ? err.message : "taste: the settings file could not be written"];
      }
      const effective = resolveTasteConfig(ctx.cwd).enabled;
      const lines = [`taste ${enable ? "enabled" : "disabled"} for the ${scope} scope (${file})`];
      if (enable) lines.push("implementer-class preferences will be applied at the next session start; decision-class ones still wait for /taste review");
      if (effective !== enable) {
        lines.push(`note: a higher-precedence settings layer still resolves enabled=${effective} for this directory`);
      }
      return lines;
    }
    case "review":
      return reviewPanel(state);
    case "promote":
      return runPromote(ctx, state, deps, parsed.positional[0] ?? "");
    case "forget": {
      const selected = selectForForget(state.view, parsed);
      if (typeof selected === "string") return [selected];
      if (selected.length === 0) return ["forget: nothing armed to reverse"];
      const outcomes = forgetPromotions(selected, ctx, {
        candidates: state.candidates,
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...deps.forgetOptions,
      });
      return forgetPanel(outcomes);
    }
    default:
      return [`unknown subcommand ${parsed.sub} — try status, enable, disable, review, promote, forget`];
  }
}

/**
 * Register `/taste`. The panel is delivered as a custom message for the next
 * turn: it is shown to the human without interrupting whatever the agent is
 * doing and without triggering a turn of its own.
 */
export function registerTasteCommand(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand("taste", {
    description: "Inspect and steer the preference learner: status, enable, disable, review, promote, forget",
    handler: async (args, ctx) => {
      let lines: string[];
      try {
        lines = await runTasteCommand(args, ctx, deps);
      } catch (err) {
        deps.record("cmd:/taste", err);
        lines = ["taste: the command failed; the fault is recorded in the health record"];
      }
      pi.sendMessage(
        { customType: "sh.omp.taste.panel", content: lines.join("\n"), display: true },
        { deliverAs: "nextTurn" },
      );
    },
  });
}
