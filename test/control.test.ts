import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeControlClient, BridgeControlServer } from "../src/mcp/control.js";

test("local bridge control channel authenticates and preserves tool decisions", async () => {
  const server = new BridgeControlServer();
  const endpoint = await server.listen(async (request) => {
    if (request.type === "list_tools") {
      return { type: "list_tools_result", requestId: request.requestId, tools: [{ name: "loopforge_next" }] };
    }
    return {
      type: "call_tool_result",
      requestId: request.requestId,
      decision: {
        kind: request.name === "loopforge_next" ? "handoff" : "deliver",
        result: { content: [{ type: "text", text: request.name }] },
      },
    };
  });
  const client = new BridgeControlClient(endpoint);
  try {
    assert.deepEqual(await client.listTools(), [{ name: "loopforge_next" }]);
    const decision = await client.callTool("loopforge_next", {});
    assert.equal(decision.kind, "handoff");
    assert.equal(decision.result.content?.[0]?.text, "loopforge_next");
  } finally {
    await client.close();
    await server.close();
  }
});
