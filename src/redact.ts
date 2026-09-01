// redact.ts — the single boundary between raw agent/human text and anything
// Taste persists or summarises. Every capture handler pipes its evidence and
// fingerprint inputs through here BEFORE `pi.appendEntry`, so the ledger and
// the accumulator hold no raw secrets.
//
// Two invariants this module underwrites:
//   • redaction runs before persistence: nothing reaches `appendEntry`
//     without first passing through `redact()`;
//   • redaction runs before fingerprinting: `subjectOf` is fed a redacted
//     input, so a token-shaped literal cannot leak as a substring of the
//     subject. No raw secret reaches either the ledger or the subject.
//
// Edit-signal hunks are additionally capped per side (see HUNK_CAP) and
// binary files are skipped entirely — a huge or binary payload never reaches
// disk. The patterns are deliberately conservative: they name the shape of a
// secret (AWS-style AKIA/ASIA key, GitHub-style ghp_ / github_pat_ token, a
// bare JWT triple, a private-key PEM block, or an entropy-heavy hex/base64
// blob >= 24 chars). Missing a real secret degrades privacy; a false positive
// only redacts a harmless string.

export const HUNK_CAP = 4096;

const PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, // GitHub PAT / OAuth
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bsk-[A-Za-z0-9]{20,}\b/g, // OpenAI-style keys
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b[A-Fa-f0-9]{40,}\b/g, // long hex blob (SHA/token-ish)
  /\b[A-Za-z0-9+/]{32,}={0,2}\b/g, // long base64 blob
];

const REDACTED = "<REDACTED>";
export function redact(s: string): string {
  if (!s) return s;
  let out = s;
  for (const rx of PATTERNS) out = out.replace(rx, REDACTED);
  return out;
}

/** True iff any redaction pattern matches somewhere in `s`. */
export function containsSecret(s: string): boolean {
  if (!s) return false;
  for (const rx of PATTERNS) {
    rx.lastIndex = 0;
    if (rx.test(s)) return true;
  }
  return false;
}

/** True for content Taste never diffs or persists as text — null bytes or an
 * excess of high-bit noise. Reject-safe: if in doubt, treat as binary. */
export function isBinary(buf: string): boolean {
  if (buf.length === 0) return false;
  const probe = buf.length > 4096 ? buf.slice(0, 4096) : buf;
  if (probe.indexOf("\u0000") !== -1) return true;
  let bad = 0;
  for (let i = 0; i < probe.length; i++) {
    const c = probe.charCodeAt(i);
    // ASCII printable + common whitespace, or valid non-BMP
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126)) continue;
    if (c >= 0x80) continue;
    bad++;
  }
  return bad / probe.length > 0.3;
}

/** Cap one side of a hunk to HUNK_CAP characters, marking truncation. */
export function capHunk(s: string, cap: number = HUNK_CAP): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + `\n<TRUNCATED ${s.length - cap} chars>`;
}
