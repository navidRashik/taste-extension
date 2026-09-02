// forget.ts — the only undo. Reverses a promotion by removing the artefact
// it wrote, publishing that removal the same narrow way the promotion was
// published, and appending a tombstone so the automatic path never re-arms
// what a human deliberately took away.
//
// Reverting the extension does not neutralise what Taste already wrote: a
// promoted skill stays in the catalog, a guard rule stays armed, an approval
// entry stays in effect. Undo therefore has to actually delete the artefact,
// and it has to be safe to run against a ledger that may name any path at
// all. Two rules make it safe:
//
//   • a path is removed only if it resolves inside a scoped root its own
//     ledger row claims — the repo's taste subtree for a project promotion,
//     the user agent directory for a user one, or the profile state root
//     where staged memories live. Anything else is refused untouched, and
//     the refusal is reported rather than swallowed;
//   • the approval target is never deleted as a file. Its artefact is a
//     shared config file a human also writes, so the reversal lifts out
//     exactly the lines the promotion inserted and proves the rest of the
//     file survived, mirroring how they were added.
//
// A project-scope removal is committed, because the deletion would otherwise
// leave the taste subtree dirty and make every later promotion refuse. The
// commit plan is taken BEFORE the deletion, while the subtree is still
// clean. A subtree that was already dirty for reasons of its own is somebody
// else's edit to resolve: the artefact is still removed — undo must work —
// and the unpublished removal is reported rather than silently assumed.

import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { TOMBSTONE_PREFIX } from "./apply.js";
import { allowlistedFamily, approvalGlobFor } from "./allowlist.js";
import { COMMITTED_TARGETS, commitRemoval, defaultGitRunner, preflightAutoCommit, type CommitPlan, type GitRunner } from "./gitcommit.js";
import { subjectForCandidate } from "./promote.js";
import { tasteStateDir } from "./rollup.js";
import type { PreferenceCandidate, PromotionLedgerEntry } from "./schema.js";
import { atomicWrite, scopeRoot } from "./writers.js";

/** The path a memory writer returns when the harness's own memory runtime
 * accepted the save. There is no file to delete in that case. */
const RUNTIME_MEMORY_PATH = "memory:runtime";

export interface ForgetOptions {
  git?: GitRunner;
  ledgerFile?: string;
  now?: number;
  /** Candidates backing the ledger, needed to identify an approval entry's
   * own lines inside the shared config file. */
  candidates?: readonly PreferenceCandidate[];
}

export interface ForgetOutcome {
  entryId: string;
  candidateId: string;
  path: string;
  /** True when the artefact is no longer in effect. */
  removed: boolean;
  /** True when the removal was published to the repository. */
  committed: boolean;
  /** Why the removal was refused, or what still needs attention after it. */
  reason?: string;
}

/** True when `child` is `root` itself or lies beneath it, after resolution. */
function isInside(root: string, child: string): boolean {
  const r = resolve(root);
  const c = resolve(child);
  return c === r || c.startsWith(r + sep);
}

/**
 * Remove one approval rule from config text by pure line removal, the exact
 * inverse of how it was inserted. Returns null when the rule is not present,
 * so a repeated reversal is a no-op rather than a corruption. Nothing is
 * parsed and re-emitted, so every comment, ordering choice, and unrelated
 * key in the file survives.
 */
export function removeApprovalRule(prior: string, glob: string): string | null {
  const lines = prior.split("\n");
  const head = `    - match: ${JSON.stringify(glob)}`;
  const at = lines.indexOf(head);
  if (at === -1) return null;
  // The policy line belongs to this rule only when it is the immediately
  // following child; a rule written without one still removes cleanly.
  const span = /^ {6}approval: /.test(lines[at + 1] ?? "") ? 2 : 1;
  const next = [...lines];
  next.splice(at, span);
  return next.join("\n");
}

/**
 * Identify the config lines an approval promotion inserted. The glob is
 * rebuilt from the candidate's own command family exactly as the writer
 * built it, so a reversal can never remove a rule the promotion did not add.
 * When the candidate is gone the lines cannot be attributed, and the only
 * safe answer is to refuse: guessing which lines of a shared config file to
 * delete is worse than leaving one learned approval in place.
 */
function approvalGlobForEntry(entry: PromotionLedgerEntry, candidates: readonly PreferenceCandidate[]): string {
  const candidate = candidates.find((c) => c.id === entry.candidateId);
  if (!candidate) {
    throw new Error("taste forget: the approval entry's candidate is gone, so its config lines cannot be identified");
  }
  const family = allowlistedFamily(subjectForCandidate(candidate));
  if (!family) {
    throw new Error("taste forget: the approval entry's command family cannot be resolved");
  }
  return approvalGlobFor(family);
}

/**
 * Take one artefact out of effect. A skill or rule file is deleted outright;
 * an approval has its own lines lifted out of the shared config and the
 * result proven by a read-back; a staged memory row is deleted like any
 * other file. A file that is already gone counts as removed, so a
 * half-finished earlier reversal completes rather than jams.
 */
