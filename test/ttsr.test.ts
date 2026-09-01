import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultTtsrRunner } from "../src/ttsr.js";

let dir: string;
const prevBin = process.env.OMP_BIN;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "taste-ttsr-"));
});

afterEach(() => {
  if (prevBin === undefined) delete process.env.OMP_BIN;
  else process.env.OMP_BIN = prevBin;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Write a fake `omp` shim script that prints one canned JSON payload and exits 0. */
function fakeOmp(json: string): string {
  const script = join(dir, "omp-fake.sh");
  writeFileSync(script, `#!/bin/sh\ncat <<'EOF'\n${json}\nEOF\n`);
  chmodSync(script, 0o755);
  return script;
}

describe("defaultTtsrRunner: parses the `omp ttsr test` --json envelope", () => {
  it("returns true when the JSON reports a non-empty triggered array", () => {
    process.env.OMP_BIN = fakeOmp(`{"triggered":[{"name":"r","path":"/x.md"}],"notTriggered":[]}`);
    expect(defaultTtsrRunner.test("/tmp/rule.md", "npm install recharts")).toBe(true);
  });

  it("returns false when triggered is empty (rule silent — the negative-control success shape)", () => {
    process.env.OMP_BIN = fakeOmp(`{"triggered":[],"notTriggered":[{"name":"r","path":"/x.md"}]}`);
    expect(defaultTtsrRunner.test("/tmp/rule.md", "pnpm add recharts")).toBe(false);
  });

  it("returns false on malformed JSON — a broken runner never claims a rule fired", () => {
    process.env.OMP_BIN = fakeOmp("not-json-at-all");
    expect(defaultTtsrRunner.test("/tmp/rule.md", "anything")).toBe(false);
  });

  it("returns false when the binary is not resolvable — a missing omp degrades to safe-negative", () => {
    process.env.OMP_BIN = join(dir, "does-not-exist");
    expect(defaultTtsrRunner.test("/tmp/rule.md", "anything")).toBe(false);
  });
});
