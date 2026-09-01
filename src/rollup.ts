// rollup.ts — the cross-session signal rollup and its JSON accumulator.
//
// Two tiers, one shape:
//   • an in-process `globalThis` map keyed by (scopeHint, repo, subject),
//     touched O(1) on every observed signal — the hot cache for a running
//     session, shared across every ctx and every subagent in the same process;
//   • a JSON file on disk, mutated by acquire-lock → read-existing → merge →
//     write-temp → rename → release-lock, so two sessions stopping at once
//     merge their contributions rather than clobber one, and a crash between
//     temp write and rename leaves the previous good file intact for the next
//     read to parse.
//
// Per-event capture never touches the file: rollupTouch updates only the
// in-memory globalThis cache. The on-disk accumulator is flushed exactly
// once per session, at session_stop, after pending-accept finalisation has
// banked its last signal. The cache is seeded from disk at session_start
// via ensureLoaded so a fresh session sees what prior sessions banked.
//
// The rollup is bounded: signals per bucket are capped at MAX_PER_BUCKET (a
// ring keeping the most recent), buckets untouched beyond RETENTION_MS are
// dropped at flush time, and the surviving occurrence count is preserved
// through that compaction so recurrence is never silently reset. Occurrence
// counting dedupes by signal id, so a replayed signal counts once.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_PER_BUCKET = 32; // ring size per subject bucket
const MAX_SEEN_IDS = 1024; // ring size for id dedupe per bucket
const MAX_BUCKETS = 4096; // hard cap on total buckets in memory or on disk
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // drop untouched buckets after 30 days
const LOCK_ATTEMPTS = 40;
const LOCK_BASE_MS = 5;
const STALE_LOCK_MS = 30_000;
const STATE_VERSION = 1;

// A minimal signal projection so the rollup does not import the full schema
// or force capture to depend on this module in the reverse direction.
export interface RollupSignal {
  id: string;
  kind: string;
  strength: number;
  tool?: string; // present when the source signal named a tool, useful to inference
  subject: string;
  // Optional, tightly-bounded evidence: raw (redacted) offending args and the
  // human's correction. These are the only substrings inference needs to build
  // a rule candidate's two-sided controls without inventing text.
  positive?: string;
  correction?: string;
  scopeHint: "project" | "user";
  repo: string;
  at: number;
}

export interface Bucket {
  key: string;
  scopeHint: "project" | "user";
  repo: string;
  subject: string;
  count: number; // total unique signal ids ever seen for this bucket
  signals: RollupSignal[]; // most recent MAX_PER_BUCKET, oldest first
  seenIds: string[]; // most recent MAX_SEEN_IDS unique ids seen, for dedupe
  lastTouched: number; // epoch ms of most recent touch
}

interface Runtime {
  buckets: Map<string, Bucket>;
  loaded: boolean; // seeded from disk?
  stateDir: string | null;
}

const G = globalThis as { __ompTasteRollup?: Runtime };
const R: Runtime = (G.__ompTasteRollup ??= { buckets: new Map(), loaded: false, stateDir: null });

/** Build the per-axis bucket key. Project counts within (subject, repo);
 * user counts within (subject) across repos. Both live in one map, keyed
 * disjointly by their scope prefix so cross-scope collision is impossible.
 * Exported so capture and inference agree on the axis without a second copy. */
export function bucketKeyOf(scopeHint: "project" | "user", repo: string, subject: string): string {
  return scopeHint === "project" ? `p|${repo}|${subject}` : `u||${subject}`;
}

/** Test-only: relocate the accumulator to a hermetic dir and drop cache. */
export function __setTasteStateDir(dir: string | null): void {
  R.stateDir = dir;
  R.buckets.clear();
  R.loaded = false;
}
export function __rollupSnapshot(): Bucket[] {
  return [...R.buckets.values()];
}

/** Read-only view of the in-memory bucket map. Consumers (inference) call
 * ensureLoaded first so a fresh process sees the on-disk state before iterating. */
export function rollupBuckets(): ReadonlyMap<string, Bucket> {
  return R.buckets;
}

/** Resolve the on-disk accumulator directory the current process uses. Kept
 * as one call site so inference and rollup agree on where taste state lives. */
export function tasteStateDir(): string {
  return R.stateDir ?? join(process.env.OMP_TASTE_HOME ?? homedir(), ".omp", "agent", "taste");
}

/** Acquire an exclusive lock by creating <file>.lock with 'wx'. Retries with
 * bounded jittered backoff. Stale locks older than STALE_LOCK_MS are broken
 * to survive a crash that never cleared its lock. */
async function acquireLock(file: string): Promise<() => void> {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  for (let i = 0; i < LOCK_ATTEMPTS; i++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      return () => {
        try {
          rmSync(lock, { force: true });
        } catch {
          /* release is best-effort */
        }
      };
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { force: true });
      } catch {
        /* the lock vanished under us; loop and try again */
      }
      const wait = LOCK_BASE_MS + Math.floor(Math.random() * LOCK_BASE_MS * (i + 1));
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, wait);
      await promise;
    }
  }
  throw new Error("taste rollup: could not acquire accumulator lock");
}

