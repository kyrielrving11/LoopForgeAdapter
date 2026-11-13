import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeDriver, type PtyFactory, type PtyProcess } from "../src/hosts/claude.js";
import { callClaudeLifecycleHook, type ClaudeHookEndpoint } from "../src/hosts/claude-lifecycle.js";

class FakePty implements PtyProcess {
  readonly pid = 4321;
  readonly writes: string[] = [];
  readonly exits: Array<(event: { exitCode: number }) => void> = [];
  readonly listeners: Array<(data: string) => void> = [];
  emitExit = true;
  destroyed = false;
  write(data: string): void { this.writes.push(data); }
  kill(): void { if (this.emitExit) for (const listener of this.exits) listener({ exitCode: 0 }); }
  destroy(): void { this.destroyed = true; }
  onData(listener: (data: string) => void) { this.listeners.push(listener); return { dispose() {} }; }
  onExit(listener: (event: { exitCode: number }) => void) { this.exits.push(listener); return { dispose() {} }; }
}

async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "loopforge-cold-test-"));
  try { await run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function startup(options: Parameters<PtyFactory>[2], workspace: string, session = "native-first"): void {
  const endpoint: ClaudeHookEndpoint = { address: options.env.LOOPFORGE_CLAUDE_HOOK_ENDPOINT!, token: options.env.LOOPFORGE_CLAUDE_HOOK_TOKEN! };
  setImmediate(() => { void callClaudeLifecycleHook(endpoint, { hook_event_name: "SessionStart", source: "startup", session_id: session, cwd: workspace }); });
}

test("restart Claude confirms native startup, preserves exact prompt, isolates configuration and removes temporary files", async () => fixture(async (directory) => {
  const config = path.join(directory, "config");
  mkdirSync(config);
  writeFileSync(path.join(config, "settings.json"), JSON.stringify({ env: { ANTHROPIC_MODEL: "deepseek-flash[1m]", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" }, hooks: { SessionStart: [] } }));
  const pty = new FakePty();
  let spawned!: Parameters<PtyFactory>;
  const driver = new ClaudeCodeDriver({ reuseProcess: false, executable: "claude", ptyFactory: (...args) => { spawned = args; startup(args[2], directory); return pty; }, stopProcessTree: async () => pty.kill() });
  const handle = await driver.startInvocation({ prompt: "exact prompt\nwith newline", metadata: { submissionHandle: "private-handle" }, workspace: directory, env: { CLAUDE_CONFIG_DIR: config } });
  try {
    assert.equal(spawned[1].at(-1), "exact prompt\nwith newline");
    assert.ok(!spawned[1].includes("--print"));
    assert.ok(!spawned[1].includes("--append-system-prompt"));
    const settingsPath = spawned[1][spawned[1].indexOf("--settings") + 1]!;
    const settings = readFileSync(settingsPath, "utf8");
    assert.ok(!settings.includes("private-handle"));
    assert.ok(settings.includes("PostToolUseFailure"));
    assert.equal(spawned[2].env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
    assert.equal(spawned[2].env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
    assert.equal(spawned[2].env.ANTHROPIC_MODEL, "deepseek-flash[1m]");
    await driver.stopInvocation(handle, "terminal");
    assert.throws(() => readFileSync(settingsPath, "utf8"));
    assert.throws(() => handle.write("late input"), /ended/);
  } finally { pty.kill(); }
}));

test("restart Claude stops the old host before a replacement starts", async () => fixture(async (directory) => {
  const processes: FakePty[] = [];
  const order: string[] = [];
  const driver = new ClaudeCodeDriver({ reuseProcess: false, executable: "claude", ptyFactory: (_file, args, options) => {
    order.push(`start:${args.at(-1)}`);
    const pty = new FakePty(); processes.push(pty); startup(options, directory, `native-${processes.length}`); return pty;
  }, stopProcessTree: async () => { order.push("stop"); processes.at(-1)!.kill(); } });
  const first = await driver.startInvocation({ prompt: "first", metadata: {}, workspace: directory });
  const second = await driver.replaceInvocation(first, { prompt: "second", metadata: {}, workspace: directory });
  assert.deepEqual(order, ["start:first", "stop", "start:second"]);
  assert.notEqual(first.sessionId, second.sessionId);
  await assert.rejects(driver.stopInvocation(first, "terminal"), /inactive/);
  await driver.stopInvocation(second, "terminal");
}));

test("Claude missing exit confirmation never authorizes replacement or fabricates an exited event", async () => fixture(async (directory) => {
  const pty = new FakePty();
  let starts = 0;
  const driver = new ClaudeCodeDriver({ reuseProcess: false, executable: "claude", ptyFactory: (_file, _args, options) => { starts++; startup(options, directory); return pty; }, stopProcessTree: async () => {} });
  const first = await driver.startInvocation({ prompt: "first", metadata: {}, workspace: directory });
  pty.emitExit = false;
  await assert.rejects(driver.replaceInvocation(first, { prompt: "never delivered", metadata: {}, workspace: directory }), /termination could not be confirmed/);
  assert.equal(starts, 1);
  pty.emitExit = true;
  pty.kill();
  await driver.stopInvocation(first, "terminal");
  // A terminal event is emitted only after the actual callback above.
  const events = [];
  for await (const event of first) events.push(event);
  assert.equal(events.filter((event) => event.type === "exited").length, 1);
}));

test("Claude merges the private bridge without dropping external MCP configuration", async () => fixture(async (directory) => {
  const base = path.join(directory, "mcp.json");
  writeFileSync(base, JSON.stringify({ mcpServers: { external: { command: "external" } } }));
  const pty = new FakePty();
  let configPath = "";
  const driver = new ClaudeCodeDriver({ executable: "claude", ptyFactory: (_file, args, options) => {
    configPath = args.find((arg) => arg.startsWith("--mcp-config="))!.slice("--mcp-config=".length);
    startup(options, directory); return pty;
  }, stopProcessTree: async () => pty.kill() });
  const handle = await driver.startInvocation({ prompt: "first", metadata: {}, workspace: directory, mcpConfigPath: base,
    bridge: { serverName: "loopforge-adapter", command: process.execPath, args: ["bridge"], env: { PRIVATE_ENDPOINT: "local" } } });
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(config.mcpServers.external.command, "external");
  assert.equal(config.mcpServers["loopforge-adapter"].command, process.execPath);
  await driver.stopInvocation(handle, "terminal");
  assert.throws(() => readFileSync(configPath, "utf8"));
}));

test("Claude capability probe requires lifecycle configuration flags in both modes", async () => {
  for (const reuseProcess of [true, false]) {
    const supported = new ClaudeCodeDriver({ reuseProcess, executable: "claude", readCliVersion: async () => "2.1.323 (Claude Code)", readCliHelp: async () => "--session-id --mcp-config --settings --setting-sources --strict-mcp-config --disallowedTools --plugin-dir" });
    assert.equal((await supported.probe()).toolResultInterception, true);
    const missing = new ClaudeCodeDriver({ reuseProcess, executable: "claude", readCliVersion: async () => "2.1.323 (Claude Code)", readCliHelp: async () => "--session-id --mcp-config" });
    assert.equal((await missing.probe()).cleanConversation, false);
    const old = new ClaudeCodeDriver({ reuseProcess, executable: "claude", readCliVersion: async () => "2.1.1 (Claude Code)", readCliHelp: async () => "--session-id --mcp-config --settings --setting-sources --strict-mcp-config --disallowedTools --plugin-dir" });
    assert.equal((await old.probe()).cleanConversation, false);
  }
});
