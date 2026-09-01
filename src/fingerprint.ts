// fingerprint.ts — the shared subject fingerprinter.
//
// Recurrence is counted over `subject`; capture emits it and inference
// consumes it. A single owned module keeps both callers honest about the
// same normalisation. Shape:
//
//   <tool>:<normalised-head>
//     bash    → argv[0] plus the first non-flag token, args replaced by `*`
//     file    → <ext-glob>:<construct>  (path extension + a lightweight
//                                        construct token from the payload)
//     other   → tool name alone; every literal collapses to `*`
//
// Two invariants:
//   • fingerprint stability — `npm install recharts` and `npm install lodash`
//     produce the SAME subject `bash:npm install *`, so recurrence counts a
//     family of actions, not a specific literal;
//   • fingerprint is secret-free by construction — the redactor runs before
//     the normaliser, so no substring of a token-shaped literal ever ends up
//     in the subject.

import { redact } from "./redact.js";

const CONSTRUCT_RX = /\b(?:describe|it|test|class|function|def|const|import|from|struct|impl|interface|type)\b/;
const SUBCMD_RX = /^[A-Za-z][A-Za-z0-9_-]*$/;
const EXT_RX = /^[a-z0-9]{1,10}$/;

/** Read a string-typed field from an unknown payload; "" if absent or wrong type. */
export function readStringField(input: unknown, key: string): string {
  if (typeof input !== "object" || input === null) return "";
  if (!(key in input)) return "";
  const v = (input as { [k: string]: unknown })[key];
  return typeof v === "string" ? v : "";
}

/** Build the shared subject string for a captured tool action. */
export function subjectOf(tool: string, input: unknown): string {
  const t = (tool || "").toLowerCase();

  if (t === "bash") {
    const cleaned = redact(readStringField(input, "command")).trim();
    if (!cleaned) return "bash:*";
    // First token is argv[0]; subsequent non-flag alphanumeric tokens up to
    // the first flag form the subcommand chain (`git push`, `npm install`).
    const tokens = cleaned.split(/\s+/);
    const head: string[] = [tokens[0]];
    for (let i = 1; i < tokens.length && head.length < 2; i++) {
      const tok = tokens[i];
      if (tok.startsWith("-") || !SUBCMD_RX.test(tok)) break;
      head.push(tok);
    }
    return `bash:${head.join(" ")} *`;
  }

  if (t === "write" || t === "edit" || t === "apply_patch") {
    const cleanPath = redact(readStringField(input, "path"));
    const dot = cleanPath.lastIndexOf(".");
    const slash = cleanPath.lastIndexOf("/");
    let extPart = "*";
    if (dot > slash && dot !== -1) {
      const ext = cleanPath.slice(dot + 1).toLowerCase();
      if (EXT_RX.test(ext)) extPart = `*.${ext}`;
    }
    const body = [
      readStringField(input, "newText"),
      readStringField(input, "content"),
      readStringField(input, "oldText"),
    ]
      .filter((s) => s.length > 0)
      .join("\n");
    const construct = body ? (redact(body).match(CONSTRUCT_RX)?.[0] ?? "*") : "*";
    return `${t}:${extPart}:${construct}`;
  }

  return `${t}:*`;
}
