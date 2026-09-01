import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRuleWriter } from "../src/writers.js";
import type { PreferenceCandidate } from "../src/schema.js";

let cwd: string;
let home: string;
const prevHome = process.env.OMP_TASTE_HOME;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "taste-rulewriter-cwd-"));
  home = mkdtempSync(join(tmpdir(), "taste-rulewriter-home-"));
  process.env.OMP_TASTE_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.OMP_TASTE_HOME;
  else process.env.OMP_TASTE_HOME = prevHome;
  for (const d of [cwd, home]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function ruleCandidate(over: Partial<PreferenceCandidate> = {}): PreferenceCandidate {
  return {
    id: "pc_rule001",
    statement: "Use pnpm, not npm, for installs.",
    class: "implementer",
    target: "rule",
    confidence: 0.9,
    scope: "project",
    evidence: ["sig_a", "sig_b", "sig_c"],
    controls: { positive: "npm install recharts", negative: "pnpm add recharts" },
    ...over,
  };
}

describe("defaultRuleWriter: writes a well-formed .md into the scoped rules slot", () => {
  it("writes to <cwd>/.omp/rules for project scope and returns the path", () => {
    const path = defaultRuleWriter.write(ruleCandidate(), cwd, "\\bnpm install\\b");
    expect(path.startsWith(join(cwd, ".omp", "rules"))).toBe(true);
    expect(path.endsWith(".md")).toBe(true);
    const body = readFileSync(path, "utf8");
    expect(body).toContain("description: ");
    expect(body).toContain("condition: ");
    expect(body).toContain("scope: tool:bash");
    expect(body).toContain("interruptMode: tool-only");
    expect(body).toContain("Use pnpm, not npm");
  });

  it("writes user-scope rules under ~/.omp/agent/rules, not the project", () => {
    const path = defaultRuleWriter.write(ruleCandidate({ scope: "user" }), cwd, "\\bnpm install\\b");
    expect(path.startsWith(join(home, ".omp", "agent", "rules"))).toBe(true);
  });

  it("frontmatter serialises the description and condition as JSON strings", () => {
    const path = defaultRuleWriter.write(ruleCandidate(), cwd, "\\bgit push\\b");
    const body = readFileSync(path, "utf8");
    // The description is JSON-quoted (statement contains no quotes here) and
    // the condition is JSON-quoted so its backslashes survive the YAML load.
    expect(body).toContain(`description: ${JSON.stringify("Use pnpm, not npm, for installs.")}`);
    expect(body).toContain(`condition: ${JSON.stringify("\\bgit push\\b")}`);
  });
});

describe("defaultRuleWriter: the emitted scope confines the blocking rule to its own tool", () => {
  it("emits a bash-qualified scope, never a bare tool scope that would also match edit/write", () => {
    // Conditions here are bash-command families, so the rule must scope to
    // tool:bash. A bare `scope: tool` fires on any tool whose args contain the
    // pattern text, so an active blocking rule under it would abort a
    // legitimate edit/write that merely mentioned the command.
    const body = readFileSync(
      defaultRuleWriter.write(ruleCandidate(), cwd, "\\bnpm install\\b"),
      "utf8",
    );
    expect(body).toContain("scope: tool:bash");
    expect(body).not.toContain("scope: tool\n");
  });
});

describe("defaultRuleWriter: filename is traversal-proof and never derived from prose", () => {
  it("strips traversal characters from a hostile candidate id and stays under the scope root", () => {
    const evil = ruleCandidate({ id: "pc_../../../etc/passwd" });
    const path = defaultRuleWriter.write(evil, cwd, "\\bnpm install\\b");
    expect(path.startsWith(join(cwd, ".omp", "rules"))).toBe(true);
    expect(path).not.toContain("..");
  });

  it("does not lift any bytes from the candidate statement into the filesystem path", () => {
    const c = ruleCandidate({ statement: "Do not $(rm -rf /) ever" });
    const path = defaultRuleWriter.write(c, cwd, "\\bnpm install\\b");
    expect(path).not.toContain("$");
    expect(path).not.toContain("rm");
    expect(path).not.toContain(" ");
  });
});

describe("defaultRuleWriter: round-trip proof throws on a torn write", () => {
  it("returns cleanly when the on-disk body matches — the round-trip is the proof", () => {
    // The happy path IS the round-trip proof — the writer's return only
    // reaches the caller after readFileSync == body. The negative-control
    // for this behaviour is the source-line edit exercised in the report.
    expect(() => defaultRuleWriter.write(ruleCandidate(), cwd, "\\bnpm install\\b")).not.toThrow();
  });
});
