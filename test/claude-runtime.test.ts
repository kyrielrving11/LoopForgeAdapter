import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeDriver, type PtyFactory, type PtyProcess } from "../src/hosts/claude.js";
import { callClaudeLifecycleHook, claudePromptHash, type ClaudeHookEndpoint, type ClaudeHookInput } from "../src/hosts/claude-lifecycle.js";

class HookPty implements PtyProcess {
  readonly pid = 4567;
  readonly writes: string[] = [];
  private readonly exits: Array<(event: { exitCode: number }) => void> = [];
  constructor(private readonly onWrite: (data: string) => void) {}
  write(data: string): void { this.writes.push(data); this.onWrite(data); }
  kill(): void { for (const exit of this.exits) exit({ exitCode: 0 }); }
  onData(): { dispose(): void } { return { dispose() {} }; }
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void } { this.exits.push(listener); return { dispose() {} }; }
}

test("native turn end is observable without declaring completion, clearing tools or trusting stale/child events", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "loopforge-turn-end-"));
  let endpoint!: ClaudeHookEndpoint;
  const event = (hook_event_name: string, session_id = "native", rest: Partial<ClaudeHookInput> = {}) => callClaudeLifecycleHook(endpoint,
    { hook_event_name, session_id, cwd: workspace, ...rest });
  const pty = new HookPty(() => {});
  const driver = new ClaudeCodeDriver({ executable: "claude.exe", platform: "win32", lifecycleTimeoutMs: 2000,
    ptyFactory: (_file, args, options) => {
      const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1]!, "utf8"));
      assert.ok(settings.hooks.Stop && settings.hooks.StopFailure);
      endpoint = { address: options.env.LOOPFORGE_CLAUDE_HOOK_ENDPOINT!, token: options.env.LOOPFORGE_CLAUDE_HOOK_TOKEN! };
      setImmediate(() => { void (async () => {
        await event("SessionStart", "native", { source: "startup" });
        await event("Stop"); // Initial delivery has not been confirmed yet.
        await event("UserPromptSubmit", "native", { promptHash: claudePromptHash(args.at(-1)!) });
      })(); });
      return pty;
    }, stopProcessTree: async () => pty.kill(),
  });
  const invocation = await driver.startInvocation({ prompt: "current", metadata: { contextMode: "fresh_invocation", contextReason: "test" }, workspace });
  try {
    await event("PreToolUse", "native", { tool_use_id: "still-running", tool_name: "Read" });
    await event("Stop", "stale");
    await event("Stop", "native", { agent_id: "child" });
    await event("Stop");
    await event("StopFailure");
    // Stop must not erase an in-flight tool merely because the model ended.
    await assert.rejects(driver.replaceInvocation(invocation, { prompt: "next", metadata: { contextMode: "fresh_invocation", contextReason: "test" }, workspace }), /not drained/);
    invocation.write("operator continuation");
    await driver.stopInvocation(invocation, "user_interrupt");
    const events = [];
    for await (const event of invocation) events.push(event);
    assert.deepEqual(events.filter((event) => event.type === "turn_ended"), [
      { type: "turn_ended", reason: "response_completed" }, { type: "turn_ended", reason: "api_error" },
    ]);
    assert.ok(!events.some((event) => event.type === "stopping" && event.reason === "terminal"));
  } finally { await driver.stopInvocation(invocation, "adapter_error").catch(() => undefined); rmSync(workspace, { recursive: true, force: true }); }
});