function removeArtefact(entry: PromotionLedgerEntry, target: string, candidates: readonly PreferenceCandidate[]): void {
  if (!existsSync(target)) return;
  if (entry.target === "approval") {
    const prior = readFileSync(target, "utf8");
    const next = removeApprovalRule(prior, approvalGlobForEntry(entry, candidates));
    if (next === null) return; // the learned rule is no longer in the file
    atomicWrite(target, next);
    if (readFileSync(target, "utf8") !== next) throw new Error("taste forget: approval round-trip mismatch");
    return;
  }
  unlinkSync(target);
  // A managed skill owns its directory, so the now-empty directory goes with
  // it. Only a taste-owned directory is ever removed, and only when nothing
  // else is left in it — rmdir refuses a non-empty one.
  const parent = dirname(target);
  if (entry.target === "skill" && basename(parent).startsWith("taste-")) {
    try {
      rmdirSync(parent);
    } catch {
      // Something else lives there; the artefact itself is gone, which is
      // what the reversal promised.
    }
  }
}

/**
 * Append the tombstone that records a reversal. The ledger is append-only,
 * so a reversal is a new row naming the row it undoes rather than an edit of
 * history: "was this promotion reversed, and when" stays a fact on disk, and
 * the automatic path reads it to know never to re-arm that candidate.
 */
function appendTombstone(entry: PromotionLedgerEntry, ledgerFile: string, now: number): void {
  const tombstone: PromotionLedgerEntry = {
    id: `pl_forget_${entry.id}`,
    candidateId: entry.candidateId,
    target: entry.target,
    scope: entry.scope,
    path: "",
    at: now,
    quarantined: true,
    quarantineReason: `${TOMBSTONE_PREFIX}${entry.id}`,
  };
  mkdirSync(dirname(ledgerFile), { recursive: true });
  const prior = existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8") : "";
  atomicWrite(ledgerFile, `${prior}${JSON.stringify(tombstone)}\n`);
}

/**
 * Reverse one promotion. Every refusal is returned rather than thrown, so a
 * bulk reversal keeps going and reports exactly which artefacts are still in
 * effect and why.
 */
export function forgetPromotion(
  entry: PromotionLedgerEntry,
  ctx: ExtensionContext,
  opts: ForgetOptions = {},
): ForgetOutcome {
  const base: ForgetOutcome = {
    entryId: entry.id,
    candidateId: entry.candidateId,
    path: entry.path,
    removed: false,
    committed: false,
  };
  const git = opts.git ?? defaultGitRunner;
  const candidates = opts.candidates ?? [];
  const ledgerFile = opts.ledgerFile ?? join(tasteStateDir(), "promotion-ledger.jsonl");
  const now = opts.now ?? Date.now();
  try {
    if (entry.path === "") return { ...base, reason: "the promotion wrote no artefact" };
    if (entry.path === RUNTIME_MEMORY_PATH) {
      return { ...base, reason: "a memory held by the harness runtime cannot be removed by taste" };
    }
    const target = resolve(entry.path);
    // The scoped roots are the only places a promotion may have written, so
    // they are the only places a reversal may delete from. A ledger row
    // naming anything else is refused with the artefact untouched.
    const roots = [scopeRoot(entry.scope, ctx.cwd), tasteStateDir()];
    if (!roots.some((root) => isInside(root, target))) {
      return { ...base, reason: `path escapes the scoped roots: ${target}` };
    }
    // Take the commit plan while the subtree is still clean. A dirty subtree
    // is someone else's edit: undo still runs, and the removal is reported
    // as unpublished rather than wedging on dirt Taste did not create.
    let plan: CommitPlan | null = null;
    let planNote: string | undefined;
    if (entry.scope === "project" && COMMITTED_TARGETS[entry.target]) {
      try {
        plan = preflightAutoCommit(ctx.cwd, git);
      } catch (err) {
        planNote = `removal not published: ${err instanceof Error ? err.message : "repository refused"}`;
      }
    }
    removeArtefact(entry, target, candidates);
    let committed = false;
    let note = planNote;
    if (plan) {
      try {
        commitRemoval(plan, ctx.cwd, target, entry.id, git);
        committed = true;
      } catch (err) {
        // The artefact is already out of effect, which is what undo
        // promised; the unpublished removal is reported, not hidden.
        note = `removal not published: ${err instanceof Error ? err.message : "commit failed"}`;
      }
    }
    appendTombstone(entry, ledgerFile, now);
    return { ...base, removed: true, committed, reason: note };
  } catch (err) {
    return { ...base, reason: err instanceof Error ? err.message : "forget failed" };
  }
}

/** Reverse several promotions, each inheriting every refusal condition of
 * the single-entry path. */
export function forgetPromotions(
  entries: readonly PromotionLedgerEntry[],
  ctx: ExtensionContext,
  opts: ForgetOptions = {},
): ForgetOutcome[] {
  return entries.map((entry) => forgetPromotion(entry, ctx, opts));
}
