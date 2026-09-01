// invoker.ts — the production Inferencer, run by spawning an off-thread
// `omp -p --smol` subprocess through the harness's own pi.exec seam.
//
// Rationale: the ExtensionAPI surface has NO in-process completion primitive
// (verified against the vendored types.d.ts: pi.exec is the only invocation
// method available to an extension). pi.exec runs off the interactive
// thread, honours the user-configured smol role, and inherits parent auth
// and environment. The recursion-guard env marker is set ONCE around the
// whole batch by runInference (single-flight there keeps that race-free),
// so this closure only builds args, spawns, and parses. --no-extensions in
// the child argv is the belt to the env-var braces.

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Inferencer, InferenceInput, InferenceOutcome } from "./inference.js";
import type { PreferenceClass, PromotionTarget } from "./schema.js";

const CHILD_TIMEOUT_MS = 15_000;
const CLASSES: Record<string, PreferenceClass> = {
  scope: "scope",
  behaviour: "behaviour",
  behavior: "behaviour",
  commitment: "commitment",
  implementer: "implementer",
};
const TARGETS: Record<string, PromotionTarget> = { skill: "skill", memory: "memory", rule: "rule", approval: "approval" };

function promptFor(input: InferenceInput): string {
  const brief = {
    subject: input.subject,
    scope: input.scope,
    tool: input.tool,
    occurrences: input.totalCount,
    strongEdits: input.strongEditCount,
    correctionSamples: input.recentCorrections,
    offendingSamples: input.recentPositives,
  };
  return [
    "You summarise a cluster of tool-use signals into ONE preference statement.",
    "Reply with a single JSON object and NOTHING ELSE, matching this shape:",
    `{"statement": string, "class": "scope"|"behaviour"|"commitment"|"implementer", "target": "skill"|"memory"|"rule"|"approval", "negativeSnippet"?: string}`,
    "The statement is one crisp English sentence.",
    "Cluster:",
    JSON.stringify(brief),
  ].join("\n");
}

// Try each stdout line as JSON; --mode json emits an event per line and the
// final answer is embedded inside one of them. Also tries the whole payload
// as one JSON object for the plain -p text case.
function parseOutcome(raw: string): InferenceOutcome | null {
  const candidates = [raw, ...raw.split(/\r?\n/)];
  for (const chunk of candidates) {
    const t = chunk.trim();
    if (!t || t[0] !== "{") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const rec = parsed as Record<string, unknown>;
    const statement = typeof rec.statement === "string" ? rec.statement.trim() : "";
    const cls = typeof rec.class === "string" ? CLASSES[rec.class.toLowerCase()] : undefined;
    const tgt = typeof rec.target === "string" ? TARGETS[rec.target.toLowerCase()] : undefined;
    if (!statement || !cls || !tgt) continue;
    const neg = typeof rec.negativeSnippet === "string" ? rec.negativeSnippet : undefined;
    return neg ? { statement, class: cls, target: tgt, negativeSnippet: neg } : { statement, class: cls, target: tgt };
  }
  return null;
}

/** Build the production Inferencer bound to a specific ExtensionAPI. */
export function smolInferencer(pi: ExtensionAPI): Inferencer {
  return async (input) => {
    const args = ["-p", "--smol=default", "--mode", "json", "--no-session", "--no-title", "--no-extensions", "--no-skills", promptFor(input)];
    const options = { timeout: CHILD_TIMEOUT_MS };
    let result;
    try {
      result = await pi.exec("omp", args, options);
    } catch {
      return null;
    }
    if (result.code !== 0 && !result.stdout) return null;
    return parseOutcome(result.stdout);
  };
}
