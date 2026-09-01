// allowlist.ts — the non-mutating command allowlist that gates the
// tools.approval writer.
//
// The class filter and the irreversible pre-filter decide whether a
// preference may auto-promote at all. This list decides something stricter
// and independent: whether a command may become a STANDING auto-approval.
// A learned approval takes a human out of the loop for every future
// invocation of that family, so the gate is a positive list — a family that
// is absent is refused, and refusal is the default. A mutating command
// never becomes a learned auto-approval even when the model labels the
// preference implementer.
//
// Entries are keyed in FINGERPRINT SPACE exactly like the irreversible
// denylist: `bash:<argv[0]>` plus, optionally, one subcommand token; never a
// flag, never an argument literal. Matching is a prefix match on
// `bash:<family> `, which cannot cross argv[0] — the fingerprinter only ever
// absorbs positional arguments of the SAME binary into the head — so the
// prefix widens to more arguments of an allowlisted command and never to a
// different command.

import { subjectOf } from "./fingerprint.js";
import { IRREVERSIBLE_FAMILIES } from "./denylist.js";

/**
 * The allowlist itself. Every entry inspects state and writes nothing: no
 * filesystem mutation, no network egress, no credential or auth state, no
 * package or version publication, no data-plane migration. Anything that
 * changes bytes anywhere is absent by construction, which is why the list is
 * expressed positively — a command earns auto-approval by being on it, never
 * by failing to be on the denylist.
 */
export const NON_MUTATING_FAMILIES: Readonly<Record<string, true>> = {
  // Filesystem and path inspection.
  "bash:ls": true,
  "bash:cat": true,
  "bash:pwd": true,
  "bash:wc": true,
  "bash:head": true,
  "bash:tail": true,
  "bash:file": true,
  "bash:stat": true,
  "bash:tree": true,
  "bash:basename": true,
  "bash:dirname": true,
  "bash:realpath": true,
  // Text inspection over content already on disk.
  "bash:grep": true,
  "bash:rg": true,
  "bash:diff": true,
  "bash:sort": true,
  "bash:uniq": true,
  "bash:find": true,
  "bash:which": true,
  // Read-only git porcelain. Every mutating git subcommand is absent, and
  // the bare `bash:git` family is deliberately NOT an entry: it would prefix-
  // match `bash:git push`, which the well-formedness check below refuses.
  "bash:git status": true,
  "bash:git diff": true,
  "bash:git log": true,
  "bash:git show": true,
  "bash:git blame": true,
};

/**
 * Self-check that every entry is fingerprint-normal and that the allowlist
 * cannot reach an irreversible family. Two failure modes are caught:
 * an entry that no real fingerprint could match (a maintainer wrote a flag
 * or a literal), and an entry whose prefix subsumes a denied family — which
 * would silently auto-approve the very commands the denylist exists to keep
 * behind a human. Called at module load: fail loud, never silently miss.
 */
export function assertAllowlistWellFormed(): void {
  for (const entry of Object.keys(NON_MUTATING_FAMILIES)) {
    if (!entry.startsWith("bash:")) {
      throw new Error(`taste allowlist entry not fingerprint-normal: ${entry}`);
    }
    const body = entry.slice("bash:".length);
    if (body.includes("*")) throw new Error(`taste allowlist entry carries a wildcard: ${entry}`);
    for (const tok of body.split(/\s+/)) {
      if (tok.startsWith("-")) throw new Error(`taste allowlist entry carries a flag: ${entry}`);
    }
    const canonical = subjectOf("bash", { command: `${body} --dry-run` });
    if (!canonical.startsWith(`${entry} `)) {
      throw new Error(`taste allowlist entry not fingerprint-normal: ${entry} → ${canonical}`);
    }
    for (const denied of Object.keys(IRREVERSIBLE_FAMILIES)) {
      if (denied === entry || denied.startsWith(`${entry} `) || entry.startsWith(`${denied} `)) {
        throw new Error(`taste allowlist entry overlaps an irreversible family: ${entry} vs ${denied}`);
      }
    }
  }
}

/**
 * Return the allowlisted family a fingerprint subject belongs to, else
 * undefined. Prefix-matches on `<family> ` (trailing space required), so
 * `bash:lsof *` never matches `bash:ls` and `bash:ls src *` does.
 */
export function allowlistedFamily(subject: string): string | undefined {
  for (const family of Object.keys(NON_MUTATING_FAMILIES)) {
    if (subject === family || subject.startsWith(`${family} `)) return family;
  }
  return undefined;
}

/**
 * Build the bash-pattern glob for an allowlisted family. The glob is derived
 * from the FAMILY, never from the observed subject, so a hostile or
 * argument-laden subject can never widen the rule it produces.
 *
 * `*` is the only wildcard the pattern matcher understands and it has no word
 * boundary, so the two head shapes are globbed differently: a single-token
 * head is suffixed with `" *"` because `"ls*"` would also select `lsof`,
 * while a multi-token head is suffixed with `"*"` directly because argv[0]
 * plus a subcommand already pins the binary and no other command can be
 * reached by extending it. The single-token form therefore covers the family
 * only when it carries arguments; under-approving is the safe error.
 */
export function approvalGlobFor(family: string): string {
  const head = family.slice("bash:".length);
  return head.includes(" ") ? `${head}*` : `${head} *`;
}

// Fail loud at import time on a malformed maintainer edit — an allowlist that
// silently overlaps the denylist is worse than no allowlist at all.
assertAllowlistWellFormed();
