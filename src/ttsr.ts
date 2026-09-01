// ttsr.ts — the two-sided negative-control runner for a staged guard rule.
//
// A guard never seen fire is not a guard: before any rule Taste writes is
// trusted, it must pass a two-sided test on the harness's own rule tester.
//
//   • POSITIVE — the offending snippet from the candidate's backing evidence
//     MUST trigger the rule; a rule that stays silent on its own reason for
//     existing is broken, not a guard.
//   • NEGATIVE — a benign same-family snippet MUST NOT trigger; a rule that
//     fires on legitimate input is a liability, not a safeguard.
//
// Both are shelled out to `omp ttsr test --rule … --source tool --json`,
// which parses the rule file in isolation (no project-rule loading, so the
// staging file's directory is irrelevant). The runner is behind an
// injectable seam so tests never spawn a subprocess and never depend on
// having the omp binary on PATH.

import { spawnSync } from "node:child_process";

export interface TtsrRunner {
  /**
   * Return true iff `omp ttsr test --rule <ruleFile>` reports that the rule
   * TRIGGERED against `snippet`. Non-zero exit codes, malformed JSON, or an
   * unresolvable binary all return false — a runner fault degrades to
   * "rule did not fire", which is safe for the negative check but forces
   * quarantine on the positive check, so a broken runner never arms a rule.
   */
  test(ruleFile: string, snippet: string, tool?: string, path?: string): boolean;
}

/**
 * Default runner — shells out to the installed `omp` binary. Bounded 10s
 * timeout keeps a runaway subprocess from stalling the promotion path.
 * The binary is resolved per call (not at module load) so a test can
 * relocate it via OMP_BIN without needing to reload the module.
 */
export const defaultTtsrRunner: TtsrRunner = {
  test(ruleFile, snippet, tool = "bash", path = ".") {
    const bin = process.env.OMP_BIN ?? "omp";
    let out;
    try {
      out = spawnSync(
        bin,
        [
          "ttsr", "test",
          "--rule", ruleFile,
          "--source", "tool",
          "--tool", tool,
          "--path", path,
          "--json",
          snippet,
        ],
        { encoding: "utf8", timeout: 10_000, maxBuffer: 1 << 20 },
      );
    } catch {
      return false;
    }
    if (out.status !== 0 || !out.stdout) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(out.stdout);
    } catch {
      return false;
    }
    if (typeof parsed !== "object" || parsed === null) return false;
    if (!("triggered" in parsed)) return false;
    const triggered = parsed.triggered;
    return Array.isArray(triggered) && triggered.length > 0;
  },
};
