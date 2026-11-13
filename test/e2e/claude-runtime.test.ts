import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { ClaudeCodeDriver, type PtyFactory } from "../../src/hosts/claude.js";
import { LoopForgeSupervisor } from "../../src/supervisor.js";
import type { LoopForgeMcpClient } from "../../src/mcp/bridge.js";

const enabled = process.env.CLAUDE_RUNTIME_E2E === "1";
const require = createRequire(import.meta.url);

for (const reuseProcess of [true, false]) test(`real Claude ${reuseProcess ? "reuses" : "restarts"} its host with isolated hooks, memory, tools and subagents`, { skip: !enabled, timeout: 60000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "loopforge-claude-acceptance-"));
  const workspace = path.join(directory, "workspace");
  const config = path.join(directory, "config");
  mkdirSync(workspace);
  mkdirSync(config);
  writeFileSync(path.join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true,
    projects: { [workspace.replaceAll("\\", "/")]: { hasTrustDialogAccepted: true } },
  }));
  const hiddenHook = path.join(directory, "injected.cjs");
  const hookLog = path.join(directory, "injected.log");
  writeFileSync(hiddenHook, `require('node:fs').appendFileSync(__HOOK_LOG__, 'ran');process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'UNWANTED_HOOK_MEMORY_29a'}}));`.replace("__HOOK_LOG__", JSON.stringify(hookLog)));
  const hooks = { SessionStart: [{ hooks: [{ type: "command", command: `"${process.execPath}" "${hiddenHook}"` }] }] };
  writeFileSync(path.join(config, "settings.json"), JSON.stringify({ hooks, autoMemoryEnabled: true, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" } }));
  mkdirSync(path.join(workspace, ".claude"));
  writeFileSync(path.join(workspace, ".claude/settings.json"), JSON.stringify({ hooks, enabledPlugins: { "probe-plugin@probe-marketplace": true } }));
  const pluginRoot = path.join(config, "plugins/cache/probe-marketplace/probe-plugin/1.0.0");
  const pluginSkill = path.join(pluginRoot, "skills/boundary-extra");
  mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  mkdirSync(pluginSkill, { recursive: true });
  writeFileSync(path.join(pluginRoot, ".claude-plugin/plugin.json"), JSON.stringify({ name: "probe-plugin", version: "1.0.0" }));
  writeFileSync(path.join(pluginSkill, "SKILL.md"), "---\nname: boundary-extra\ndescription: PLUGIN_SKILL_AVAILABLE_184\n---\nPLUGIN_SKILL_LOADED_184\n");
  const memory = path.join(config, "projects", workspace.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
  mkdirSync(memory, { recursive: true });
  writeFileSync(path.join(memory, "MEMORY.md"), "UNWANTED_AUTO_MEMORY_72f");
  const skill = path.join(workspace, ".claude/skills/boundary-static");
  mkdirSync(skill, { recursive: true });
  writeFileSync(path.join(skill, "SKILL.md"), "---\nname: boundary-static\ndescription: STATIC_SKILL_AVAILABLE_81d\n---\nSTATIC_SKILL_LOADED_81d\n");
  const mcpLog = path.join(directory, "mcp.log");
  const mcpServer = path.join(directory, "external.cjs");
  writeFileSync(mcpServer, `
const fs=require('node:fs');let calls=0;fs.appendFileSync(process.env.PROBE_LOG,'start:'+process.pid+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);if(q.id===undefined)return;let result={};
 if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'external',version:'1'}};
 if(q.method==='tools/list')result={tools:[{name:'environment',description:'Read environment identity',inputSchema:{type:'object',properties:{}}}]};
 if(q.method==='tools/call'){calls=fs.readFileSync(process.env.PROBE_LOG,'utf8').split('\\n').filter(line=>line.startsWith('call:')).length+1;fs.appendFileSync(process.env.PROBE_LOG,'call:'+process.pid+':'+calls+'\\n');result={content:[{type:'text',text:'EXTERNAL_CALL_'+calls}]}};
 const finish=()=>{if(q.method==='tools/call')fs.appendFileSync(process.env.PROBE_LOG,'done:'+process.pid+':'+calls+'\\n');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n')}; if(q.method==='tools/call')setTimeout(finish,700);else finish();
});`);
  const mcpConfig = path.join(directory, "mcp.json");
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { external: { command: process.execPath,
    args: [mcpServer], env: { PROBE_LOG: mcpLog } } } }));

  const firstMarker = "FIRST_CONTEXT_PRIVATE_83b19";
  const nextMarker = "NEXT_CONTEXT_PRIVATE_62a87";
  const retryMarker = "SAME_ROUND_RETRY_c18aa";
  const requests: Array<{ context: string; toolNames: string[]; toolSchema: string }> = [];
  let probeReject!: (error: Error) => void;
  const probeFailure = new Promise<never>((_, reject) => { probeReject = reject; });
  void probeFailure.catch(() => undefined);
  const server = createServer(async (request, response) => {
    if (!request.url?.split("?")[0]?.endsWith("/messages")) { response.setHeader("content-type", "application/json"); response.end('{"input_tokens":100}'); return; }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const input = JSON.parse(body) as { model: string; messages: unknown[]; system?: unknown; tools?: Array<{ name: string }> };
    const context = JSON.stringify({ messages: input.messages, system: input.system });
    const toolNames = (input.tools ?? []).map((tool) => tool.name);
    requests.push({ context, toolNames, toolSchema: JSON.stringify(input.tools) });
    if (requests.length > 18) {
      probeReject(new Error(`Unexpected repeated tool calls; last messages=${JSON.stringify(input.messages).slice(-2000)}`));
      response.statusCode = 400;
      response.end('{"type":"error","error":{"type":"invalid_request_error","message":"Probe request limit reached"}}');
      return;
    }
    const isNext = context.includes(nextMarker);
    const hasExternal = context.includes(isNext ? "EXTERNAL_CALL_2" : "EXTERNAL_CALL_1");
    const latestUser = [...input.messages].reverse().find((message) => (message as { role?: string }).role === "user");
    const isChild = JSON.stringify(latestUser).includes("FOREGROUND_CHILD_PROBE_624");
    const needsStaticSkill = !context.includes("STATIC_SKILL_LOADED_81d") && !context.includes("Unknown skill");
    const needsPluginSkill = !needsStaticSkill && !context.includes("PLUGIN_SKILL_LOADED_184") && !context.includes("Unknown skill");
    const needsSkill = needsStaticSkill || needsPluginSkill;
    const needsChild = !isChild && !isNext && hasExternal && !context.includes("FOREGROUND_CHILD_DONE_624");
    if (isChild) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: "message_start", message: { id: `child_${requests.length}`, type: "message", role: "assistant", model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
      send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "FOREGROUND_CHILD_DONE_624" } });
      send({ type: "content_block_stop", index: 0 });
      send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      send({ type: "message_stop" }); response.end(); return;
    }
    const toolName = toolNames.find((name) => needsSkill ? name === "Skill" : needsChild ? name === "Agent" : hasExternal ? name.endsWith("loopforge_next") : name.endsWith("environment"));
    const toolInput = needsStaticSkill ? { skill: "loopforge-static:boundary-static" } : needsPluginSkill ? { skill: "probe-plugin:boundary-extra" } : needsChild
      ? { description: "Foreground lifecycle probe", prompt: "FOREGROUND_CHILD_PROBE_624", subagent_type: "general-purpose", run_in_background: false } : {};
    if (needsChild) assert.ok(!requests.at(-1)!.toolSchema.includes('"run_in_background"'), "background parameter must be absent from advertised tools");
    if (!toolName) { response.statusCode = 400; response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Expected probe tool missing" } })); return; }
    const id = `tool_${requests.length}`;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
    send({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: toolName, input: {} } });
    send({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(toolInput) } });
    send({ type: "content_block_stop", index: 0 });
    if (!needsSkill && !needsChild && !hasExternal) {
      const nextTool = toolNames.find((name) => name.endsWith("loopforge_next"))!;
      send({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: `parallel_${id}`, name: nextTool, input: {} } });
      send({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } });
      send({ type: "content_block_stop", index: 1 });
    }
    send({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } });
    send({ type: "message_stop" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const prompt = (text: string, handle: string, mode = "fresh_invocation") => ({ content: [
    { type: "text", text }, { type: "text", text: JSON.stringify({ contextMode: mode, contextReason: "round_boundary", sessionId: "lf-session", loopId: "lf-loop", submissionHandle: handle }) },
  ] });
  let submissions = 0;
  const loopforge: LoopForgeMcpClient = {
    async listTools() { return [{ name: "loopforge_next", description: "Submit work", inputSchema: { type: "object", properties: {} } }]; },
    async callTool(name, args) {
      if (name === "loopforge_start") return prompt(firstMarker, "OLD_HANDLE_751");
      assert.deepEqual(args, {}, "transport admission must not enter LoopForge arguments");
      const executions = existsSync(mcpLog) ? readFileSync(mcpLog, "utf8").split(/\r?\n/) : [];
      assert.equal(executions.filter((line) => line.startsWith("call:")).length, executions.filter((line) => line.startsWith("done:")).length, "no LoopForge call may run while an external tool is still active");
      submissions++;
      if (submissions === 1) return prompt(retryMarker, "OLD_HANDLE_751", "same_round_retry");
      if (submissions === 2) return prompt(nextMarker, "NEW_HANDLE_928");
      return { content: [{ type: "text", text: '{"ok":true,"stopReason":"completed"}' }] };
    },
  };
  let hostStarts = 0;
  let terminal = "";
  const nodePty = require("node-pty") as { spawn: PtyFactory };
  const driver = new ClaudeCodeDriver({
    reuseProcess,
    executable: process.env.CLAUDE_EXECUTABLE ?? (process.platform === "win32"
      ? path.join(process.env.APPDATA!, "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe") : "claude"),
    ptyFactory: (file, args, options) => {
      hostStarts++;
      const child = nodePty.spawn(file, [...args, "--tools", "Skill,Read,Agent", "--permission-mode", "dontAsk", "--ax-screen-reader", "--allowedTools=Skill,Read,Agent,mcp__external__environment,mcp__loopforge-adapter__loopforge_next"], options);
      child.onData((data) => { terminal += data; });
      return child;
    },
  });
  let terminalResolve!: () => void;
  const completed = new Promise<void>((resolve) => { terminalResolve = resolve; });
  const supervisor = new LoopForgeSupervisor({ host: driver, loopforge, workspace, mcpConfigPath: mcpConfig,
    env: { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_AUTH_TOKEN: "local-probe", ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "deepseek-flash[1m]", ENABLE_TOOL_SEARCH: "false", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    onTerminalResult: () => terminalResolve(),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await supervisor.start({ task: "probe" }).catch((error: unknown) => {
      throw new Error(`${String(error)}; terminal=${terminal.slice(-3500)}`);
    });
    assert.ok(first);
    await Promise.race([completed, probeFailure, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Claude probe timed out; requests=${requests.length}, submissions=${submissions}; terminal=${terminal.slice(-2200)}`)), 35000); })]);
    assert.equal(hostStarts, reuseProcess ? 1 : 2);
    assert.ok(!requests.some((request) => request.context.includes("UNWANTED_HOOK_MEMORY_29a") || request.context.includes("UNWANTED_AUTO_MEMORY_72f")));
    assert.ok(requests.some((request) => request.context.includes("STATIC_SKILL_LOADED_81d")), `Skill result missing; ${requests.at(-1)?.context.slice(-2300)}`);
    assert.ok(requests.some((request) => request.context.includes("PLUGIN_SKILL_LOADED_184")), `Plugin skill result missing; ${requests.at(-1)?.context.slice(-1800)}`);
    assert.ok(!existsSync(hookLog));
    assert.equal(submissions, 3);
    assert.ok(requests.some((request) => request.context.includes("FOREGROUND_CHILD_DONE_624")), "foreground child must finish before the round is accepted");
    const nextRequests = requests.filter((request) => request.context.includes(nextMarker));
    assert.ok(nextRequests.length > 0);
    for (const request of nextRequests) {
      assert.ok(!request.context.includes(firstMarker));
      assert.ok(!request.context.includes(retryMarker));
      assert.ok(!request.context.includes("OLD_HANDLE_751"));
      assert.ok(!request.context.includes("EXTERNAL_CALL_1"));
      assert.ok(!request.context.includes("FOREGROUND_CHILD_DONE_624"));
      assert.ok(!request.context.includes("FOREGROUND_CHILD_PROBE_624"));
      assert.ok(request.context.includes("NEW_HANDLE_928"));
    }
    assert.ok(requests.some((request) => request.context.includes(firstMarker) && request.context.includes(retryMarker)));
    const mcpEvents = readFileSync(mcpLog, "utf8").trim().split(/\r?\n/);
    assert.equal(mcpEvents.filter((event) => event.startsWith("start:")).length, reuseProcess ? 1 : 2);
    assert.equal(mcpEvents.filter((event) => event.startsWith("call:")).length, 2);
    console.log(JSON.stringify({ hostStarts, mcpStarts: reuseProcess ? 1 : 2, nativeFreshContextVerified: true, sameRoundRetryVerified: true, requests: requests.length }));
  } finally {
    if (timer) clearTimeout(timer);
    await supervisor.stop("adapter_error");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
