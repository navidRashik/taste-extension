// approval.ts — the tools.approval writer.
//
// A learned approval is the one promotion target that removes a human from
// the loop for every future invocation of a command, so it is gated hardest.
// Three things must hold before an entry lands:
//
//   1. the command's family is on the non-mutating allowlist — a positive
//      list, so absence is refusal, and an irreversible family is refused
//      again explicitly rather than relying on the allowlist's disjointness;
//   2. the entry validates against the rule contract the harness reads;
//   3. the merge into the shared config file is structural — it inserts the
//      entry's lines and touches nothing else, and the write is proven by
//      reading the file back and removing exactly those lines to recover the
//      previous content byte-for-byte.
//
// Any of the three failing throws, and the promoter quarantines: a
// half-applied approval is worse than none.
//
// Where the entry lands: per-command approval is expressed by the ordered
// `bash.patterns` rules of the scoped config file the harness reads at
// launch — project `<cwd>/.omp/config.yml`, user `<agent-dir>/config.yml`.
// The record-shaped `tools.approval` key is keyed by TOOL name, not by
// command, so writing a learned command preference there would auto-approve
// every bash call rather than the one safe family; the ordered per-command
// rules are the surface that expresses what a learned approval means.
//
// New rules are appended to the END of the pattern list. The first matching
// rule wins, so appending guarantees a learned allow can never override a
// deny or prompt the human wrote by hand.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PreferenceCandidate } from "./schema.js";
import { parseChecked } from "./schema.js";
import { allowlistedFamily, approvalGlobFor } from "./allowlist.js";
import { irreversibleFamily } from "./denylist.js";
import { atomicWrite, scopeRoot } from "./writers.js";

/**
 * One ordered command-approval rule as the harness reads it: a literal-plus-
 * `*` glob and the policy that applies when it is the first rule to match.
 */
export interface CommandApprovalRule {
  match: string;
  approval: "allow" | "prompt" | "deny";
}

/**
 * Validate a rule against the contract. A glob must be a non-empty single
 * line — a newline would break out of the YAML scalar and inject arbitrary
 * config keys — and the policy must be one the harness recognises.
 */
export function isCommandApprovalRule(x: unknown): x is CommandApprovalRule {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const rec = x as { [k: string]: unknown };
  if (typeof rec.match !== "string" || rec.match === "" || /[\r\n]/.test(rec.match)) return false;
  return rec.approval === "allow" || rec.approval === "prompt" || rec.approval === "deny";
}

export interface ApprovalWriter {
  write(candidate: PreferenceCandidate, cwd: string, subject: string): string;
}

/** The line insertion a merge performs, kept so the write can be proven reversible. */
interface StructuralMerge {
  next: string;
  at: number;
  inserted: string[];
}

const TOP_LEVEL_BASH_RX = /^bash:/;
const PATTERNS_KEY_RX = /^ {2}patterns:/;
const RULE_CHILD_RX = /^ {4}\S/;

/**
 * Insert one rule into the config text by pure line insertion. Every existing
 * line — including comments, ordering, and unrelated keys — survives
 * untouched because nothing is ever parsed and re-emitted. Returns null when
 * the rule is already present, so a repeated promotion is a no-op rather than
 * a duplicate entry.
 */
export function mergeApprovalRule(prior: string, rule: CommandApprovalRule): StructuralMerge | null {
  const ruleLines = [`    - match: ${JSON.stringify(rule.match)}`, `      approval: ${rule.approval}`];
  const lines = prior === "" ? [] : prior.split("\n");
  if (lines.includes(ruleLines[0])) return null;

  const bashAt = lines.findIndex((l) => TOP_LEVEL_BASH_RX.test(l));
  if (bashAt === -1) {
    // No bash block yet: append one at the end, before any trailing blank.
    const at = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    const inserted = ["bash:", "  patterns:", ...ruleLines];
    const next = [...lines.slice(0, at), ...inserted, ...lines.slice(at)];
    return { next: next.join("\n"), at, inserted };
  }
  if (lines[bashAt].trim() !== "bash:") {
    // An inline value (`bash: {}`) cannot take a nested list without being
    // rewritten, and rewriting is exactly what this merge refuses to do.
    throw new Error("taste approval: unsupported bash config shape");
  }

  // Scan the bash block for its patterns key; a top-level key ends the block.
  let patternsAt = -1;
  for (let i = bashAt + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    if (PATTERNS_KEY_RX.test(lines[i])) {
      patternsAt = i;
      break;
    }
  }
  if (patternsAt === -1) {
    const inserted = ["  patterns:", ...ruleLines];
    const at = bashAt + 1;
    const next = [...lines.slice(0, at), ...inserted, ...lines.slice(at)];
    return { next: next.join("\n"), at, inserted };
  }
  if (lines[patternsAt].trim() !== "patterns:") {
    throw new Error("taste approval: unsupported bash.patterns shape");
  }
  // Append after the last rule already in the list so an existing deny or
  // prompt always matches first.
  let at = patternsAt + 1;
  while (at < lines.length && RULE_CHILD_RX.test(lines[at])) at += 1;
  const next = [...lines.slice(0, at), ...ruleLines, ...lines.slice(at)];
  return { next: next.join("\n"), at, inserted: ruleLines };
}

/**
 * Default approval writer. Refuses any command family that is not explicitly
 * non-mutating, validates the entry, merges it structurally into the scoped
 * config file, and proves the write both ways: the file must read back as
 * written, and removing the inserted lines must recover the previous content
 * exactly. Either proof failing throws, and the promoter quarantines.
 */
export const defaultApprovalWriter: ApprovalWriter = {
  write(candidate, cwd, subject) {
    const family = allowlistedFamily(subject);
    if (!family) {
      throw new Error(`taste approval: command family is not on the non-mutating allowlist: ${subject}`);
    }
    const denied = irreversibleFamily(subject);
    if (denied) {
      throw new Error(`taste approval: irreversible family may never auto-approve: ${denied}`);
    }
    const rule = parseChecked(
      JSON.stringify({ match: approvalGlobFor(family), approval: "allow" }),
      isCommandApprovalRule,
    );
    if (!rule) throw new Error("taste approval: entry failed contract validation");

    const dir = scopeRoot(candidate.scope, cwd);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "config.yml");
    const prior = existsSync(file) ? readFileSync(file, "utf8") : "";
    const merge = mergeApprovalRule(prior, rule);
    if (merge === null) return file;

    atomicWrite(file, merge.next);
    const readBack = readFileSync(file, "utf8");
    if (readBack !== merge.next) throw new Error("taste approval: round-trip mismatch");
    const recovered = readBack.split("\n");
    recovered.splice(merge.at, merge.inserted.length);
    if (recovered.join("\n") !== prior) {
      throw new Error("taste approval: structural merge disturbed the existing config");
    }
    return file;
  },
};
