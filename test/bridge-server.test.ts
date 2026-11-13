import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BridgeControlServer } from "../src/mcp/control.js";

function readLine(lines: ReturnType<typeof createInterface>): Promise<string> {
  return new Promise((resolve) => lines.once("line", resolve));
}

test("Claude-facing MCP bridge withholds a fresh boundary response", async () => {
  const server = new BridgeControlServer();
  const endpoint = await server.listen(async (request) => {
    if (request.type === "list_tools") {
      return { type: "list_tools_result", requestId: request.requestId, tools: [{ name: "loopforge_next" }] };
    }
    return {
      type: "call_tool_result",
      requestId: request.requestId,
      decision: {
        kind: "handoff",
        result: { content: [{ type: "text", text: "fresh prompt" }] },
      },
    };
  });
  const bridgePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/mcp/bridge-server.js");
  const child = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      LOOPFORGE_ADAPTER_CONTROL_ENDPOINT: endpoint.address,
      LOOPFORGE_ADAPTER_CONTROL_TOKEN: endpoint.token,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const outputLines: string[] = [];
  lines.on("line", (line) => outputLines.push(line));
  const write = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    const initialized = JSON.parse(await readLine(lines));
    assert.equal(initialized.result.serverInfo.name, "loopforge-adapter-bridge");
    assert.equal(initialized.result.protocolVersion, "2024-11-05");
    assert.match(initialized.result.instructions, /Adapter owns LoopForge lifecycle/);
    write({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.deepEqual(JSON.parse(await readLine(lines)).result.tools, [{ name: "loopforge_next" }]);
    write({ jsonrpc: "2.0", id: 3, method: "ping", params: {} });
    assert.deepEqual(JSON.parse(await readLine(lines)).result, {});
    write({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "loopforge_next", arguments: {} } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(child.exitCode, null);
    assert.equal(outputLines.length, 3);
  } finally {
    lines.close();
    child.kill();
    await once(child, "close");
    await server.close();
  }
});
