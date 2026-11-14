import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HostCapabilities, HostDriver, InvocationHandle, InvocationInput, InvocationStopReason } from "../src/host/contracts.js";
import { LoopForgeSupervisor, AutomaticBoundaryUnavailableError } from "../src/supervisor.js";
import type { LoopForgeMcpClient } from "../src/mcp/bridge.js";

const capabilities: HostCapabilities = {
  cleanConversation: true,
  interactiveTransport: true,
  roundMetadataDelivery: true,
  promptDeliveryConfirmation: true,
  hardStop: true,
  workspaceContinuity: true,
  toolResultInterception: true,
  warmHostRuntime: false,
  warmExternalMcp: true,
  providerCacheTelemetry: false,
};

class FakeInvocation implements InvocationHandle {
  readonly invocationId: string;
  readonly sessionId: string;
  readonly pid: number;
  constructor(id: number) {
    this.invocationId = `invocation-${id}`;
    this.sessionId = `session-${id}`;
    this.pid = id;
  }
  write(): void {}
  async *[Symbol.asyncIterator](): AsyncIterator<never> {}
}

class FakeHost implements HostDriver {
  readonly id = "fake";
  readonly starts: InvocationInput[] = [];
  readonly stops: Array<{ invocation: InvocationHandle; reason: InvocationStopReason }> = [];
  private nextId = 1;
  onStop?: () => void;
  constructor(private readonly reported = capabilities) {}
  async probe(): Promise<HostCapabilities> { return this.reported; }
  async startInvocation(input: InvocationInput): Promise<InvocationHandle> {
    this.starts.push(input);
    return new FakeInvocation(this.nextId++);
  }
  async stopInvocation(invocation: InvocationHandle, reason: InvocationStopReason): Promise<void> {
    this.stops.push({ invocation, reason });
    this.onStop?.();
  }
}

class FakeLoopForge implements LoopForgeMcpClient {
  readonly calls: string[] = [];
  readonly arguments: Array<Record<string, unknown>> = [];
  private nextResults: Record<string, unknown>[];
  constructor(results: Record<string, unknown>[]) { this.nextResults = [...results]; }
  async listTools() { return []; }
  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown> & { content: Array<{ type: string; text: string }> }> {
    this.calls.push(name);
    this.arguments.push(args);
    const result = this.nextResults.shift();
    if (!result) throw new Error(`No fake result for ${name}`);
    return result as Record<string, unknown> & { content: Array<{ type: string; text: string }> };
  }
}

const prompt = (text: string, mode: "same_round_retry" | "fresh_invocation") => ({
  content: [
    { type: "text", text },
    { type: "text", text: JSON.stringify({
      contextMode: mode,
      contextReason: "round_boundary",
      sessionId: `session-${text}`,
      loopId: `loop-${text}`,
      submissionHandle: `handle-${text}`,
    }) },
  ],
});

function tempWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "loopforge-supervisor-test-"));
  mkdirSync(path.join(workspace, "project"));
  return run(path.join(workspace, "project")).finally(() => rmSync(workspace, { recursive: true, force: true }));
}

function nextLine(lines: ReturnType<typeof createInterface>): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for bridge output")), 2000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      resolve(line);
    });
  });
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  const closed = once(child, "close").then(() => undefined);
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    await Promise.race([once(killer, "close"), new Promise((resolve) => setTimeout(resolve, 2000))]);
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
}

test("Supervisor starts from LoopForge and delivers exact prompt metadata", async () => tempWorkspace(async (workspace) => {
  const host = new FakeHost();
  const loopforge = new FakeLoopForge([prompt("first", "fresh_invocation")]);
  const supervisor = new LoopForgeSupervisor({ host, loopforge, workspace });
  try {
    const invocation = await supervisor.start({ task: "do work" });
    assert.ok(invocation);
    assert.equal(invocation.invocationId, "invocation-1");
    assert.equal(host.starts[0]?.prompt, "first");
    assert.equal(host.starts[0]?.metadata.submissionHandle, "handle-first");
    assert.deepEqual(loopforge.calls, ["loopforge_start"]);
  } finally {
    await supervisor.stop();
  }
}));

test("Supervisor stops old invocation before fresh replacement and withholds response", async () => tempWorkspace(async (workspace) => {
  const host = new FakeHost();
  const loopforge = new FakeLoopForge([prompt("first", "fresh_invocation"), prompt("replacement", "fresh_invocation")]);
  const supervisor = new LoopForgeSupervisor({ host, loopforge, workspace });
  try {
    await supervisor.start({ task: "do work" });
    const first = await supervisor.handleAgentToolCall("loopforge_next", {});
    assert.equal(first.kind, "handoff");
    if (first.kind === "handoff") {
      assert.equal(first.previousInvocationId, "invocation-1");
      assert.equal(first.replacementInvocationId, "invocation-2");
    }
    assert.deepEqual(host.stops.map((stop) => stop.reason), ["fresh_invocation"]);
    assert.equal(host.starts[1]?.prompt, "replacement");
    assert.equal(supervisor.activeInvocationId, "invocation-2");
  } finally {
    await supervisor.stop();
  }
}));

