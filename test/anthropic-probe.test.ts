import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { startAnthropicProbe, type ProbeMeasurement, type ProbeRequest } from "../experiments/anthropic-probe.js";

test("experimental relay changes only provider user identity and records final cumulative streaming usage once", async () => {
  let forwarded: ProbeRequest | undefined;
  let measured: ProbeMeasurement | undefined;
  let inspected: ProbeRequest | undefined;
  const frames = [
    { type: "message_start", message: { usage: { input_tokens: 999, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "Read", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file":"中文 🧪"}' } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 42, cache_read_input_tokens: 2048, cache_creation_input_tokens: 0, output_tokens: 12 } },
    { type: "message_stop" },
  ];
  const stream = frames.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const upstream = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += String(chunk);
    forwarded = JSON.parse(body) as ProbeRequest;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const bytes = Buffer.from(stream);
    const cut = bytes.indexOf(Buffer.from("中文")) + 1;
    response.write(bytes.subarray(0, cut));
    setImmediate(() => { response.write(bytes.subarray(cut, cut + 2)); response.end(bytes.subarray(cut + 2)); });
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const relay = await startAnthropicProbe({ upstream: new URL(`http://127.0.0.1:${address.port}`), stableUserId: "same-run",
    maximumRequests: 2, maximumOutputTokens: 64,
    inspect(input) { inspected = structuredClone(input); }, measured(value) { measured = value; },
  });
  const original: ProbeRequest = { model: "probe", max_tokens: 64, system: [{ type: "text", text: "unchanged static text" }],
    messages: [{ role: "user", content: "current input" }], tools: [{ name: "Read" }], metadata: { user_id: "native-session", other: "preserved" } };
  try {
    const response = await fetch(relay.url + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(original) });
    assert.equal(await response.text(), stream);
    assert.deepEqual(inspected, original);
    assert.deepEqual(forwarded, { ...original, metadata: { ...original.metadata, user_id: "same-run" } });
    assert.equal(measured?.complete, true);
    assert.equal(measured?.stopReason, "tool_use");
    assert.deepEqual(measured?.toolNames, ["Read"]);
    assert.deepEqual(measured?.usage, { input_tokens: 42, cache_read_input_tokens: 2048, cache_creation_input_tokens: 0, output_tokens: 12 });
    assert.ok(typeof measured?.firstContentMs === "number");
  } finally { await relay.close(); upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); }
});

test("experimental relay refuses requests over the output limit before any provider call", async () => {
  let inspected = false;
  const relay = await startAnthropicProbe({ maximumRequests: 1, maximumOutputTokens: 64,
    inspect() { inspected = true; }, measured() { throw new Error("No response should be measured"); },
  });
  try {
    const request = fetch(relay.url + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "probe", max_tokens: 65, messages: [] }) });
    void request.catch(() => undefined);
    await assert.rejects(relay.failed, /Experiment request failed/);
    await assert.rejects(request);
    assert.equal(inspected, false);
  } finally { await relay.close(); }
});
