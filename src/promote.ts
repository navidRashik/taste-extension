// promote.ts — the class-filter, irreversible-action pre-filter, and the
// writer dispatcher that turns an implementer-class candidate into an
// on-disk artefact. Every write is bracketed by the promotion ledger, so
// "was this promotion made, by whom, and where did it write" is a fact on
// disk, never a runtime inference.
//
// The safety spine is one invariant. On the AUTO path (no approvedBy):
//   • the deterministic pre-filter runs FIRST — a candidate whose subject
//     touches an irreversible-action family is coerced to decision-class
//     regardless of what the model labelled it, so a mislabelled `rm` or
//     `git push` can never auto-arm;
//   • the class filter then refuses any non-implementer candidate — scope,
//     behaviour, and commitment candidates take the review-queue path and
//     are never armed without a human approval token.
//
// A human-approved candidate (approvedBy set) may promote through the
// review path; the ledger records the approver so the audit trail proves
// human approval rather than inferring it.
//
// PR4a lands the promoter inert: nothing in the extension entry point calls
// promote() yet. This slice is safely mergeable alone because the writers
// only run when a later slice wires them into session_start.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { PreferenceCandidate, PromotionLedgerEntry, PromotionTarget } from "./schema.js";
import { isPromotionLedgerEntry } from "./schema.js";
import { irreversibleFamily } from "./denylist.js";
import { rollupBuckets, tasteStateDir } from "./rollup.js";
import type { MemoryWriter, RuleWriter, SkillWriter } from "./writers.js";
import { defaultMemoryWriter, defaultRuleWriter, defaultSkillWriter } from "./writers.js";
import type { TtsrRunner } from "./ttsr.js";
import { defaultTtsrRunner } from "./ttsr.js";
import type { ApprovalWriter } from "./approval.js";
import { defaultApprovalWriter } from "./approval.js";
import type { CommitPlan, GitRunner } from "./gitcommit.js";
import { COMMITTED_TARGETS, commitArtefact, defaultGitRunner, preflightAutoCommit } from "./gitcommit.js";

export type PromoteOutcome = "promoted" | "queued" | "quarantined" | "unsupported";

export interface PromoteResult {
  outcome: PromoteOutcome;
  entry?: PromotionLedgerEntry;
  reason?: string;
}

export interface PromoteOptions {
  skillWriter?: SkillWriter;
  memoryWriter?: MemoryWriter;
  ruleWriter?: RuleWriter;
  approvalWriter?: ApprovalWriter;
  ttsr?: TtsrRunner;
  /** Test/DI override for every git invocation the auto-commit path makes. */
  git?: GitRunner;
  now?: number;
  /**
   * Presence marks the human-approved review path. When set:
   *   • the auto pre-filter still runs but only records the family in the
   *     ledger entry — it never re-coerces the class;
   *   • the class filter is bypassed for the classes it otherwise refuses;
   *   • the ledger entry carries the token, so the audit trail proves a
   *     human approved this specific promotion.
   *
   * Presence does NOT bypass the two-sided negative control: a rule-target
   * candidate — auto or approved — still passes positive+negative before it
   * arms. The control is the safety property of the artefact itself, not
   * of the promotion path.
   */
  approvedBy?: string;
  /** Test/DI override for the ledger path; defaults to tasteStateDir(). */
  ledgerFile?: string;
}

/**
 * Writers wired to the promoter. The rule target's arming path adds a
 * two-sided negative control on top of the standard write, so a rule that
 * cannot prove positive AND stay silent on the benign snippet never lands.
 * The approval target adds the non-mutating command allowlist plus contract
 * validation before its entry reaches the shared config file.
 */
const SUPPORTED_TARGETS: Readonly<Record<PromotionTarget, boolean>> = {
  skill: true,
  memory: true,
  rule: true,
  approval: true,
};

/**
 * The subject the pre-filter matches against. A PreferenceCandidate carries
 * signal ids, not the subject string, so the promoter looks the subject up
 * from the in-memory rollup — the same source of truth capture and
 * inference share. Returns "" if the rollup cannot resolve the signal ids
 * (e.g. a fresh process where the accumulator was never loaded).
 */
