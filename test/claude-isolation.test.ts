import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeIsolation } from "../src/hosts/claude-isolation.js";
import { ClaudeLifecycleServer, type ClaudeHookInput } from "../src/hosts/claude-lifecycle.js";


test("launch isolation excludes injection settings, retains operational settings and forces memory/background off", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "loopforge-isolation-"));
  const config = path.join(directory, "config");
  mkdirSync(config); mkdirSync(path.join(directory, ".claude"));
  const source = { hooks: { SessionStart: [{ hooks: [{ command: "UNWANTED" }] }] }, enabledPlugins: { "memory@plugin": true }, autoMemoryEnabled: true,
    permissions: { deny: ["Read(/private/**)"], allow: ["Bash(npm test)"] }, sandbox: { filesystem: { denyRead: ["./secrets"] } },
    env: { ANTHROPIC_MODEL: "test-model", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0" } };
  writeFileSync(path.join(config, "settings.json"), JSON.stringify(source));
  writeFileSync(path.join(directory, ".claude/settings.json"), JSON.stringify({ permissions: { deny: ["Edit(/other/**)"] } }));
  try {
    const { settings, env, pluginIds } = claudeIsolation(directory, { CLAUDE_CONFIG_DIR: config });
    assert.ok(!JSON.stringify(settings).includes("UNWANTED"));
    assert.equal(settings.enabledPlugins, undefined);
    assert.deepEqual(pluginIds, ["memory@plugin"]);
    assert.equal(settings.autoMemoryEnabled, false);
    assert.equal(settings.env, undefined);
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
    assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
    assert.equal(env.ANTHROPIC_MODEL, "test-model");
    const permissions = settings.permissions as { deny: string[]; allow: string[] };
    assert.equal(permissions.deny.length, 2);
    assert.ok(permissions.deny.every((entry) => /\(\/\//.test(entry)));
    assert.deepEqual(permissions.allow, ["Bash(npm test)"]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(config, "settings.json"), "utf8")), source);
    writeFileSync(path.join(config, "managed-settings.json"), "{}");
    assert.throws(() => claudeIsolation(directory, { CLAUDE_CONFIG_DIR: config }), /Managed Claude/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("hook relay forwards execution identifiers without forwarding tool content or transcripts", async () => {
  const server = new ClaudeLifecycleServer();
  let observed: ClaudeHookInput | undefined;
  const endpoint = await server.listen((input) => { observed = input; return { adapterAdmission: "one-use" }; });
  try {
    const child = spawn(process.execPath, [path.resolve("dist/src/hosts/claude-hook.js")], {
      env: { ...process.env, LOOPFORGE_CLAUDE_HOOK_ENDPOINT: endpoint.address, LOOPFORGE_CLAUDE_HOOK_TOKEN: endpoint.token }, windowsHide: true,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (data) => { stdout += data; });
    child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "native", cwd: "/work", tool_use_id: "call", tool_name: "mcp__loopforge-adapter__loopforge_next",
      transcript_path: "PRIVATE_TRACE", tool_input: { evaluation: "PRIVATE_EVALUATION" }, tool_response: { stdout: "PRIVATE_RESULT" } }));
    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(exitCode, 0);
    assert.deepEqual(observed, { hook_event_name: "PreToolUse", session_id: "native", cwd: "/work", tool_name: "mcp__loopforge-adapter__loopforge_next", tool_use_id: "call", background: false });
    const output = JSON.parse(stdout);
    assert.equal(output.adapterAdmission, undefined);
    assert.deepEqual(output.hookSpecificOutput.updatedInput, { evaluation: "PRIVATE_EVALUATION", __loopforge_adapter_admission: "one-use" });
  } finally { await server.close(); }
});
