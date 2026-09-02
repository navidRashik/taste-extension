import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { clearTasteConfigCache } from "../src/config.js";
import taste, {
  safely,
  isSubagentSession,
  sessionFileOf,
  __resetTasteRuntime,
  tasteHealth,
} from "../src/index.js";

type Captured = Map<string, (event: unknown, ctx: unknown) => unknown>;

function fakePi(): { pi: ExtensionAPI; handlers: Captured } {
  const handlers: Captured = new Map();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    },
    registerCommand: () => {},
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

function ctxWith(cwd: string, sessionFile: string): ExtensionContext {
  return {
    cwd,
    sessionManager: { getSessionFile: () => sessionFile },
  } as unknown as ExtensionContext;
}

let cwd: string;
let home: string;
const priorHome = process.env.OMP_TASTE_HOME;

function enable(root: string): void {
  const dir = join(root, ".omp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ taste: { enabled: true } }));
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "taste-idx-"));
  home = mkdtempSync(join(tmpdir(), "taste-idxhome-"));
  process.env.OMP_TASTE_HOME = home;
  __resetTasteRuntime();
  clearTasteConfigCache();
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.OMP_TASTE_HOME;
  else process.env.OMP_TASTE_HOME = priorHome;
  __resetTasteRuntime();
  clearTasteConfigCache();
});

describe("taste() registration", () => {
  it("registers every handler in the complete capture set", () => {
    const { pi, handlers } = fakePi();
    taste(pi);
    const expected = [
      "session_start",
      "tool_call",
      "tool_result",
      "turn_end",
      "input",
      "ttsr_triggered",
      "tool_approval_resolved",
      "session_stop",
    ];
    for (const name of expected) expect(handlers.has(name)).toBe(true);
    expect(handlers.size).toBe(expected.length);
  });
});

describe("session file predicate", () => {
  it("reads the session file defensively, empty when unavailable", () => {
    expect(sessionFileOf(null)).toBe("");
    expect(sessionFileOf({})).toBe("");
    expect(sessionFileOf({ sessionManager: {} })).toBe("");
    expect(sessionFileOf(ctxWith("/x", "/s/main.jsonl"))).toBe("/s/main.jsonl");
  });

  it("treats every ctx as main until the main session file is known", () => {
    expect(isSubagentSession(ctxWith(cwd, "/s/omp-task-abc/Worker.jsonl"))).toBe(false);
  });

  it("distinguishes a subagent leaf from the main session once it is known", () => {
    const { pi, handlers } = fakePi();
    taste(pi);
    const mainFile = join(cwd, "main.jsonl");
    // session_start records the main file unconditionally.
    handlers.get("session_start")!({}, ctxWith(cwd, mainFile));
    expect(isSubagentSession(ctxWith(cwd, mainFile))).toBe(false);
    expect(isSubagentSession(ctxWith(cwd, join(cwd, "omp-task-abc", "Worker.jsonl")))).toBe(true);
  });
});

describe("safely gating", () => {
  it("is inert when Taste is disabled for the cwd", async () => {
    let ran = false;
    const wrapped = safely("t", () => {
      ran = true;
    });
    await wrapped({}, ctxWith(cwd, join(cwd, "main.jsonl"))); // no settings -> disabled
    expect(ran).toBe(false);
  });

  it("runs the body when enabled in the main session", async () => {
    enable(cwd);
    let ran = false;
    const wrapped = safely("t", () => {
      ran = true;
    });
    await wrapped({}, ctxWith(cwd, join(cwd, "main.jsonl")));
    expect(ran).toBe(true);
  });

  it("suppresses the body inside a subagent session", async () => {
    enable(cwd);
    const { pi, handlers } = fakePi();
    taste(pi);
    const mainFile = join(cwd, "main.jsonl");
    handlers.get("session_start")!({}, ctxWith(cwd, mainFile)); // establish main
    let ran = false;
    const wrapped = safely("t", () => {
      ran = true;
    });
    await wrapped({}, ctxWith(cwd, join(cwd, "omp-task-abc", "Worker.jsonl")));
    expect(ran).toBe(false);
  });

  it("fails open: a throwing body never rejects", async () => {
    enable(cwd);
    const wrapped = safely("t", () => {
      throw new Error("boom");
    });
    await expect(wrapped({}, ctxWith(cwd, join(cwd, "main.jsonl")))).resolves.toBeUndefined();
  });
});

describe("safely health recording", () => {
  it("records a handler short-circuit into the bounded health record", async () => {
    enable(cwd);
    const wrapped = safely("on:tool_call", () => {
      throw new TypeError("boom  secret\nsecond line");
    });
    await expect(wrapped({}, ctxWith(cwd, join(cwd, "main.jsonl")))).resolves.toBeUndefined();
    const h = tasteHealth();
    expect(h.errors).toBe(1);
    expect(h.recent).toHaveLength(1);
    expect(h.recent[0].handler).toBe("on:tool_call");
    expect(h.recent[0].errorClass).toBe("TypeError");
    // Security: no free-form message is stored, so a token in the error text
    // cannot leak into the record the later flush persists.
    expect(JSON.stringify(h)).not.toContain("secret");
    expect(typeof h.recent[0].timestamp).toBe("number");
  });

  it("records nothing when the body is suppressed, since it never runs", async () => {
    // No enable() -> disabled -> the throwing body is never reached.
    const wrapped = safely("on:tool_call", () => {
      throw new Error("should not run");
    });
    await wrapped({}, ctxWith(cwd, join(cwd, "main.jsonl")));
    expect(tasteHealth().errors).toBe(0);
  });

  it("bounds the recent ring to the cap while the rolling counter keeps every error", async () => {
    enable(cwd);
    const wrapped = safely("on:input", () => {
      throw new Error("x");
    });
    const ctx = ctxWith(cwd, join(cwd, "main.jsonl"));
    for (let i = 0; i < 25; i++) await wrapped({}, ctx);
    const h = tasteHealth();
    expect(h.errors).toBe(25); // rolling counter is unbounded
    expect(h.recent).toHaveLength(20); // ring capped at HEALTH_CAP
  });
});
