import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { startAnthropicProbe } from "../../experiments/anthropic-probe.js";

for (const status of [200, 400, 401]) test(`real Claude HTTP ${status} ${status === 200 ? "text-only stop" : "failure"} returns a nonzero CLI result and pauses exactly once without submitting`,
  { skip: process.env.CLAUDE_RUNTIME_E2E !== "1", timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "loopforge-unfinished-test-"));
  const workspace = path.join(root, "workspace"); const config = path.join(root, "config");
  mkdirSync(workspace); mkdirSync(config);
  const log = path.join(root, "calls.jsonl");
  const apiError = status !== 200;
  writeFileSync(path.join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true,
    projects: { [workspace.replaceAll("\\", "/")]: { hasTrustDialogAccepted: true } } }));
  let requests = 0;
  const upstream = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: status === 401 ? "authentication_error" : "invalid_request_error", message: "Synthetic local API error" } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const relay = await startAnthropicProbe({ maximumRequests: 2, maximumOutputTokens: 32768,
    inspect() { requests++; }, measured() {}, localReply() { return { text: "The native turn ended without a LoopForge submission." }; },
  });
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../src/cli.js", import.meta.url)), "start", "--workspace", workspace, "--task", "transport-only test",
    "--loopforge-command", process.execPath, "--loopforge-arg", fileURLToPath(new URL("../fixtures/unfinished-loopforge.js", import.meta.url))],
    { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env,
      CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: apiError ? `http://127.0.0.1:${address.port}` : relay.url,
      ANTHROPIC_AUTH_TOKEN: "local-probe", ANTHROPIC_API_KEY: "", ANTHROPIC_MODEL: "deepseek-flash[1m]",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "1024", MAX_THINKING_TOKENS: "0", ENABLE_TOOL_SEARCH: "false",
      // Bound only the local test. Production preserves the user's native retry policy.
      CLAUDE_CODE_MAX_RETRIES: "0", CLAUDE_CODE_RETRY_WATCHDOG: "0",
      DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", UNFINISHED_FIXTURE_LOG: log,
    } });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  try {
    const code = await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Native turn termination was not observed: " + output.slice(-5000))), 30000); })]);
    assert.equal(code, 1, output.slice(-5000));
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls.map((call) => call.name), ["loopforge_start", "loopforge_pause"]);
    assert.deepEqual(calls.at(-1).args, { sessionId: "test-session" });
    assert.match(output, apiError ? /turn ended \(api_error\)/ : /turn ended \(response_completed\)/);
    if (!apiError) assert.equal(requests, 1);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      if (process.platform === "win32" && child.pid) await new Promise<void>((resolve) => execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
      else child.kill("SIGKILL");
      await exited;
    }
    await relay.close(); upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
