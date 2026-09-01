import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTasteConfig, clearTasteConfigCache, TASTE_DEFAULTS } from "../src/config.js";

let cwd: string;
let home: string;
const priorHome = process.env.OMP_TASTE_HOME;

function writeLayer(root: string, file: string, taste: unknown): void {
  const dir = join(root, ".omp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify({ taste }));
}

function writeUserLayer(taste: unknown): void {
  const dir = join(home, ".omp", "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ taste }));
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "taste-cwd-"));
  home = mkdtempSync(join(tmpdir(), "taste-home-"));
  process.env.OMP_TASTE_HOME = home;
  clearTasteConfigCache();
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.OMP_TASTE_HOME;
  else process.env.OMP_TASTE_HOME = priorHome;
  clearTasteConfigCache();
});

describe("resolveTasteConfig precedence", () => {
  it("returns defaults when no layer exists", () => {
    expect(resolveTasteConfig(cwd)).toEqual(TASTE_DEFAULTS);
  });

  it("applies the user layer", () => {
    writeUserLayer({ enabled: true, scope: "user" });
    const c = resolveTasteConfig(cwd);
    expect(c.enabled).toBe(true);
    expect(c.scope).toBe("user");
  });

  it("lets project override user", () => {
    writeUserLayer({ enabled: false, scope: "user" });
    writeLayer(cwd, "settings.json", { enabled: true, scope: "project" });
    const c = resolveTasteConfig(cwd);
    expect(c.enabled).toBe(true);
    expect(c.scope).toBe("project");
  });

  it("lets the local override act as a kill switch over project", () => {
    writeLayer(cwd, "settings.json", { enabled: true });
    writeLayer(cwd, "settings.local.json", { enabled: false });
    expect(resolveTasteConfig(cwd).enabled).toBe(false);
  });

  it("ignores a malformed layer and keeps lower layers (fail-open)", () => {
    writeUserLayer({ enabled: true });
    mkdirSync(join(cwd, ".omp"), { recursive: true });
    writeFileSync(join(cwd, ".omp", "settings.json"), "{ this is not json");
    // Malformed project layer contributes nothing; the user layer still wins.
    expect(resolveTasteConfig(cwd).enabled).toBe(true);
  });

  it("ignores unknown fields and wrong-typed values", () => {
    writeLayer(cwd, "settings.json", { enabled: "true", scope: "galaxy", bogus: 1 });
    expect(resolveTasteConfig(cwd)).toEqual(TASTE_DEFAULTS);
  });
});

describe("resolveTasteConfig caching", () => {
  it("returns the same object reference when nothing changed", () => {
    writeLayer(cwd, "settings.json", { enabled: true });
    const a = resolveTasteConfig(cwd);
    const b = resolveTasteConfig(cwd);
    expect(b).toBe(a); // cache hit: identical reference, no re-read
  });

  it("invalidates when a layer file appears", () => {
    const a = resolveTasteConfig(cwd);
    expect(a.enabled).toBe(false);
    writeLayer(cwd, "settings.local.json", { enabled: true });
    const b = resolveTasteConfig(cwd);
    expect(b).not.toBe(a);
    expect(b.enabled).toBe(true);
  });

  it("invalidates when a layer file is removed", () => {
    writeLayer(cwd, "settings.json", { enabled: true });
    expect(resolveTasteConfig(cwd).enabled).toBe(true);
    rmSync(join(cwd, ".omp", "settings.json"));
    expect(resolveTasteConfig(cwd).enabled).toBe(false);
  });

  it("keys on the (mtime,size,inode) tuple, not mtime alone (same-second write)", () => {
    const file = join(cwd, ".omp", "settings.json");
    const pinned = new Date("2020-01-01T00:00:00.000Z");

    writeLayer(cwd, "settings.json", { enabled: false });
    utimesSync(file, pinned, pinned);
    expect(resolveTasteConfig(cwd).enabled).toBe(false);

    // A same-second rewrite: different content (so a different size) with the
    // mtime pinned identical. An mtime-only key would return the stale `false`
    // and strand the mid-session kill switch; the (mtime,size,inode) tuple
    // catches the change and re-reads.
    writeLayer(cwd, "settings.json", { enabled: true });
    utimesSync(file, pinned, pinned);
    expect(resolveTasteConfig(cwd).enabled).toBe(true);
  });
});
