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
  onToolResult,
  onInput,
  onTtsrTriggered,
  onApprovalResolved,
  resetCaptureState,
} from "../src/capture.js";
import type { TasteSignal } from "../src/schema.js";
import { isTasteSignal } from "../src/schema.js";

type Handlers = Map<string, (event: unknown, ctx: unknown) => unknown>;
interface Recorded {
  type: string;
  data: unknown;
}

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
  return {
    cwd,
    sessionManager: { getSessionFile: () => sessionFile },
  } as unknown as ExtensionContext;
}

function enable(root: string): void {
  const dir = join(root, ".omp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ taste: { enabled: true } }));
}

function signals(ledger: Recorded[]): TasteSignal[] {
  return ledger.filter((e) => e.type === SIGNAL_CUSTOM_TYPE && isTasteSignal(e.data)).map((e) => e.data as TasteSignal);
}

let cwd: string;
let home: string;
const priorHome = process.env.OMP_TASTE_HOME;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "taste-cap-"));
  home = mkdtempSync(join(tmpdir(), "taste-caphome-"));
  process.env.OMP_TASTE_HOME = home;
  __resetTasteRuntime();
  clearTasteConfigCache();
  enable(cwd);
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.OMP_TASTE_HOME;
  else process.env.OMP_TASTE_HOME = priorHome;
  __resetTasteRuntime();
  clearTasteConfigCache();
});

describe("capture: edit signal (snapshot store + next-input compare)", () => {
  it("banks nothing at tool_result; emits one strength-3 edit on next input divergence", () => {
    const { pi, ledger } = fakePiWithLedger();
    const ctx = ctxWith(cwd, join(cwd, "main.jsonl"));
    resetCaptureState(ctx);
    const target = join(cwd, "src", "greet.ts");
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(target, "export function greet() { return 'hi'; }\n");
    onToolResult(pi, { type: "tool_result", toolName: "write", input: { path: target } }, ctx);
    expect(signals(ledger)).toHaveLength(0); // snapshot only, no signal yet
    // Human rewrites the file:
    writeFileSync(target, "export function greet() { return 'hello'; }\n");
    onInput(pi, { type: "input", text: "tweaked greet" }, ctx);
    const sigs = signals(ledger);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].kind).toBe("edit");
    expect(sigs[0].strength).toBe(3);
    expect(sigs[0].evidence.before).toContain("'hi'");
    expect(sigs[0].evidence.after).toContain("'hello'");
  });

  it("skips binary files and never snapshots them", () => {
    const { pi, ledger } = fakePiWithLedger();
    const ctx = ctxWith(cwd, join(cwd, "main.jsonl"));
    resetCaptureState(ctx);
    const target = join(cwd, "logo.bin");
    writeFileSync(target, Buffer.from([0, 1, 2, 3, 0, 5, 6]));
    onToolResult(pi, { type: "tool_result", toolName: "write", input: { path: target } }, ctx);
    // Even a "diverging" write shouldn't emit anything on next input.
    writeFileSync(target, Buffer.from([9, 8, 7, 0, 6]));
    onInput(pi, { type: "input", text: "" }, ctx);
    expect(signals(ledger)).toHaveLength(0);
  });
});

