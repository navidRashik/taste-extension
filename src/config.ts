// config.ts — the single entry point for "is Taste on, and how, for this cwd".
//
// Scoping mirrors Command Code's two-scope + local-override model, mapped onto
// OMP's own config layering. Precedence, highest first:
//
//   1. <cwd>/.omp/settings.local.json   uncommitted, gitignored — the kill switch
//   2. <cwd>/.omp/settings.json         project: committed, shared with the team
//   3. ~/.omp/agent/settings.json       user: personal habits across all projects
//
// Every read goes through resolveTasteConfig, which caches on the tuple of the
// three files' mtimes: an unchanged tuple returns the cached config without
// touching disk, and any change (edit, create, delete) invalidates it. This is
// the seam the whole learner gates on, so it is fail-open — an unreadable or
// malformed layer contributes nothing rather than throwing.

import { statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TasteConfig {
  /** Master switch. An untouched scope is never auto-enabled (default off). */
  enabled: boolean;
  /** Whether safe implementer-class preferences may auto-promote without a prompt. */
  autoPromote: boolean;
  /** Which scope a learned preference is written to. */
  scope: "project" | "user";
}

export const TASTE_DEFAULTS: TasteConfig = Object.freeze({
  enabled: false,
  autoPromote: false,
  scope: "project",
});

/** A partial config as it may appear in one layer file's `taste` block. */
type PartialConfig = Partial<TasteConfig>;

interface CacheEntry {
  key: string; // the (mtime,size,inode) tuple this config was resolved from
  config: TasteConfig;
}

// Cache is process-wide and keyed by cwd, so every session and subagent in the
// same directory shares one resolution.
const G = globalThis as { __ompTasteConfigCache?: Map<string, CacheEntry> };
const CACHE: Map<string, CacheEntry> = (G.__ompTasteConfigCache ??= new Map());

// The user-config root. Overridable so tests are hermetic and a non-standard
// install can relocate it; defaults to the real home directory.
function homeRoot(): string {
  return process.env.OMP_TASTE_HOME ?? homedir();
}

function layerPaths(cwd: string): [string, string, string] {
  return [
    join(cwd, ".omp", "settings.local.json"),
    join(cwd, ".omp", "settings.json"),
    join(homeRoot(), ".omp", "agent", "settings.json"),
  ];
}

/**
 * A per-layer identity from the (mtime, size, inode) tuple — never mtime alone.
 * One-second mtime granularity would otherwise let a same-second settings write
 * go unnoticed and silently strand the mid-session kill switch. Size
 * catches a same-second content change; inode catches an atomic temp-file
 * replace that reuses the timestamp. "-" when the file is absent/unstatable;
 * order across layers is significant.
 */
function statKey(paths: string[]): string {
  return paths
    .map((p) => {
      try {
        const s = statSync(p);
        return `${s.mtimeMs}:${s.size}:${s.ino}`;
      } catch {
        return "-";
      }
    })
    .join("|");
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Read one layer's `taste` block, keeping only well-typed known fields. */
function readLayer(path: string): PartialConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || !isRecord(parsed.taste)) return {};
  const taste = parsed.taste;
  const out: PartialConfig = {};
  if (typeof taste.enabled === "boolean") out.enabled = taste.enabled;
  if (typeof taste.autoPromote === "boolean") out.autoPromote = taste.autoPromote;
  if (taste.scope === "project" || taste.scope === "user") out.scope = taste.scope;
  return out;
}

/**
 * Resolve the effective Taste config for `cwd`. Layers are merged lowest-to-
 * highest, so a local override wins over project, which wins over user, which
 * wins over the built-in defaults. Cached on the layers' (mtime,size,inode) tuple.
 */
export function resolveTasteConfig(cwd: string): TasteConfig {
  const paths = layerPaths(cwd);
  const key = statKey(paths);
  const cached = CACHE.get(cwd);
  if (cached && cached.key === key) return cached.config;

  // Merge from lowest precedence to highest: user -> project -> local.
  const user = readLayer(paths[2]);
  const project = readLayer(paths[1]);
  const local = readLayer(paths[0]);
  const config: TasteConfig = { ...TASTE_DEFAULTS, ...user, ...project, ...local };

  CACHE.set(cwd, { key, config });
  return config;
}

/** Test-only: drop the resolution cache so a fresh stat tuple is read. */
export function clearTasteConfigCache(): void {
  CACHE.clear();
}