function trimRing<T>(arr: T[], cap: number): void {
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

/** Touch the in-memory rollup with one signal. Dedupes by id — a replayed
 * id is counted at most once. Never throws; a memory-pressure fault must not
 * escape into the capture path and cascade into the session. */
export function rollupTouch(sig: RollupSignal): void {
  try {
    const key = bucketKeyOf(sig.scopeHint, sig.repo, sig.subject);
    let b = R.buckets.get(key);
    if (!b) {
      if (R.buckets.size >= MAX_BUCKETS) {
        let oldestKey: string | null = null;
        let oldestAt = Infinity;
        for (const [k, x] of R.buckets)
          if (x.lastTouched < oldestAt) {
            oldestAt = x.lastTouched;
            oldestKey = k;
          }
        if (oldestKey !== null) R.buckets.delete(oldestKey);
      }
      b = {
        key,
        scopeHint: sig.scopeHint,
        repo: sig.repo,
        subject: sig.subject,
        count: 0,
        signals: [],
        seenIds: [],
        lastTouched: sig.at,
      };
      R.buckets.set(key, b);
    }
    if (b.seenIds.includes(sig.id)) return; // id-based dedupe: replay is a noop
    b.seenIds.push(sig.id);
    trimRing(b.seenIds, MAX_SEEN_IDS);
    b.signals.push(sig);
    trimRing(b.signals, MAX_PER_BUCKET);
    b.count += 1;
    b.lastTouched = sig.at || Date.now();
  } catch {
    /* best-effort cache: swallow rather than break the session */
  }
}

/** Merge two same-key buckets: union of seen ids drives the count so that
 * two peer sessions touching the same signal id once each still count it
 * once; signals are the most-recent union across both sides. */
function mergeBucket(a: Bucket, b: Bucket): Bucket {
  const seen = new Set(a.seenIds);
  const merged: Bucket = {
    key: a.key,
    scopeHint: a.scopeHint,
    repo: a.repo,
    subject: a.subject,
    count: a.count,
    signals: [...a.signals],
    seenIds: [...a.seenIds],
    lastTouched: Math.max(a.lastTouched, b.lastTouched),
  };
  for (const id of b.seenIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    merged.seenIds.push(id);
    merged.count += 1;
  }
  const known = new Set(a.signals.map((s) => s.id));
  for (const s of b.signals)
    if (!known.has(s.id)) {
      merged.signals.push(s);
      known.add(s.id);
    }
  merged.signals.sort((x, y) => x.at - y.at);
  trimRing(merged.signals, MAX_PER_BUCKET);
  trimRing(merged.seenIds, MAX_SEEN_IDS);
  return merged;
}

function isBucket(x: unknown): x is Bucket {
  if (typeof x !== "object" || x === null) return false;
  const b = x as Record<string, unknown>;
  return (
    typeof b.key === "string" &&
    (b.scopeHint === "project" || b.scopeHint === "user") &&
    typeof b.repo === "string" &&
    typeof b.subject === "string" &&
    typeof b.count === "number" &&
    Array.isArray(b.signals) &&
    Array.isArray(b.seenIds) &&
    typeof b.lastTouched === "number"
  );
}

function readAccumulator(file: string): Map<string, Bucket> {
  const out = new Map<string, Bucket>();
  if (!existsSync(file)) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return out; // unreadable or malformed contributes nothing rather than throwing
  }
  if (typeof parsed !== "object" || parsed === null) return out;
  const p = parsed as Record<string, unknown>;
  if (p.version !== STATE_VERSION || !Array.isArray(p.buckets)) return out;
  for (const b of p.buckets) if (isBucket(b)) out.set(b.key, b);
  return out;
}

/** Flush the in-memory rollup into the accumulator. Acquires the lock,
 * re-reads the prior contents so a peer session's writes are preserved,
 * merges bucket-by-bucket, writes to a temp file, then renames — the rename
 * is the atomic commit. A crash before rename leaves the prior good file. */
export async function flushAccumulator(): Promise<void> {
  const file = join(tasteStateDir(), "state.json");
  const release = await acquireLock(file);
  try {
    const disk = readAccumulator(file);
    for (const [k, mem] of R.buckets) {
      const prior = disk.get(k);
      disk.set(k, prior ? mergeBucket(prior, mem) : { ...mem, signals: [...mem.signals], seenIds: [...mem.seenIds] });
    }
    // Drop buckets untouched beyond RETENTION_MS. Compaction preserves the
    // surviving occurrence count on every remaining bucket — the count only
    // resets when a whole bucket is dropped.
    const now = Date.now();
    for (const [k, b] of disk) if (now - b.lastTouched > RETENTION_MS) disk.delete(k);
    if (disk.size > MAX_BUCKETS) {
      const sorted = [...disk.entries()].sort((a, b) => a[1].lastTouched - b[1].lastTouched);
      for (let i = 0; i < sorted.length - MAX_BUCKETS; i++) disk.delete(sorted[i][0]);
    }
    const payload = { version: STATE_VERSION, buckets: [...disk.values()] };
    const tmp = `${file}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, file);
    // Rehydrate the in-memory cache to the fully merged view so a subsequent
    // touch sees the same state a next-process read would.
    R.buckets = disk;
    R.loaded = true;
  } finally {
    release();
  }
}

/** Seed the in-memory rollup from disk on demand. Cheap and idempotent; a
 * subsequent touch merges into whatever loaded. */
export function ensureLoaded(): void {
  if (R.loaded) return;
  const file = join(tasteStateDir(), "state.json");
  const disk = readAccumulator(file);
  for (const [k, b] of disk) if (!R.buckets.has(k)) R.buckets.set(k, b);
  R.loaded = true;
}
