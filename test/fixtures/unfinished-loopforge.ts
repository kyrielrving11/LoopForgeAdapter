/** Test-only lifecycle peer. No LoopForge package, workspace or Vault is loaded. */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result: unknown = {};
  if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test-only", version: "1" } };
  if (request.method === "tools/list") result = { tools: [{ name: "loopforge_next", description: "Submit current work", inputSchema: { type: "object", properties: {} } }] };
  if (request.method === "tools/call") {
    const name = request.params.name;
    appendFileSync(process.env.UNFINISHED_FIXTURE_LOG!, JSON.stringify({ name, args: request.params.arguments }) + "\n");
    if (name === "loopforge_start") result = { content: [
      { type: "text", text: "A test transport request. Wait for the supplied response." },
      { type: "text", text: JSON.stringify({ contextMode: "fresh_invocation", contextReason: "round_boundary", loopId: "test-loop", sessionId: "test-session", submissionHandle: "test-handle" }) },
    ] };
    else if (name === "loopforge_pause") result = { content: [{ type: "text", text: '{"ok":true,"stopReason":"paused"}' }] };
    else result = { isError: true, content: [{ type: "text", text: "Unexpected lifecycle mutation" }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