export function subjectForCandidate(candidate: PreferenceCandidate): string {
  if (candidate.evidence.length === 0) return "";
  const wanted: Record<string, true> = {};
  for (const id of candidate.evidence) wanted[id] = true;
  for (const bucket of rollupBuckets().values()) {
    for (const id of bucket.seenIds) if (wanted[id]) return bucket.subject;
    for (const s of bucket.signals) if (wanted[s.id]) return bucket.subject;
  }
  return "";
}

/**
 * Read the promotion ledger. A malformed row parses to nothing rather than
 * throwing — a corrupt ledger degrades to "no prior promotions" instead of
 * a session-breaking crash.
 */
export function readPromotionLedger(opts: { ledgerFile?: string } = {}): PromotionLedgerEntry[] {
  const file = opts.ledgerFile ?? join(tasteStateDir(), "promotion-ledger.jsonl");
  if (!existsSync(file)) return [];
  const out: PromotionLedgerEntry[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isPromotionLedgerEntry(parsed)) out.push(parsed);
    } catch {
      // one bad row skipped, never the whole file
    }
  }
  return out;
}

/**
 * Append one ledger entry via read → append → write-temp → rename. Peer
 * writers cannot leave a torn file: the rename is the atomic commit, and a
 * crash before rename leaves the previous good ledger intact.
 */
