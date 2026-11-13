import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HostEvent, InvocationHandle, InvocationInput, InvocationStopReason } from "../host/contracts.js";
import type { PtyFactory, PtyProcess, StopProcessTree } from "./claude.js";
import { ClaudeLifecycleServer, type ClaudeHookInput } from "./claude-lifecycle.js";
import { claudeIsolation, exposeClaudeSkills } from "./claude-isolation.js";
import { ClaudeExecutionBoundary } from "./claude-execution.js";

class ClaudeInvocation implements InvocationHandle {
  readonly invocationId = randomUUID();
  private readonly events: HostEvent[] = [];
  private wake: (() => void) | undefined;
  private closed = false;
  private suspended = false;
  constructor(readonly sessionId: string, readonly pid: number, private readonly input: (data: string) => void) {}
  write(data: string): void {
    if (this.closed || this.suspended) throw new Error("Claude invocation has ended or is changing");
    this.input(data);
  }
  suspend(): void { this.suspended = true; }
  push(event: HostEvent): void {
    if (this.closed) return;
    this.events.push(event);
    this.wake?.();
  }
  finish(exitCode: number, reason?: InvocationStopReason): void {
    if (this.closed) return;
    if (reason) this.push({ type: "stopping", reason });
    this.push({ type: "exited", exitCode });
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<HostEvent> {
    while (!this.closed || this.events.length > 0) {
      const event = this.events.shift();
      if (event) { yield event; continue; }
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

interface ExpectedSession {
  source: "startup" | "clear";
  metadata: Record<string, unknown>;
  previousSessionId?: string;
  ended: boolean;
  resolve(invocation: ClaudeInvocation): void;
  reject(error: Error): void;
}

interface ClaudeRuntimeOptions {
  executable: string;
  platform: NodeJS.Platform;
  ptyFactory: PtyFactory;
  stopProcessTree: StopProcessTree;
  timeoutMs: number;
  mcpConfigPath: string | undefined;
  bridgeServerName: string;
  cleanup(): void;
}

function quoteCommand(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return `"${value.replaceAll('"', '""')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** One host process, separate native Claude sessions, no conversation store. */
export class ClaudeRuntime {
  private readonly lifecycle = new ClaudeLifecycleServer();
  private readonly handles = new WeakSet<InvocationHandle>();
  private terminal: PtyProcess | undefined;
  private active: ClaudeInvocation | undefined;
  private expected: ExpectedSession | undefined;
  private workspace = "";
  private directory: string | undefined;
  private exited = false;
  private exitResolve!: () => void;
  private readonly exit = new Promise<void>((resolve) => { this.exitResolve = resolve; });
  private stopping: Promise<void> | undefined;
  private retiring = false;
  private execution: ClaudeExecutionBoundary | undefined;

  constructor(private readonly options: ClaudeRuntimeOptions) {}

  owns(handle: InvocationHandle): boolean { return this.handles.has(handle); }
  isCurrent(handle: InvocationHandle): boolean { return handle === this.active; }

  beginToolCall(name: string, admission?: string): () => void {
    if (this.expected || this.retiring || this.exited || !this.execution) throw new Error("Claude invocation is inactive");
    return this.execution.begin(name, admission);
  }

  assertReplacement(handle: InvocationHandle, input: InvocationInput): void {
    if (handle !== this.active || this.expected || this.exited || this.retiring) throw new Error("Claude invocation cannot be replaced");
    if (path.resolve(input.workspace) !== this.workspace) throw new Error("Claude runtime cannot change workspace");
    if (!this.execution?.canReplace()) throw new Error("Claude execution has not drained before replacement");
  }

  async start(input: InvocationInput): Promise<InvocationHandle> {
    this.workspace = path.resolve(input.workspace);
    try {
      const isolation = claudeIsolation(this.workspace, input.env);
      const endpoint = await this.lifecycle.listen((event) => this.hook(event));
      this.directory = mkdtempSync(path.join(os.tmpdir(), "loopforge-claude-runtime-"));
      const settings = path.join(this.directory, "settings.json");
      const hookPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "claude-hook.js");
      const command = `${quoteCommand(process.execPath, this.options.platform)} ${quoteCommand(hookPath, this.options.platform)}`;
      const hook = { type: "command", command, timeout: 10, onFailure: "block" };
      writeFileSync(settings, JSON.stringify({ ...isolation.settings, hooks: {
        SessionStart: [{ hooks: [hook] }], SessionEnd: [{ hooks: [hook] }],
        PreToolUse: [{ hooks: [hook] }], UserPromptSubmit: [{ hooks: [hook] }],
        PostToolUse: [{ hooks: [hook] }], PostToolUseFailure: [{ hooks: [hook] }], PermissionDenied: [{ hooks: [hook] }],
        SubagentStart: [{ hooks: [hook] }], SubagentStop: [{ hooks: [hook] }],
      } }), { mode: 0o600 });
      const ready = this.expect("startup", input.metadata);
      const args = ["--session-id", randomUUID(), "--settings", settings, "--setting-sources", "", "--strict-mcp-config", "--disallowedTools=Monitor,CronCreate"];
      const skills = exposeClaudeSkills(this.directory, this.workspace, isolation.env, isolation.pluginIds);
      for (const skillPlugin of skills) args.push(`--plugin-dir=${skillPlugin}`);
      if (this.options.mcpConfigPath) args.push(`--mcp-config=${this.options.mcpConfigPath}`);
      args.push(input.prompt);
      this.terminal = this.options.ptyFactory(this.options.executable, args, {
        name: "xterm-256color", cols: 120, rows: 40, cwd: this.workspace,
        env: { ...isolation.env, LOOPFORGE_CLAUDE_HOOK_ENDPOINT: endpoint.address, LOOPFORGE_CLAUDE_HOOK_TOKEN: endpoint.token },
        ...(this.options.platform === "win32" ? { useConpty: true } : {}),
      });
      this.terminal.onData((data) => this.active?.push({ type: "output", data }));
      this.terminal.onExit(({ exitCode }) => {
        this.exited = true;
        this.expected?.reject(new Error("Claude process exited before session confirmation"));
        this.active?.finish(exitCode);
        this.exitResolve();
      });
      return await ready;
    } catch (error) {
      await this.stop("adapter_error");
      throw error;
    }
  }

  async replace(handle: InvocationHandle, input: InvocationInput): Promise<InvocationHandle> {
    this.assertReplacement(handle, input);
    const old = this.active!;
    old.suspend();
    const ready = this.expect("clear", input.metadata, old.sessionId);
    // These short input-delivery gaps are not evidence of a reset. Only the
    // matching SessionEnd(clear) + SessionStart(clear, new id) authorize it.
    this.terminal!.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 100));
    this.terminal!.write("/clear");
    await new Promise((resolve) => setTimeout(resolve, 100));
    this.terminal!.write("\r");
    const next = await ready;
    old.finish(0, "fresh_invocation");
    next.push({ type: "diagnostic", message: `Reused Claude process ${next.pid}; confirmed a new session ${next.sessionId}.` });
    this.terminal!.write(`\u001b[200~${input.prompt}\u001b[201~`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    this.terminal!.write("\r");
    return next;
  }

  report(message: string): void { this.active?.push({ type: "diagnostic", message }); }

  stop(reason: InvocationStopReason): Promise<void> {
    this.stopping ??= this.stopRuntime(reason).catch((error: unknown) => { this.stopping = undefined; throw error; });
    return this.stopping;
  }

  private async stopRuntime(reason: InvocationStopReason): Promise<void> {
    this.retiring = true;
    this.active?.push({ type: "stopping", reason });
    this.expected?.reject(new Error("Claude runtime stopped"));
    this.expected = undefined;
    const terminal = this.terminal;
    if (terminal && !this.exited) {
      try { await this.options.stopProcessTree(terminal.pid); }
      catch { terminal.kill(); }
      const confirmed = await Promise.race([this.exit.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000))]);
      if (!confirmed) {
        terminal.kill();
        // A missing exit event is not proof the old host is dead. Fail closed;
        // do not start a replacement from a guessed process outcome.
        await this.lifecycle.close();
        throw new Error("Claude process termination could not be confirmed");
      }
    }
    this.active?.finish(0, reason);
    this.active = undefined;
    terminal?.destroy?.();
    terminal?.dispose?.();
    await this.lifecycle.close();
    this.options.cleanup();
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
  }

  private expect(source: "startup" | "clear", metadata: Record<string, unknown>, previousSessionId?: string): Promise<ClaudeInvocation> {
    const promise = new Promise<ClaudeInvocation>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Claude ${source} session confirmation timed out`)), this.options.timeoutMs);
      this.expected = {
        source, metadata, ended: false,
        ...(previousSessionId === undefined ? {} : { previousSessionId }),
        resolve: (invocation) => { clearTimeout(timer); resolve(invocation); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
    });
    // A synchronous spawn failure or a late acknowledgement must not create
    // an unhandled rejection while the driver shuts down.
    void promise.catch(() => undefined);
    return promise;
  }

  private hook(event: ClaudeHookInput): Record<string, unknown> {
    const expected = this.expected;
    const correctWorkspace = path.resolve(event.cwd) === this.workspace;
    if (event.hook_event_name === "SessionEnd") {
      if (expected?.source === "clear" && event.session_id === expected.previousSessionId && event.reason === "clear") expected.ended = true;
      else if (!expected && event.session_id === this.active?.sessionId) {
        this.retiring = true;
        this.active?.suspend();
      }
      return {};
    }
    if (event.hook_event_name === "SessionStart") {
      if (!expected && correctWorkspace && event.source === "compact" && event.session_id === this.active?.sessionId) return {};
      const valid = correctWorkspace && expected && event.source === expected.source &&
        (expected.source === "startup" || (expected.ended && event.session_id !== expected.previousSessionId));
      if (!valid || !this.terminal) return { continue: false, stopReason: "Unexpected Claude session boundary" };
      const invocation = new ClaudeInvocation(event.session_id, this.terminal.pid, (data) => this.terminal!.write(data));
      this.handles.add(invocation);
      this.active = invocation;
      this.execution = new ClaudeExecutionBoundary(this.options.bridgeServerName);
      this.expected = undefined;
      invocation.push({ type: "started", pid: invocation.pid, sessionId: invocation.sessionId });
      expected.resolve(invocation);
      return { hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `LoopForge invocation metadata (transport context; preserve values exactly): ${JSON.stringify(expected.metadata)}`,
      } };
    }
    // Tool cwd may change during a session. Session identity, not tool cwd,
    // owns execution; workspace identity is checked at SessionStart.
    if (!expected && !this.retiring && event.session_id === this.active?.sessionId) {
      if (event.hook_event_name === "PreToolUse") return this.execution!.preTool(event);
      this.execution!.observe(event);
      return {};
    }
    if (event.hook_event_name === "PreToolUse") return { hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "LoopForge invocation is changing or inactive",
    } };
    return { decision: "block", reason: "LoopForge invocation is changing or inactive" };
  }
}
