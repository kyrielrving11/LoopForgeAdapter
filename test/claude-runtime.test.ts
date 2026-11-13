import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeDriver, type PtyFactory, type PtyProcess } from "../src/hosts/claude.js";
import { callClaudeLifecycleHook, type ClaudeHookEndpoint, type ClaudeHookInput } from "../src/hosts/claude-lifecycle.js";

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

test("reused Claude confirms a new session, replaces metadata and keeps one host process", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "loopforge-warm-test-"));
  let endpoint!: ClaudeHookEndpoint;
  let settings = "";
  let starts = 0;
  let oldGate: Record<string, unknown> | undefined;
  let nextMetadata: Record<string, unknown> | undefined;
  const event = (hook_event_name: string, session_id: string, rest: Partial<ClaudeHookInput> = {}) => callClaudeLifecycleHook(endpoint, { hook_event_name, session_id, cwd: workspace, ...rest });
  const pty = new HookPty((data) => {
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
      setImmediate(() => { void event("SessionStart", "session-old", { source: "startup" }); });
      return pty;
    }) as PtyFactory,
    stopProcessTree: async () => pty.kill(),
  });
  try {
    const first = await driver.startInvocation({ prompt: "first exact prompt", metadata: { submissionHandle: "old-handle" }, workspace });
    const second = await driver.replaceInvocation(first, { prompt: "second exact prompt\nwith newline", metadata: { submissionHandle: "new-handle" }, workspace });
    assert.equal(starts, 1);
    assert.equal(first.pid, second.pid);
    assert.notEqual(first.sessionId, second.sessionId);
    assert.notEqual(first.invocationId, second.invocationId);
    assert.match(JSON.stringify(oldGate), /deny/);
    assert.match(JSON.stringify(nextMetadata), /new-handle/);
    assert.ok(!JSON.stringify(nextMetadata).includes("old-handle"));
    assert.ok(pty.writes.includes("\x1b[200~second exact prompt\nwith newline\x1b[201~"));
    assert.throws(() => first.write("old input"), /ended/);
    assert.deepEqual(await event("PreToolUse", "session-new", { tool_name: "Read", tool_use_id: "read-1" }), {});
    assert.match(JSON.stringify(await event("PreToolUse", "session-old")), /deny/);
    await assert.rejects(() => driver.stopInvocation(first, "terminal"), /inactive/);
    await assert.rejects(() => driver.replaceInvocation(first, { prompt: "stale", metadata: {}, workspace }), /cannot be replaced/);
    const events = [];
    for await (const item of first) events.push(item);
    assert.deepEqual(events.at(-2), { type: "stopping", reason: "fresh_invocation" });
    await driver.stopInvocation(second, "terminal");
    assert.throws(() => readFileSync(settings, "utf8"));
  } finally { rmSync(workspace, { recursive: true, force: true }); }
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
      setImmediate(() => { void callClaudeLifecycleHook(endpoint, { hook_event_name: "SessionStart", source: "startup", session_id: `session-${index}`, cwd: workspace }); });
      if (index > 0) assert.equal(args.at(-1), "replacement-private");
      return pty;
    }) as PtyFactory,
    stopProcessTree: async () => { order.push("kill-old"); processes.at(-1)!.kill(); },
  });
  try {
    const first = await driver.startInvocation({ prompt: "first", metadata: {}, workspace });
    const replacement = await driver.replaceInvocation(first, { prompt: "replacement-private", metadata: {}, workspace });
    assert.deepEqual(order, ["start-0", "kill-old", "start-1"]);
    assert.ok(!processes[0]!.writes.some((data) => data.includes("replacement-private")));
    await driver.stopInvocation(replacement, "terminal");
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
