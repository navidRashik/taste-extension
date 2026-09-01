// writers.ts — skill + memory writers, both behind injectable seams so tests
// swap them for fakes and never touch the real disk or the harness's live
// memory subsystem.
//
// Both targets share one property: a write is only "done" when the artefact
// can be re-read. The promoter's fail-closed contract depends on that
// round-trip — a throw or a missing read-back aborts the promotion before
// it lands in the ledger, so a half-written artefact never claims to be
// armed.
//
// The memory fallback is required, not decorative. `ctx.memory` is a
// fork-docs, optional runtime whose default backend is `off`; when it is
// absent or refuses the write, the memory writer stages the payload as a
// JSON row under the taste-owned pending-memories path so a later slice
// (retain wiring) can pick it up. A memory candidate never disappears
// silently.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { PreferenceCandidate, PreferenceScope } from "./schema.js";
import { tasteStateDir } from "./rollup.js";

export interface SkillWriter {
  write(candidate: PreferenceCandidate, cwd: string): string;
}
export interface MemoryWriter {
  write(candidate: PreferenceCandidate, ctx: ExtensionContext, subjectHint: string): Promise<string>;
}

/** Resolve the scoped root the harness reads at session_start. */
export function scopeRoot(scope: PreferenceScope, cwd: string): string {
  if (scope === "project") return join(cwd, ".omp");
  return join(process.env.OMP_TASTE_HOME ?? homedir(), ".omp", "agent");
}

/** Directory-safe slug derived from the candidate id; never trusts prose. */
function slugOf(candidate: PreferenceCandidate): string {
  const cleaned = candidate.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12);
  return `taste-${cleaned || "pref"}`;
}

/**
 * Build the SKILL.md body. Frontmatter keys mirror the harness's own skill
 * shape so the artefact is indistinguishable from a hand-authored skill at
 * catalog-scan time — that is the whole point: the harness already knows
 * how to load these, application in a later slice adds no new machinery.
 */
function skillBody(candidate: PreferenceCandidate): string {
  return [
    "---",
    `name: taste/${slugOf(candidate)}`,
    `description: ${JSON.stringify(candidate.statement)}`,
    `scope: ${candidate.scope}`,
    "---",
    "",
    `# ${candidate.statement}`,
    "",
    `Learned from ${candidate.evidence.length} observations recurring across sessions.`,
    "",
  ].join("\n");
}

/**
 * Atomic write via write-temp + rename. Two peer writers to the same target
 * cannot leave a half-written file: the rename is the commit, and a crash
 * before rename leaves the previous good file intact.
 */
export function atomicWrite(target: string, content: string): void {
  const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, content);
  renameSync(tmp, target);
}

/**
 * Default skill writer — writes SKILL.md into the scoped skills slot, then
 * re-reads it to prove the artefact is on disk. A round-trip mismatch
 * throws so the promoter's fail-closed handler quarantines rather than
 * ledgering a half-written skill as promoted.
 */
export const defaultSkillWriter: SkillWriter = {
  write(candidate, cwd) {
    const dir = join(scopeRoot(candidate.scope, cwd), "skills", slugOf(candidate));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "SKILL.md");
    const body = skillBody(candidate);
    atomicWrite(file, body);
    const readBack = readFileSync(file, "utf8");
    if (readBack !== body) throw new Error("taste skill: round-trip mismatch");
    return file;
  },
};

/**
 * Attempt ctx.memory.save. Returns a boolean: true iff the fork-docs runtime
 * exposed a callable `memory.save`, accepted the payload, and did not throw.
 * `ctx.memory` is optional, its backend defaults to `off`, and it is absent
 * from the typed ExtensionContext — every access is narrowed with `in` and
 * `typeof` rather than an inline cast, so a wrong-shaped value degrades to
 * `false` (fall through to file staging) instead of a runtime type error.
 */
