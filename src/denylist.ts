// denylist.ts — the irreversible-action family denylist that runs AHEAD of
// the model's class label.
//
// A candidate whose subject touches one of these families is coerced to
// decision-class on the auto path regardless of what the model labelled it;
// a human may still approve such a preference through the review queue.
//
// Entries are keyed in FINGERPRINT SPACE — the same normalisation capture
// emits — never on a flag-bearing literal. subjectOf() collapses arguments
// to `*` and strips flags, so a family entry never contains flags like
// `-rf` or `--force`. An entry written as `bash:rm -rf` could never match a
// real subject; the well-formed self-check below guards that class of bug.
//
// FAMILY matching, not equality matching. subjectOf() sometimes extends the
// "head" it emits with a bare positional arg (it treats a plain word as a
// subcommand token), so `rm foo` fingerprints to `bash:rm foo *`, not
// `bash:rm *`. Denying a family "in any form" — the spec's phrasing —
// therefore requires a prefix match on `bash:<family> ` (trailing space),
// which subsumes every subject the fingerprinter emits for that argv[0]
// plus subcommand. Prefix match cannot broaden to a different command
// (`bash:rmdir …` does not start with `bash:rm `), so the narrowing is safe.

import { subjectOf } from "./fingerprint.js";

/**
 * The denylist itself. Keys are family heads exactly as they appear in a
 * fingerprint subject — `bash:<argv[0]>` for a single-token command, or
 * `bash:<argv[0]> <subcommand>` when the harness treats the second token
 * as a git-style subcommand. `Record<string, true>` because membership is
 * a static string-keyed lookup with no runtime insertion or iteration
 * semantics; every check is one property read.
 */
export const IRREVERSIBLE_FAMILIES: Readonly<Record<string, true>> = {
  // Filesystem deletion in any form.
  "bash:rm": true,
  "bash:git push": true,
  "bash:git commit": true,
  "bash:git tag": true,
  // Publish family — bytes leave the machine and a package version becomes
  // public; no auto-promoted preference may quietly enable a publish command.
  "bash:npm publish": true,
  "bash:pnpm publish": true,
  "bash:yarn publish": true,
  "bash:cargo publish": true,
  // Credential-write family — mutates auth state the human owns.
  "bash:gh auth": true,
  "bash:aws configure": true,
  "bash:gcloud auth": true,
  "bash:ssh-keygen": true,
  // Migration-write family — irreversible on the data plane.
  "bash:alembic upgrade": true,
  "bash:prisma migrate": true,
  "bash:knex migrate": true,
};

/**
 * Self-check that every entry is fingerprint-normal — no flags, no arg
 * literals, argv[0] plus (optionally) one subcommand token. A malformed
 * entry throws so a maintainer's mistake surfaces before promotion runs.
 * Called at module load: fail loud, never silently miss.
 */
export function assertDenylistWellFormed(): void {
  for (const entry of Object.keys(IRREVERSIBLE_FAMILIES)) {
    if (!entry.startsWith("bash:")) {
      throw new Error(`taste denylist entry not fingerprint-normal: ${entry}`);
    }
    const body = entry.slice("bash:".length);
    if (body.includes("*")) {
      throw new Error(`taste denylist entry carries a wildcard: ${entry}`);
    }
    for (const tok of body.split(/\s+/)) {
      if (tok.startsWith("-")) throw new Error(`taste denylist entry carries a flag: ${entry}`);
    }
    // Every token in the head must survive subjectOf() untouched.
    // Compose a real command that fingerprints to this family and confirm
    // the fingerprinter emits the same head.
    const canonical = subjectOf("bash", { command: `${body} --dry-run` });
    if (!canonical.startsWith(`${entry} `)) {
      throw new Error(`taste denylist entry not fingerprint-normal: ${entry} → ${canonical}`);
    }
  }
}

/**
 * Return the matching family for a fingerprint subject, else undefined.
 * Prefix-matches on `<family> ` (trailing space required) so `bash:rmdir *`
 * never matches `bash:rm` and every genuine `bash:rm …` subject does.
 */
export function irreversibleFamily(subject: string): string | undefined {
  // Two shapes matter: `<family> *` (single-token command with a flag/path
  // arg) and `<family> <extra> *` (fingerprinter absorbed a bare word into
  // the head). The trailing-space prefix subsumes both.
  for (const family of Object.keys(IRREVERSIBLE_FAMILIES)) {
    if (subject === family || subject.startsWith(`${family} `)) return family;
  }
  return undefined;
}

// Fail loud at import time on a malformed maintainer edit — the invariant
// this module guarantees is worthless if a broken entry ships silently.
assertDenylistWellFormed();
