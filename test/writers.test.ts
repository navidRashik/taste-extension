import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { __setTasteStateDir } from "../src/rollup.js";
import { defaultMemoryWriter, defaultSkillWriter } from "../src/writers.js";
import type { PreferenceCandidate } from "../src/schema.js";

let stateDir: string;
let cwd: string;
let home: string;
const prevHome = process.env.OMP_TASTE_HOME;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "taste-writer-state-"));
  cwd = mkdtempSync(join(tmpdir(), "taste-writer-cwd-"));
  home = mkdtempSync(join(tmpdir(), "taste-writer-home-"));
  __setTasteStateDir(stateDir);
  process.env.OMP_TASTE_HOME = home;
});

afterEach(() => {
  __setTasteStateDir(null);
  if (prevHome === undefined) delete process.env.OMP_TASTE_HOME;
  else process.env.OMP_TASTE_HOME = prevHome;
  for (const d of [stateDir, cwd, home]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function candidate(partial: Partial<PreferenceCandidate> = {}): PreferenceCandidate {
  return {
    id: "pc_writer1234",
    statement: "Use pnpm, not npm, for installs in this repo.",
    class: "implementer",
    target: "skill",
    confidence: 0.9,
    scope: "project",
    evidence: ["sig_a", "sig_b"],
    ...partial,
  };
}

// A minimal ExtensionContext shape — the writers only touch .cwd and,
// defensively, .memory. Anything the writer might reach beyond that would
// be a bug we want the test to expose.
function fakeCtx(overrides: Partial<{ cwd: string; memory: unknown }> = {}): ExtensionContext {
  const base = { cwd: overrides.cwd ?? cwd };
  const withMem = "memory" in overrides ? { ...base, memory: overrides.memory } : base;
  return withMem as unknown as ExtensionContext;
}

describe("defaultSkillWriter", () => {
  it("writes a SKILL.md under project .omp/skills and returns the path", () => {
    const path = defaultSkillWriter.write(candidate(), cwd);
    expect(path.startsWith(join(cwd, ".omp", "skills"))).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(0);
    const body = readFileSync(path, "utf8");
    expect(body).toContain("name: taste/taste-pc_writer123");
    expect(body).toContain("scope: project");
    expect(body).toContain("Use pnpm, not npm");
  });

  it("writes user-scope skills under the taste home root, not the project", () => {
    const path = defaultSkillWriter.write(candidate({ scope: "user" }), cwd);
    expect(path.startsWith(join(home, ".omp", "agent", "skills"))).toBe(true);
  });

  it("does not include prose from the candidate in the filesystem path", () => {
    const evil = candidate({ id: "pc_../../../etc/passwd" });
    const path = defaultSkillWriter.write(evil, cwd);
    // slug is sanitised: everything outside [A-Za-z0-9_-] is stripped, and
    // the path stays inside the scope root.
    expect(path.startsWith(join(cwd, ".omp", "skills"))).toBe(true);
    expect(path).not.toContain("..");
  });
});

describe("defaultMemoryWriter", () => {
  it("uses ctx.memory.save when the runtime exposes it", async () => {
    const seen: unknown[] = [];
    const ctx = fakeCtx({ memory: { save: (p: unknown) => { seen.push(p); } } });
    const returned = await defaultMemoryWriter.write(candidate({ target: "memory" }), ctx, "bash:pnpm add *");
    expect(returned).toBe("memory:runtime");
    expect(seen).toHaveLength(1);
  });

  it("falls back to the pending-memories staging path when ctx.memory is absent", async () => {
    const path = await defaultMemoryWriter.write(candidate({ target: "memory" }), fakeCtx(), "bash:pnpm add *");
    expect(path.startsWith(join(stateDir, "pending-memories"))).toBe(true);
    const staged = JSON.parse(readFileSync(path, "utf8"));
    expect(staged.statement).toContain("pnpm");
    expect(staged.subject).toBe("bash:pnpm add *");
  });

  it("falls back to the staging path when ctx.memory.save throws", async () => {
    const ctx = fakeCtx({ memory: { save: () => { throw new Error("backend off"); } } });
    const path = await defaultMemoryWriter.write(candidate({ target: "memory" }), ctx, "bash:pnpm add *");
    expect(path.startsWith(join(stateDir, "pending-memories"))).toBe(true);
  });

  it("falls back when ctx.memory is present but .save is not a function", async () => {
    const ctx = fakeCtx({ memory: { save: "not-a-function" } });
    const path = await defaultMemoryWriter.write(candidate({ target: "memory" }), ctx, "bash:foo *");
    expect(path.startsWith(join(stateDir, "pending-memories"))).toBe(true);
  });
});
