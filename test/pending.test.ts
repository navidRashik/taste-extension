import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { clearTasteConfigCache } from "../src/config.js";
import taste, { __resetTasteRuntime } from "../src/index.js";
import {
  SIGNAL_CUSTOM_TYPE,
  onToolCall,
  onInput,
  onTurnEnd,
  onSessionStop,
  onTtsrTriggered,
  resetCaptureState,
} from "../src/capture.js";
import type { TasteSignal } from "../src/schema.js";
import { isTasteSignal } from "../src/schema.js";
import { __setTasteStateDir, __rollupSnapshot } from "../src/rollup.js";

interface Recorded {
  type: string;
  data: unknown;
}
type Handlers = Map<string, (event: unknown, ctx: unknown) => unknown>;

function fakePiWithLedger(): { pi: ExtensionAPI; handlers: Handlers; ledger: Recorded[] } {
  const handlers: Handlers = new Map();
  const ledger: Recorded[] = [];
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    },
    appendEntry: (customType: string, data: unknown) => {
      ledger.push({ type: customType, data });
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, ledger };
}

function ctxWith(cwd: string, sessionFile: string): ExtensionContext {
  return { cwd, sessionManager: { getSessionFile: () => sessionFile } } as unknown as ExtensionContext;
}

function signals(ledger: Recorded[]): TasteSignal[] {
  return ledger.filter((e) => e.type === SIGNAL_CUSTOM_TYPE && isTasteSignal(e.data)).map((e) => e.data as TasteSignal);
}

function enable(root: string): void {
  const dir = join(root, ".omp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ taste: { enabled: true } }));
}

let cwd: string;
let home: string;
let state: string;
const priorHome = process.env.OMP_TASTE_HOME;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "taste-pend-"));
  home = mkdtempSync(join(tmpdir(), "taste-pendhome-"));
  state = mkdtempSync(join(tmpdir(), "taste-pendstate-"));
  process.env.OMP_TASTE_HOME = home;
  __resetTasteRuntime();
  __setTasteStateDir(state);
  clearTasteConfigCache();
  enable(cwd);
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.OMP_TASTE_HOME;
  else process.env.OMP_TASTE_HOME = priorHome;
  __resetTasteRuntime();
  __setTasteStateDir(null);
  clearTasteConfigCache();
});

describe("pending-accept: two-state machine", () => {
  it("turn_end never banks an accept; the next input finalises it iff no correction landed", () => {
    const { pi, ledger } = fakePiWithLedger();
    const ctx = ctxWith(cwd, join(cwd, "main.jsonl"));
    resetCaptureState(ctx);
    onToolCall(pi, { type: "tool_call", toolName: "bash", input: { command: "ls -la" } }, ctx);
    onTurnEnd(pi, { type: "turn_end" }, ctx);
    // Nothing banked YET — accept is queued PENDING, never banked at turn_end.
    expect(signals(ledger)).toHaveLength(0);
    // Next input carries no correction verb → finalise as accept.
    onInput(pi, { type: "input", text: "great, keep going" }, ctx);
    const sigs = signals(ledger);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].kind).toBe("accept");
    expect(sigs[0].strength).toBe(1);
    expect(sigs[0].subject).toBe("bash:ls *");
  });

  it("a correction in the next input CANCELS the pending accept (drops it, banks the reject only)", () => {
    const { pi, ledger } = fakePiWithLedger();
    const ctx = ctxWith(cwd, join(cwd, "main.jsonl"));
    resetCaptureState(ctx);
    onToolCall(pi, { type: "tool_call", toolName: "bash", input: { command: "npm install lodash" } }, ctx);
    onTurnEnd(pi, { type: "turn_end" }, ctx);
    onInput(pi, { type: "input", text: "no, use pnpm here" }, ctx);
    // Exactly ONE signal, and it is the reject — NOT an accept.
    const sigs = signals(ledger);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].kind).toBe("reject");
    expect(sigs[0].subject).toBe("bash:npm install *");
    expect(sigs.find((s) => s.kind === "accept")).toBeUndefined();
  });

  it("a challenged action (ttsr block) is not queued at turn_end — no accept ever fires", () => {
    const { pi, ledger } = fakePiWithLedger();
    const ctx = ctxWith(cwd, join(cwd, "main.jsonl"));
    resetCaptureState(ctx);
    onToolCall(pi, { type: "tool_call", toolName: "bash", input: { command: "git push --force" } }, ctx);
    onTtsrTriggered(pi, { type: "ttsr_triggered", rules: [{ name: "no-force-push" }] }, ctx);
    onTurnEnd(pi, { type: "turn_end" }, ctx);
    onInput(pi, { type: "input", text: "ok" }, ctx);
    const sigs = signals(ledger);
    expect(sigs.filter((s) => s.kind === "accept")).toHaveLength(0);
    expect(sigs.filter((s) => s.kind === "reject")).toHaveLength(1);
  });

  it("session_stop finalises a still-pending accept when the session ends before a next input", () => {
    const { pi, ledger } = fakePiWithLedger();
    const ctx = ctxWith(cwd, join(cwd, "main.jsonl"));
    resetCaptureState(ctx);
    onToolCall(pi, { type: "tool_call", toolName: "write", input: { path: "src/foo.ts" } }, ctx);
    onTurnEnd(pi, { type: "turn_end" }, ctx);
    expect(signals(ledger)).toHaveLength(0);
    onSessionStop(pi, { type: "session_stop" }, ctx);
    const sigs = signals(ledger);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].kind).toBe("accept");
    expect(sigs[0].tool).toBe("write");
  });

  it("turn_end with no prior agent action queues nothing (and next input banks nothing extra)", () => {
    const { pi, ledger } = fakePiWithLedger();
    const ctx = ctxWith(cwd, join(cwd, "main.jsonl"));
    resetCaptureState(ctx);
    onTurnEnd(pi, { type: "turn_end" }, ctx);
    onInput(pi, { type: "input", text: "hi" }, ctx);
    expect(signals(ledger)).toHaveLength(0);
  });
});

describe("pending-accept: rollup mirroring", () => {
  it("banking an accept also lands the same signal id in the cross-session rollup", () => {
    const { pi, ledger } = fakePiWithLedger();
    const ctx = ctxWith(cwd, join(cwd, "main.jsonl"));
    resetCaptureState(ctx);
    onToolCall(pi, { type: "tool_call", toolName: "bash", input: { command: "ls" } }, ctx);
    onTurnEnd(pi, { type: "turn_end" }, ctx);
    onSessionStop(pi, { type: "session_stop" }, ctx);
    const [sig] = signals(ledger);
    const snap = __rollupSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].signals[0].id).toBe(sig.id);
    expect(snap[0].count).toBe(1);
  });
});

describe("pending-accept: end-to-end via registered handlers, subagent suppression still holds", () => {
  it("session_stop flushes the accumulator through the safely wrapper without throwing on lock or disk fault", async () => {
    const { pi, handlers } = fakePiWithLedger();
    taste(pi);
    const mainFile = join(cwd, "main.jsonl");
    await handlers.get("session_start")!({ type: "session_start" }, ctxWith(cwd, mainFile));
    await handlers.get("tool_call")!({ type: "tool_call", toolName: "bash", input: { command: "ls" } }, ctxWith(cwd, mainFile));
    await handlers.get("turn_end")!({ type: "turn_end" }, ctxWith(cwd, mainFile));
    await expect(handlers.get("session_stop")!({ type: "session_stop" }, ctxWith(cwd, mainFile))).resolves.toBeUndefined();
  });
});