test("reused Claude confirms a new session, replaces private metadata and keeps it out of model context", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "loopforge-warm-test-"));
  let endpoint!: ClaudeHookEndpoint;
  let settings = "";
  let starts = 0;
  let oldGate: Record<string, unknown> | undefined;
  let nextMetadata: Record<string, unknown> | undefined;
  const event = (hook_event_name: string, session_id: string, rest: Partial<ClaudeHookInput> = {}) => callClaudeLifecycleHook(endpoint, { hook_event_name, session_id, cwd: workspace, ...rest });
  const pty = new HookPty((data) => {
    if (data.startsWith("\x1b[200~")) {
      void event("UserPromptSubmit", "session-new", { promptHash: claudePromptHash(data.slice(6, -6)) });
      return;
    }
    if (data !== "/clear") return;
    void (async () => {
      oldGate = await event("PreToolUse", "session-old");
      await event("SessionEnd", "session-old", { reason: "clear" });
      assert.equal((await event("SessionStart", "session-old", { source: "clear" })).continue, false);
      nextMetadata = await event("SessionStart", "session-new", { source: "clear" });
    })();
  });
  const driver = new ClaudeCodeDriver({
    executable: "claude.exe", platform: "win32", lifecycleTimeoutMs: 2000, reuseProcess: true,
    ptyFactory: ((_file, args, options) => {
      starts++;
      settings = args[args.indexOf("--settings") + 1]!;
      assert.ok(!args.includes("--append-system-prompt"));
      assert.equal(args.at(-1), "first exact prompt");
      assert.ok(!readFileSync(settings, "utf8").includes("old-handle"));
      endpoint = { address: options.env.LOOPFORGE_CLAUDE_HOOK_ENDPOINT!, token: options.env.LOOPFORGE_CLAUDE_HOOK_TOKEN! };
      setImmediate(() => { void (async () => {
        await event("SessionStart", "session-old", { source: "startup" });
        await event("UserPromptSubmit", "session-old", { promptHash: claudePromptHash(args.at(-1)!) });
      })(); });
      return pty;
    }) as PtyFactory,
    stopProcessTree: async () => pty.kill(),
  });
  try {
    const first = await driver.startInvocation({ prompt: "first exact prompt", metadata: { contextMode: "fresh_invocation", contextReason: "test", submissionHandle: "old-handle" }, workspace });
    const second = await driver.replaceInvocation(first, { prompt: "second exact prompt\nwith newline", metadata: { contextMode: "fresh_invocation", contextReason: "next_round", submissionHandle: "new-handle" }, workspace });
    assert.equal(starts, 1);
    assert.equal(first.pid, second.pid);
    assert.notEqual(first.sessionId, second.sessionId);
    assert.notEqual(first.invocationId, second.invocationId);
    assert.match(JSON.stringify(oldGate), /deny/);
    const context = ((nextMetadata?.hookSpecificOutput as Record<string, unknown> | undefined)?.additionalContext as string | undefined) ?? "";
    assert.match(context, /"authority":"current_prompt_and_live_mcp_schema"/);
    assert.match(context, /"workspace":"continues_across_invocations"/);
    assert.ok(!context.includes("contextReason"));
    assert.ok(!context.includes("submissionHandle"));
    assert.ok(!context.includes("new-handle"));
    assert.ok(!context.includes("old-handle"));
    assert.ok(pty.writes.includes("\x1b[200~second exact prompt\nwith newline\x1b[201~"));
    assert.throws(() => first.write("old input"), /ended/);
    assert.deepEqual(await event("PreToolUse", "session-new", { tool_name: "Read", tool_use_id: "read-1" }), {});
    assert.match(JSON.stringify(await event("PreToolUse", "session-old")), /deny/);
    await assert.rejects(() => driver.stopInvocation(first, "terminal"), /inactive/);
    await assert.rejects(() => driver.replaceInvocation(first, { prompt: "stale", metadata: { contextMode: "fresh_invocation", contextReason: "test" }, workspace }), /cannot be replaced/);
    const events = [];
    for await (const item of first) events.push(item);
    assert.deepEqual(events.at(-2), { type: "stopping", reason: "fresh_invocation" });
    await driver.stopInvocation(second, "terminal");
    assert.throws(() => readFileSync(settings, "utf8"));
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

for (const change of ["unchanged", "edited", "deleted"] as const) test(`fixed background ${change}: reuse only current sources and retire stale snapshots before replacement`, async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "loopforge-capability-runtime-"));
  const source = path.join(workspace, "SKILL.md");
  const original = "ORIGINAL_CAPABILITY\r\n中文 🧪\r\n  exact text \r\n";
  writeFileSync(source, original);
  const processes: HookPty[] = [];
  const snapshots: string[] = [];
  const order: string[] = [];
  const driver = new ClaudeCodeDriver({
    executable: "claude.exe", platform: "win32", lifecycleTimeoutMs: 2000, reuseProcess: true, capabilityFiles: [source],
    ptyFactory: (_file, args, options) => {
      const index = processes.length;
      order.push(`start-${index}`);
      const snapshot = args[args.indexOf("--append-system-prompt-file") + 1]!;
      snapshots.push(snapshot);
      const text = readFileSync(snapshot, "utf8");
      assert.ok(text.includes(index === 0 ? original : "UPDATED_CAPABILITY"));
      assert.ok(!text.includes("round-private"));
      if (index > 0) assert.equal(existsSync(snapshots[0]!), false, "old snapshot must be removed before restarting");
      const endpoint = { address: options.env.LOOPFORGE_CLAUDE_HOOK_ENDPOINT!, token: options.env.LOOPFORGE_CLAUDE_HOOK_TOKEN! };
      const event = (hook_event_name: string, session_id: string, rest: Partial<ClaudeHookInput> = {}) => callClaudeLifecycleHook(endpoint, { hook_event_name, session_id, cwd: workspace, ...rest });
      const pty = new HookPty((data) => {
        if (data === "/clear") void (async () => {
          await event("SessionEnd", "session-0", { reason: "clear" });
          await event("SessionStart", "session-cleared", { source: "clear" });
        })();
        if (data.startsWith("\x1b[200~")) void event("UserPromptSubmit", "session-cleared", { promptHash: claudePromptHash(data.slice(6, -6)) });
      });
      processes.push(pty);
      setImmediate(() => { void (async () => {
        await event("SessionStart", `session-${index}`, { source: "startup" });
        await event("UserPromptSubmit", `session-${index}`, { promptHash: claudePromptHash(args.at(-1)!) });
      })(); });
      assert.equal(args.at(-1), index === 0 ? "round-private-first" : "round-private-second");
      return pty;
    },
    stopProcessTree: async () => { order.push("stop"); processes.at(-1)!.kill(); },
  });
  let current: Awaited<ReturnType<typeof driver.startInvocation>> | undefined;
  try {
    const first = await driver.startInvocation({ prompt: "round-private-first", metadata: { contextMode: "fresh_invocation", contextReason: "test" }, workspace });
    current = first;
    if (change === "edited") writeFileSync(source, "UPDATED_CAPABILITY\n");
    if (change === "deleted") rmSync(source);
    const replace = () => driver.replaceInvocation(first, { prompt: "round-private-second", metadata: { contextMode: "fresh_invocation", contextReason: "next_round" }, workspace });
    if (change === "deleted") {
      await assert.rejects(replace(), /ENOENT/);
      current = undefined;
      assert.deepEqual(order, ["start-0", "stop"]);
      assert.equal(existsSync(snapshots[0]!), false);
    } else {
      current = await replace();
      assert.deepEqual(order, change === "unchanged" ? ["start-0"] : ["start-0", "stop", "start-1"]);
      assert.notEqual(first.sessionId, current.sessionId);
      assert.ok(readFileSync(snapshots.at(-1)!, "utf8").includes(change === "unchanged" ? original : "UPDATED_CAPABILITY"));
    }
    if (change !== "unchanged") assert.ok(!processes[0]!.writes.some((data) => data.includes("round-private-second")));
    assert.throws(() => first.write("late"), /ended/);
  } finally {
    if (current) await driver.stopInvocation(current, "terminal");
    for (const snapshot of snapshots) assert.equal(existsSync(snapshot), false);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("missing clear acknowledgement kills the old process before delivering a replacement prompt", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "loopforge-warm-timeout-"));
  const processes: HookPty[] = [];
  const order: string[] = [];
  const driver = new ClaudeCodeDriver({
    executable: "claude.exe", platform: "win32", lifecycleTimeoutMs: 350, reuseProcess: true,
    ptyFactory: ((_file, args, options) => {
      const index = processes.length;
      order.push(`start-${index}`);
      const pty = new HookPty(() => {});
      processes.push(pty);
      const endpoint = { address: options.env.LOOPFORGE_CLAUDE_HOOK_ENDPOINT!, token: options.env.LOOPFORGE_CLAUDE_HOOK_TOKEN! };
      setImmediate(() => { void (async () => {
        await callClaudeLifecycleHook(endpoint, { hook_event_name: "SessionStart", source: "startup", session_id: `session-${index}`, cwd: workspace });
        await callClaudeLifecycleHook(endpoint, { hook_event_name: "UserPromptSubmit", session_id: `session-${index}`, cwd: workspace, promptHash: claudePromptHash(args.at(-1)!) });
      })(); });
      if (index > 0) assert.equal(args.at(-1), "replacement-private");
      return pty;
    }) as PtyFactory,
    stopProcessTree: async () => { order.push("kill-old"); processes.at(-1)!.kill(); },
  });
  try {
    const first = await driver.startInvocation({ prompt: "first", metadata: { contextMode: "fresh_invocation", contextReason: "test" }, workspace });
    const replacement = await driver.replaceInvocation(first, { prompt: "replacement-private", metadata: { contextMode: "fresh_invocation", contextReason: "next_round" }, workspace });
    assert.deepEqual(order, ["start-0", "kill-old", "start-1"]);
    assert.ok(!processes[0]!.writes.some((data) => data.includes("replacement-private")));
    await driver.stopInvocation(replacement, "terminal");
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

for (const failure of ["missing", "mismatch"]) test(`a ${failure} replacement prompt receipt drains no tools and restarts only after confirmed exit`, async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "loopforge-delivery-fallback-"));
  const processes: HookPty[] = [];
  const order: string[] = [];
  let staleReceipt: Record<string, unknown> | undefined;
  let blockedTool: Record<string, unknown> | undefined;
  let inputFailure: Record<string, unknown> | undefined;
  const driver = new ClaudeCodeDriver({
    executable: "claude.exe", platform: "win32", lifecycleTimeoutMs: 500, reuseProcess: true,
    ptyFactory: (_file, args, options) => {
      const index = processes.length;
      order.push(`start-${index}`);
      const endpoint = { address: options.env.LOOPFORGE_CLAUDE_HOOK_ENDPOINT!, token: options.env.LOOPFORGE_CLAUDE_HOOK_TOKEN! };
      const event = (hook_event_name: string, session_id: string, rest: Partial<ClaudeHookInput> = {}) => callClaudeLifecycleHook(endpoint, { hook_event_name, session_id, cwd: workspace, ...rest });
      const pty = new HookPty((data) => {
        if (data === "/clear") void (async () => {
          await event("SessionEnd", "session-0", { reason: "clear" });
          await event("SessionStart", "session-cleared", { source: "clear" });
        })();
        if (data.startsWith("\x1b[200~")) void (async () => {
          staleReceipt = await event("UserPromptSubmit", "session-0", { promptHash: claudePromptHash("replacement") });
          blockedTool = await event("PreToolUse", "session-cleared", { tool_name: "mcp__loopforge-adapter__loopforge_next", tool_use_id: "must-not-run" });
          if (failure === "mismatch") inputFailure = await event("UserPromptSubmit", "session-cleared", { promptHash: claudePromptHash("replacement ") });
        })();
      });
      processes.push(pty);
      setImmediate(() => { void (async () => {
        await event("SessionStart", `session-${index}`, { source: "startup" });
        await event("UserPromptSubmit", `session-${index}`, { promptHash: claudePromptHash(args.at(-1)!) });
      })(); });
      return pty;
    },
    stopProcessTree: async () => { order.push("kill-old"); processes.at(-1)!.kill(); },
  });
  try {
    const first = await driver.startInvocation({ prompt: "first", metadata: { contextMode: "fresh_invocation", contextReason: "test" }, workspace });
    const next = await driver.replaceInvocation(first, { prompt: "replacement", metadata: { contextMode: "fresh_invocation", contextReason: "next_round" }, workspace });
    assert.deepEqual(order, ["start-0", "kill-old", "start-1"]);
    assert.equal(staleReceipt?.decision, "block");
    assert.match(JSON.stringify(blockedTool), /deny/);
    assert.equal(blockedTool?.adapterAdmission, undefined);
    if (failure === "mismatch") assert.equal(inputFailure?.decision, "block");
    assert.equal(next.sessionId, "session-1");
    assert.throws(() => first.write("old input"), /ended/);
    await driver.stopInvocation(next, "terminal");
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