test("Supervisor keeps same-round retry in the same invocation", async () => tempWorkspace(async (workspace) => {
  const host = new FakeHost();
  const loopforge = new FakeLoopForge([prompt("first", "fresh_invocation"), prompt("retry", "same_round_retry")]);
  const supervisor = new LoopForgeSupervisor({ host, loopforge, workspace });
  try {
    await supervisor.start({ task: "do work" });
    const result = await supervisor.handleAgentToolCall("loopforge_next", {});
    assert.equal(result.kind, "deliver");
    if (result.kind === "deliver") assert.equal(result.invocationId, "invocation-1");
    assert.equal(host.starts.length, 1);
    assert.equal(host.stops.length, 0);
  } finally {
    await supervisor.stop();
  }
}));

test("Supervisor fences queued old calls and waits for an atomic warm handoff", async () => tempWorkspace(async (workspace) => {
  let replaced!: () => void;
  let release!: () => void;
  const replacing = new Promise<void>((resolve) => { replaced = resolve; });
  const proceed = new Promise<void>((resolve) => { release = resolve; });
  class WarmHost extends FakeHost {
    async replaceInvocation(_old: InvocationHandle, input: InvocationInput): Promise<InvocationHandle> {
      replaced();
      await proceed;
      return this.startInvocation(input);
    }
  }
  const host = new WarmHost();
  const loopforge = new FakeLoopForge([prompt("first", "fresh_invocation"), prompt("replacement", "fresh_invocation")]);
  const supervisor = new LoopForgeSupervisor({ host, loopforge, workspace });
  try {
    const old = await supervisor.start({ task: "do work" });
    assert.ok(old);
    const handoff = supervisor.handleAgentToolCall("loopforge_next", {});
    // Captures the old invocation id before the first call enters its queue.
    const stale = supervisor.handleAgentToolCall("loopforge_status", {});
    const staleCheck = assert.rejects(stale, /inactive or stale/);
    await replacing;
    const next = supervisor.nextInvocation(old.invocationId);
    release();
    assert.equal((await handoff).kind, "handoff");
    await staleCheck;
    assert.equal((await next)?.invocationId, "invocation-2");
    assert.deepEqual(loopforge.calls, ["loopforge_start", "loopforge_next"]);
    assert.deepEqual(host.starts[0]?.bridge, host.starts[1]?.bridge);
    assert.equal(host.stops.length, 0);
  } finally { release(); await supervisor.stop(); }
}));

test("Supervisor hard-stops Claude before pausing the current LoopForge session", async () => tempWorkspace(async (workspace) => {
  const host = new FakeHost();
  const loopforge = new FakeLoopForge([
    prompt("first", "fresh_invocation"),
    { content: [{ type: "text", text: "paused" }] },
  ]);
  const supervisor = new LoopForgeSupervisor({ host, loopforge, workspace });
  await supervisor.start({ task: "do work" });
  assert.equal(supervisor.activeLoopIdValue, "loop-first");
  assert.equal(supervisor.activeLoopSessionId, "session-first");

  const result = await supervisor.pause();

  assert.equal(result?.content?.[0]?.text, "paused");
  assert.deepEqual(host.stops.map((stop) => stop.reason), ["user_interrupt"]);
  assert.deepEqual(loopforge.calls, ["loopforge_start", "loopforge_pause"]);
  assert.deepEqual(loopforge.arguments[1], { sessionId: "session-first" });
  assert.equal(supervisor.activeInvocationId, undefined);
  assert.equal(supervisor.activeLoopIdValue, undefined);
}));

test("Supervisor returns a persisted terminal result from resume without starting an Agent", async () => tempWorkspace(async (workspace) => {
  const host = new FakeHost();
  const terminal = {
    content: [{
      type: "text",
      text: JSON.stringify({ ok: true, stopReason: "completed", sessionStatus: "stopped", record: "committed" }),
    }],
  };
  const loopforge = new FakeLoopForge([terminal]);
  const delivered: unknown[] = [];
  const supervisor = new LoopForgeSupervisor({
    host,
    loopforge,
    workspace,
    onTerminalResult: (result) => delivered.push(result),
  });

  const invocation = await supervisor.resume({ loopId: "loop-completed" });

  assert.equal(invocation, undefined);
  assert.deepEqual(loopforge.calls, ["loopforge_resume"]);
  assert.deepEqual(loopforge.arguments[0], { loopId: "loop-completed" });
  assert.equal(host.starts.length, 0);
  assert.equal(delivered.length, 1);
  assert.equal(supervisor.activeInvocationId, undefined);
}));