function appendLedgerEntry(entry: PromotionLedgerEntry, ledgerFile: string): void {
  mkdirSync(join(ledgerFile, "..") , { recursive: true });
  const prior = existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8") : "";
  const next = `${prior}${JSON.stringify(entry)}\n`;
  const tmp = `${ledgerFile}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, next);
  renameSync(tmp, ledgerFile);
}

/**
 * Derive a rule condition regex from a fingerprint subject. The subject
 * captures the command family; the regex is a bounded, escaped `\bhead\b`
 * so a well-known argv[0]+subcommand pair matches wherever it appears
 * mid-stream. The two-sided TTSR control proves the derivation empirically
 * for THIS candidate — if the positive fails or the negative fires, the
 * candidate quarantines and no rule arms. An unrecognised subject shape
 * (unknown tool, empty head, non-argv characters) throws so the promoter's
 * fail-closed handler quarantines rather than arming a mystery rule.
 */
export function conditionForSubject(subject: string): string {
  if (!subject.startsWith("bash:")) {
    throw new Error(`taste rule: unsupported subject shape: ${subject}`);
  }
  const head = subject.slice("bash:".length).replace(/\s*\*\s*$/, "").trim();
  if (!head) throw new Error("taste rule: empty subject head");
  if (!/^[A-Za-z0-9 _.:-]+$/.test(head)) {
    throw new Error(`taste rule: unsafe characters in subject head: ${head}`);
  }
  return `\\b${head.replace(/[.\\+*?^$()\[\]{}|]/g, "\\$&")}\\b`;
}

/**
 * Arm one rule candidate. Refuses on missing controls, runs the writer to
 * stage the file, then invokes the two-sided TTSR control: the positive
 * MUST trigger the rule, the negative MUST stay silent, else the staged
 * file is deleted and the throw is caught by promote()'s quarantine
 * handler. A throw from the writer surfaces the same way. The staging file
 * and the armed file share one path because the file is only claimed to be
 * armed once both controls pass — until then it exists but the promoter
 * treats a failed control as "not armed" and cleans up.
 */
async function armRule(
  candidate: PreferenceCandidate,
  ctx: ExtensionContext,
  subject: string,
  writer: RuleWriter,
  ttsr: TtsrRunner,
): Promise<string> {
  const controls = candidate.controls;
  if (!controls || !controls.positive || !controls.negative) {
    throw new Error("taste rule: missing two-sided controls");
  }
  const condition = conditionForSubject(subject);
  const file = writer.write(candidate, ctx.cwd, condition);
  try {
    if (!ttsr.test(file, controls.positive)) {
      throw new Error("taste rule: positive control did not trigger");
    }
    if (ttsr.test(file, controls.negative)) {
      throw new Error("taste rule: negative control fired on benign snippet");
    }
  } catch (controlErr) {
    try {
      // The rule file exists on disk from the writer's atomic write. Delete
      // it so a failed control never leaves a half-armed rule behind for
      // the next session_start to load.
      unlinkSync(file);
    } catch {
      // Best effort; the caller quarantines either way, and the ledger
      // still records the failure so /taste review can surface it.
    }
    throw controlErr;
  }
  return file;
}

/**
 * Promote one candidate. On the auto path the pre-filter runs first and the
 * class filter refuses every non-implementer candidate. The rule target adds
 * a two-sided TTSR negative control on top of the standard write — a rule
 * that lacks either control snippet, whose positive fails to trigger, or
 * whose negative fires on the benign snippet is quarantined, never armed.
 * The approval target adds the non-mutating command allowlist.
 *
 * A project-scope artefact is additionally committed to the repo it was
 * written into, so a learned team convention reaches the team. The
 * repository safety checks run BEFORE the write, so a repository that cannot
 * take a clean single-path commit refuses the promotion with nothing on disk
 * rather than leaving an artefact the team never receives. A directory that
 * is not a repository simply has nothing to publish into and is not a
 * refusal. A user-scope artefact is never committed anywhere.
 *
 * A throw anywhere inside the writer, the control path, or the git write is
 * captured to a quarantine ledger entry rather than propagated — a
 * half-armed artefact is worse than not-armed, and the ledger keeps the
 * failure traceable.
 */
export async function promote(
  candidate: PreferenceCandidate,
  ctx: ExtensionContext,
  opts: PromoteOptions = {},
): Promise<PromoteResult> {
  const now = opts.now ?? Date.now();
  const isAuto = !opts.approvedBy;
  const subject = subjectForCandidate(candidate);
  const irreversible = irreversibleFamily(subject);
  if (isAuto) {
    if (irreversible) {
      // Pre-filter fires ahead of the model's class label. A human may
      // still approve this preference through the review queue in a later
      // slice; the auto path stops here and records the family in the
      // reason so /taste review can show why.
      return { outcome: "queued", reason: `irreversible-family:${irreversible}` };
    }
    if (candidate.class !== "implementer") {
      // Class filter: scope/behaviour/commitment take the review path only.
      return { outcome: "queued", reason: `decision-class:${candidate.class}` };
    }
  }
  if (!SUPPORTED_TARGETS[candidate.target]) {
    return { outcome: "unsupported", reason: `target:${candidate.target}` };
  }
  const ledgerFile = opts.ledgerFile ?? join(tasteStateDir(), "promotion-ledger.jsonl");
  const skillWriter = opts.skillWriter ?? defaultSkillWriter;
  const memoryWriter = opts.memoryWriter ?? defaultMemoryWriter;
  const ruleWriter = opts.ruleWriter ?? defaultRuleWriter;
  const approvalWriter = opts.approvalWriter ?? defaultApprovalWriter;
  const ttsr = opts.ttsr ?? defaultTtsrRunner;
  const git = opts.git ?? defaultGitRunner;
  try {
    // Pre-write ordering: the repository must be provably safe to commit
    // into before a single byte of the artefact is written.
    let plan: CommitPlan | null = null;
    if (candidate.scope === "project" && COMMITTED_TARGETS[candidate.target]) {
      plan = preflightAutoCommit(ctx.cwd, git);
    }
    let path: string;
    if (candidate.target === "skill") {
      path = skillWriter.write(candidate, ctx.cwd);
    } else if (candidate.target === "memory") {
      path = await memoryWriter.write(candidate, ctx, subject);
    } else if (candidate.target === "approval") {
      path = approvalWriter.write(candidate, ctx.cwd, subject);
    } else {
      // rule
      path = await armRule(candidate, ctx, subject, ruleWriter, ttsr);
    }
    if (plan) commitArtefact(plan, ctx.cwd, path, candidate, git);
    const entry: PromotionLedgerEntry = {
      id: `pl_${randomBytes(8).toString("hex")}`,
      candidateId: candidate.id,
      target: candidate.target,
      scope: candidate.scope,
      path,
      at: now,
      ...(opts.approvedBy ? { approvedBy: opts.approvedBy } : {}),
    };
    appendLedgerEntry(entry, ledgerFile);
    return { outcome: "promoted", entry };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "write-failed";
    const quarantine: PromotionLedgerEntry = {
      id: `pl_${randomBytes(8).toString("hex")}`,
      candidateId: candidate.id,
      target: candidate.target,
      scope: candidate.scope,
      path: "",
      at: now,
      quarantined: true,
      quarantineReason: reason,
    };
    try {
      appendLedgerEntry(quarantine, ledgerFile);
    } catch {
      // Ledger append failed too; return the in-memory quarantine so the
      // caller still sees "quarantined" and never treats the promotion as
      // armed.
    }
    return { outcome: "quarantined", entry: quarantine, reason };
  }
}