async function trySaveViaCtxMemory(ctx: unknown, payload: unknown): Promise<boolean> {
  if (typeof ctx !== "object" || ctx === null) return false;
  if (!("memory" in ctx)) return false;
  const mem: unknown = ctx.memory;
  if (typeof mem !== "object" || mem === null) return false;
  if (!("save" in mem)) return false;
  const saver: unknown = mem.save;
  if (typeof saver !== "function") return false;
  try {
    await Promise.resolve(saver.call(mem, payload));
    return true;
  } catch {
    return false;
  }
}

/**
 * Default memory writer — prefers ctx.memory.save when the fork-docs
 * runtime exposes it; falls back to writing a JSON row into the
 * taste-owned pending-memories staging path so a memory candidate is
 * never dropped when the runtime backend is off.
 */
export const defaultMemoryWriter: MemoryWriter = {
  async write(candidate, ctx, subjectHint) {
    const payload = {
      statement: candidate.statement,
      scope: candidate.scope,
      subject: subjectHint,
      candidateId: candidate.id,
    };
    if (await trySaveViaCtxMemory(ctx, payload)) return "memory:runtime";
    const dir = join(tasteStateDir(), "pending-memories");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${candidate.id}.json`);
    atomicWrite(file, JSON.stringify(payload));
    return file;
  },
};

/**
 * A guard rule is armed by writing a `.md` into the scoped rules slot the
 * harness reads at session start; there is no runtime registration API on
 * the ExtensionAPI to bind against. The rule body is the standard TTSR
 * shape — frontmatter (description, condition, scope, interruptMode) plus a
 * body paragraph — so a promoted rule is indistinguishable from a
 * hand-authored one at load time.
 *
 * The writer's fail-closed contract is unchanged from SkillWriter: an atomic
 * write-temp-and-rename is only "done" once the artefact reads back byte-for-
 * byte, and the round-trip mismatch throws so the promoter quarantines
 * rather than ledgering a half-armed guard. The promoter runs the two-sided
 * TTSR negative control BEFORE calling the writer, so a rule whose controls
 * do not prove out never reaches this seam and never lands on disk.
 */
export interface RuleWriter {
  write(candidate: PreferenceCandidate, cwd: string, condition: string): string;
}

/**
 * Build a TTSR rule body. `interruptMode: tool-only` makes the rule active:
 * it stream-matches the agent's own tool args and aborts/steers before the
 * mistaken call runs. `scope: tool:bash` confines the match to the bash tool,
 * because every condition here is a bash-command family; a bare `scope: tool`
 * would also fire on edit/write calls whose content merely contained the
 * pattern text, so a blocking rule under it could abort legitimate edits.
 * What lets an active blocking rule auto-arm at all is the layered gate:
 * the class filter, the irreversible pre-filter, and the two-sided control.
 */
function ruleBody(candidate: PreferenceCandidate, condition: string): string {
  const controls = candidate.controls;
  const positivePreview = controls ? controls.positive.slice(0, 120) : "";
  const negativePreview = controls ? controls.negative.slice(0, 120) : "";
  return [
    "---",
    `description: ${JSON.stringify(candidate.statement)}`,
    `condition: ${JSON.stringify(condition)}`,
    "scope: tool:bash",
    "interruptMode: tool-only",
    "---",
    "",
    `# ${candidate.statement}`,
    "",
    `Learned from ${candidate.evidence.length} recurring corrections.`,
    `Positive control (must trigger): ${JSON.stringify(positivePreview)}.`,
    `Negative control (must stay silent): ${JSON.stringify(negativePreview)}.`,
    "",
  ].join("\n");
}

/**
 * Default rule writer — writes `<slug>.md` into the scoped rules slot, then
 * re-reads it to prove the file is on disk. Filename is derived from the
 * candidate id via the same traversal-proof slug the skill writer uses, so
 * a hostile statement never influences the path.
 */
export const defaultRuleWriter: RuleWriter = {
  write(candidate, cwd, condition) {
    const dir = join(scopeRoot(candidate.scope, cwd), "rules");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${slugOf(candidate)}.md`);
    const body = ruleBody(candidate, condition);
    atomicWrite(file, body);
    const readBack = readFileSync(file, "utf8");
    if (readBack !== body) throw new Error("taste rule: round-trip mismatch");
    return file;
  },
};