test("Supervisor drives the real Claude-facing bridge through a fresh handoff", async () => tempWorkspace(async (workspace) => {
  const host = new FakeHost();
  const loopforge = new FakeLoopForge([
    prompt("first", "fresh_invocation"),
    prompt("replacement", "fresh_invocation"),
  ]);
  const supervisor = new LoopForgeSupervisor({ host, loopforge, workspace });
  let child: ChildProcessWithoutNullStreams | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  try {
    await supervisor.start({ task: "do work" });
    const bridge = host.starts[0]?.bridge;
    assert.ok(bridge);
    const bridgePath = bridge.args[0];
    assert.ok(bridgePath);
    child = spawn(process.execPath, [bridgePath], {
      env: { ...process.env, ...bridge.env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    child.stdout.setEncoding("utf8");
    const childLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines = childLines;
    host.onStop = () => { child?.kill(); };
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await nextLine(childLines);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    await nextLine(childLines);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "loopforge_next", arguments: {} } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(host.stops[0]?.reason, "fresh_invocation");
    assert.equal(host.starts[1]?.prompt, "replacement");
    assert.equal(supervisor.activeInvocationId, "invocation-2");
  } finally {
    lines?.close();
    if (child && child.exitCode === null) {
      await terminateChild(child);
    }
    await supervisor.stop();
  }
}));

for (const missing of ["toolResultInterception", "promptDeliveryConfirmation"] as const) test(`Supervisor refuses to mutate LoopForge without ${missing}`, async () => tempWorkspace(async (workspace) => {
  const host = new FakeHost({ ...capabilities, [missing]: false });
  const loopforge = new FakeLoopForge([prompt("must not start", "fresh_invocation")]);
  const supervisor = new LoopForgeSupervisor({ host, loopforge, workspace });
  await assert.rejects(() => supervisor.start({ task: "do work" }), (error: unknown) => {
    assert.ok(error instanceof AutomaticBoundaryUnavailableError);
    assert.deepEqual(error.missing, [missing]);
    return true;
  });
  assert.deepEqual(loopforge.calls, []);
  assert.equal(host.starts.length, 0);
}));

test("Supervisor forwards no LoopForge call while execution is busy and rejects late admissions", async () => tempWorkspace(async (workspace) => {
  const { ClaudeExecutionBoundary } = await import("../src/hosts/claude-execution.js");
  const execution = new ClaudeExecutionBoundary("loopforge-adapter");
  class GuardedHost extends FakeHost {
    beginToolCall(_handle: InvocationHandle, name: string, admission?: string): () => void { return execution.begin(name, admission); }
  }
  const host = new GuardedHost();
  const loopforge = new FakeLoopForge([prompt("first", "fresh_invocation"), prompt("retry", "same_round_retry")]);
  const supervisor = new LoopForgeSupervisor({ host, loopforge, workspace });
  const event = (hook_event_name: string, tool_use_id: string, tool_name: string) => ({ hook_event_name, tool_use_id, tool_name, session_id: "native", cwd: workspace });
  try {
    await supervisor.start({});
    execution.preTool(event("PreToolUse", "work", "mcp__external__slow"));
    const admitted = execution.preTool(event("PreToolUse", "submit", "mcp__loopforge-adapter__loopforge_next")).adapterAdmission as string;
    await assert.rejects(supervisor.handleAgentToolCall("loopforge_next", {}, admitted), /must finish/);
    assert.deepEqual(loopforge.calls, ["loopforge_start"]);
    assert.equal(host.stops.length, 0);
    assert.equal(host.starts.length, 1);
    execution.observe(event("PostToolUse", "work", "mcp__external__slow"));
    const result = await supervisor.handleAgentToolCall("loopforge_next", { evaluation: "untouched" }, admitted);
    assert.equal(result.kind, "deliver");
    assert.deepEqual(loopforge.arguments.at(-1), { evaluation: "untouched" });
    await assert.rejects(supervisor.handleAgentToolCall("loopforge_next", {}, admitted), /no current/);
    await assert.rejects(supervisor.handleAgentToolCall("loopforge_next", {}), /no current/);
    assert.deepEqual(loopforge.calls, ["loopforge_start", "loopforge_next"]);
    assert.equal(host.starts.length, 1);
  } finally { await supervisor.stop(); }
}));
