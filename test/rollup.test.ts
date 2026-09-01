import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RollupSignal } from "../src/rollup.js";
import {
  __setTasteStateDir,
  __rollupSnapshot,
  bucketKeyOf,
  ensureLoaded,
  flushAccumulator,
  rollupTouch,
} from "../src/rollup.js";

const STATE = (dir: string): string => join(dir, "state.json");

function sig(id: string, subject: string, opts: Partial<RollupSignal> = {}): RollupSignal {
  return {
    id,
    kind: "reject",
    strength: 2,
    subject,
    scopeHint: "project",
    repo: "local:x",
    at: Date.now(),
    ...opts,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "taste-roll-"));
  __setTasteStateDir(dir);
});
afterEach(() => {
  __setTasteStateDir(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("rollup: bucket keying and dedupe", () => {
  it("keys project buckets on (scope, repo, subject) and user buckets on subject alone", () => {
    expect(bucketKeyOf("project", "r1", "bash:npm install *")).toBe("p|r1|bash:npm install *");
    expect(bucketKeyOf("project", "r2", "bash:npm install *")).toBe("p|r2|bash:npm install *");
    expect(bucketKeyOf("user", "r1", "bash:npm install *")).toBe("u||bash:npm install *");
    expect(bucketKeyOf("user", "r2", "bash:npm install *")).toBe("u||bash:npm install *");
  });

  it("dedupes by signal id: replaying the same id three times leaves the count at 1", () => {
    rollupTouch(sig("A", "bash:npm install *"));
    rollupTouch(sig("A", "bash:npm install *"));
    rollupTouch(sig("A", "bash:npm install *"));
    const snap = __rollupSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].count).toBe(1);
    expect(snap[0].signals).toHaveLength(1);
  });

  it("counts distinct ids in the same subject as separate occurrences", () => {
    rollupTouch(sig("A", "bash:npm install *"));
    rollupTouch(sig("B", "bash:npm install *"));
    rollupTouch(sig("C", "bash:npm install *"));
    const [b] = __rollupSnapshot();
    expect(b.count).toBe(3);
    expect(b.signals).toHaveLength(3);
  });
});

describe("rollup: JSON accumulator", () => {
  it("flush writes the JSON file with the in-memory buckets", async () => {
    rollupTouch(sig("A", "bash:git push *"));
    await flushAccumulator();
    expect(existsSync(STATE(dir))).toBe(true);
    const disk = JSON.parse(readFileSync(STATE(dir), "utf8"));
    expect(disk.version).toBe(1);
    expect(disk.buckets).toHaveLength(1);
    expect(disk.buckets[0].subject).toBe("bash:git push *");
    expect(disk.buckets[0].count).toBe(1);
  });

  it("concurrent read-modify-write from two peers MERGES both contributions rather than clobbering", async () => {
    // Peer A writes a bucket, then peer B (fresh in-memory rollup) writes a
    // distinct signal id in the same subject: the merged file must show both.
    rollupTouch(sig("A1", "bash:npm install *"));
    await flushAccumulator();
    __setTasteStateDir(dir); // drop in-memory cache, simulating a fresh peer
    rollupTouch(sig("B1", "bash:npm install *"));
    await flushAccumulator();
    const disk = JSON.parse(readFileSync(STATE(dir), "utf8"));
    expect(disk.buckets).toHaveLength(1);
    expect(disk.buckets[0].count).toBe(2); // both ids counted
    expect(new Set(disk.buckets[0].seenIds)).toEqual(new Set(["A1", "B1"]));
  });

  it("crash mid-write (temp file present, rename never happened) leaves the previous good file intact", async () => {
    // Simulate the crash: pre-populate a good file, drop a stale temp behind
    // it, then a fresh read of the accumulator should ignore the temp.
    rollupTouch(sig("G", "bash:npm install *"));
    await flushAccumulator();
    const good = readFileSync(STATE(dir), "utf8");
    writeFileSync(`${STATE(dir)}.tmp.9999.deadbeef`, "{ this is not valid json");
    __setTasteStateDir(dir);
    ensureLoaded();
    // The accumulator on disk is still the good file, unmodified.
    expect(readFileSync(STATE(dir), "utf8")).toBe(good);
    // And the loaded state reflects the good file, not the corrupt temp.
    const snap = __rollupSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].seenIds).toContain("G");
  });

  it("malformed state.json parses to empty rather than throwing", () => {
    writeFileSync(STATE(dir), "not-json-at-all");
    __setTasteStateDir(dir);
    expect(() => ensureLoaded()).not.toThrow();
    expect(__rollupSnapshot()).toHaveLength(0);
  });
});