describe("capture: reject signals", () => {
  it("ttsr_triggered → reject bound to the last agent action's fingerprint", () => {
    const { pi, ledger } = fakePiWithLedger();
    const ctx = ctxWith(cwd, join(cwd, "main.jsonl"));
    resetCaptureState(ctx);
    onToolCall(pi, { type: "tool_call", toolName: "bash", input: { command: "npm install recharts" } }, ctx);
    onTtsrTriggered(pi, { type: "ttsr_triggered", rules: [{ name: "no-npm" }] }, ctx);
    const sigs = signals(ledger);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].kind).toBe("reject");
    expect(sigs[0].strength).toBe(2);
    expect(sigs[0].subject).toBe("bash:npm install *");
    expect(sigs[0].evidence.rule).toBe("no-npm");
  });

  it("input text correcting a prior action banks exactly one reject with that subject", () => {
    const { pi, ledger } = fakePiWithLedger();
    const ctx = ctxWith(cwd, join(cwd, "main.jsonl"));
    resetCaptureState(ctx);
    onToolCall(pi, { type: "tool_call", toolName: "bash", input: { command: "npm install lodash" } }, ctx);
    onInput(pi, { type: "input", text: "we use pnpm here, not npm" }, ctx);
    const sigs = signals(ledger);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].kind).toBe("reject");
    expect(sigs[0].subject).toBe("bash:npm install *");
    expect(sigs[0].evidence.correction).toContain("pnpm");
  });

  it("a denied tool_approval_resolved banks one reject", () => {
    const { pi, ledger } = fakePiWithLedger();
    const ctx = ctxWith(cwd, join(cwd, "main.jsonl"));
    resetCaptureState(ctx);
    onApprovalResolved(pi, { type: "tool_approval_resolved", toolName: "bash", args: { command: "rm -rf build" }, decision: "denied" }, ctx);
    const sigs = signals(ledger);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].kind).toBe("reject");
    expect(sigs[0].subject).toBe("bash:rm *");
    // An APPROVED resolution never banks anything:
    onApprovalResolved(pi, { type: "tool_approval_resolved", toolName: "bash", args: { command: "ls" }, decision: "approved" }, ctx);
    expect(signals(ledger)).toHaveLength(1);
  });
});

describe("capture: redaction strips secrets before persist", () => {
  it("removes an AWS access key from a correction's evidence text and from the subject", () => {
    const { pi, ledger } = fakePiWithLedger();
    const ctx = ctxWith(cwd, join(cwd, "main.jsonl"));
    resetCaptureState(ctx);
    const secret = "AKIAIOSFODNN7EXAMPLE";
    onToolCall(pi, { type: "tool_call", toolName: "bash", input: { command: `curl -H "auth: ${secret}"` } }, ctx);
    onInput(pi, { type: "input", text: `no, don't ship ${secret}` }, ctx);
    const sigs = signals(ledger);
    expect(sigs).toHaveLength(1);
    const serialized = JSON.stringify(sigs[0]);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("<REDACTED>");
  });
});

describe("capture: subagent suppression via the safely wrapper", () => {
  it("emits zero ledger entries for tool_call/tool_result inside a subagent session", async () => {
    const { pi, handlers, ledger } = fakePiWithLedger();
    taste(pi);
    const mainFile = join(cwd, "main.jsonl");
    // Establish the main session so the subagent predicate has a reference.
    await handlers.get("session_start")!({ type: "session_start" }, ctxWith(cwd, mainFile));
    const subCtx = ctxWith(cwd, join(cwd, "omp-task-abc", "Worker.jsonl"));
    await handlers.get("tool_call")!({ type: "tool_call", toolName: "bash", input: { command: "npm install x" } }, subCtx);
    // A "correction" input inside the subagent must not turn into a signal
    // either, because the wrapper drops the whole handler call.
    await handlers.get("input")!({ type: "input", text: "we use pnpm, not npm" }, subCtx);
    expect(signals(ledger)).toHaveLength(0);
  });
});

describe("capture: fail-open on a throwing handler body", () => {
  it("recording works when the wrapped body throws — the session sees nothing", async () => {
    const { pi, handlers } = fakePiWithLedger();
    // Replace `pi.appendEntry` with one that always throws, then drive a real
    // signal path through the registered handlers via safely(): the throw is
    // swallowed, so the input handler still resolves without rejecting.
    const throwingPi = {
      ...pi,
      appendEntry: () => {
        throw new Error("disk full");
      },
    } as unknown as ExtensionAPI;
    taste(throwingPi);
    const ctx = ctxWith(cwd, join(cwd, "main.jsonl"));
    await handlers.get("session_start")!({ type: "session_start" }, ctx);
    await handlers.get("tool_call")!({ type: "tool_call", toolName: "bash", input: { command: "npm install a" } }, ctx);
    await expect(handlers.get("input")!({ type: "input", text: "no, use pnpm" }, ctx)).resolves.toBeUndefined();
  });
});
