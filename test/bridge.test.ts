import assert from "node:assert/strict";
import { test } from "node:test";
import { LoopForgeMcpBridge, type LoopForgeMcpClient } from "../src/mcp/bridge.js";

class FakeClient implements LoopForgeMcpClient {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  constructor(private readonly result: Record<string, unknown>) {}
  async listTools() {
    return [
      { name: "loopforge_start" },
      { name: "loopforge_next" },
      { name: "loopforge_status" },
    ];
  }
  async callTool(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    return this.result;
  }
}

test("bridge filters only supervisor-owned tools from live schemas", async () => {
  const bridge = new LoopForgeMcpBridge(new FakeClient({ content: [] }));
  const tools = await bridge.listAgentTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["loopforge_next", "loopforge_status"]);
});

test("bridge returns same-round prompts to the current invocation", async () => {
  const bridge = new LoopForgeMcpBridge(new FakeClient({
    content: [
      { type: "text", text: "retry prompt" },
      { type: "text", text: JSON.stringify({ contextMode: "same_round_retry", contextReason: "same_check_rejection" }) },
    ],
  }));
  const decision = await bridge.callAgentTool("loopforge_next", {});
  assert.equal(decision.kind, "same_round_retry");
});

test("bridge withholds fresh prompts as supervisor decisions", async () => {
  const bridge = new LoopForgeMcpBridge(new FakeClient({
    content: [
      { type: "text", text: "fresh prompt" },
      { type: "text", text: JSON.stringify({ contextMode: "fresh_invocation", contextReason: "round_boundary" }) },
    ],
  }));
  const decision = await bridge.callAgentTool("loopforge_next", {});
  assert.equal(decision.kind, "fresh_invocation");
  if (decision.kind === "fresh_invocation") assert.equal(decision.classification.prompt, "fresh prompt");
});

test("bridge rejects Agent calls to supervisor-owned lifecycle tools", async () => {
  const bridge = new LoopForgeMcpBridge(new FakeClient({ content: [] }));
  await assert.rejects(() => bridge.callAgentTool("loopforge_start", {}), /Supervisor-owned/);
});
