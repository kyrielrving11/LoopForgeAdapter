import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

export interface ProbeRequest {
  model: string;
  max_tokens?: number;
  system?: unknown;
  tools?: Array<{ name: string }>;
  messages: unknown;
  metadata?: Record<string, unknown>;
}

export interface ProbeUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

export interface ProbeMeasurement {
  status: number;
  elapsedMs: number;
  firstContentMs: number | null;
  usage: ProbeUsage | null;
  complete: boolean;
  stopReason: string | null;
  toolNames: string[];
}

/** Only experiment data passes here. No production proxy or body persistence. */
export async function startAnthropicProbe(options: {
  upstream?: URL;
  stableUserId?: string;
  maximumRequests: number;
  /** Optional test-only request cap. Omit for an uncapped provider relay. */
  maximumOutputTokens?: number;
  /** Abort a provider request that stops producing a response. */
  requestTimeoutMs?: number;
  inspect(input: ProbeRequest): void;
  measured(measurement: ProbeMeasurement): void;
  onFailure?(measurement: ProbeMeasurement): void;
  localReply?(input: ProbeRequest): { name: string; input: Record<string, unknown> } | { text: string };
}) {
  let reject!: (error: Error) => void;
  const failed = new Promise<never>((_, failure) => { reject = failure; });
  void failed.catch(() => undefined);
  let count = 0;
  const pending = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    if (!request.url?.split("?")[0]?.endsWith("/messages")) {
      response.setHeader("content-type", "application/json"); response.end('{"input_tokens":100}'); return;
    }
    const started = performance.now();
    const abort = new AbortController(); pending.add(abort);
    const requestTimeoutMs = options.requestTimeoutMs ?? 45000;
    const timeout = setTimeout(() => abort.abort(), requestTimeoutMs);
    const measurement: ProbeMeasurement = { status: 0, elapsedMs: 0, firstContentMs: null, usage: null, complete: false, stopReason: null, toolNames: [] };
    try {
      if (++count > options.maximumRequests) throw new Error("Probe request limit reached");
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error("Probe body limit reached");
      }
      const input = JSON.parse(body) as ProbeRequest;
      if (typeof input.max_tokens !== "number") {
        throw new Error("Request output-token value missing");
      }
      if (options.maximumOutputTokens !== undefined && input.max_tokens > options.maximumOutputTokens) {
        throw new Error(`Request output-token limit exceeded (${String(input.max_tokens)} > ${options.maximumOutputTokens})`);
      }
      options.inspect(input);
      if (options.stableUserId) { input.metadata = { ...input.metadata, user_id: options.stableUserId }; body = JSON.stringify(input); }
      if (!options.upstream) {
        const reply = options.localReply!(input);
        const toolReply = "name" in reply;
        measurement.status = 200; measurement.toolNames = toolReply ? [reply.name] : []; measurement.complete = true; measurement.stopReason = toolReply ? "tool_use" : "end_turn";
        response.writeHead(200, { "content-type": "text/event-stream" });
        const send = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        send({ type: "message_start", message: { id: `local_${count}`, type: "message", role: "assistant", model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
        send({ type: "content_block_start", index: 0, content_block: toolReply ? { type: "tool_use", id: `local_tool_${count}`, name: reply.name, input: {} } : { type: "text", text: "" } });
        send({ type: "content_block_delta", index: 0, delta: toolReply ? { type: "input_json_delta", partial_json: JSON.stringify(reply.input) } : { type: "text_delta", text: reply.text } });
        send({ type: "content_block_stop", index: 0 });
        send({ type: "message_delta", delta: { stop_reason: measurement.stopReason, stop_sequence: null }, usage: { output_tokens: 1 } });
        send({ type: "message_stop" });
        measurement.elapsedMs = Math.round(performance.now() - started); options.measured(measurement); response.end(); return;
      }
      const target = new URL(options.upstream);
      target.pathname = target.pathname.replace(/\/$/, "") + request.url!.split("?")[0]!;
      target.search = new URL(request.url!, "http://localhost").search;
      const headers: Record<string, string> = {};
      for (const name of ["authorization", "x-api-key", "anthropic-version", "anthropic-beta", "content-type"]) {
        const value = request.headers[name]; if (typeof value === "string") headers[name] = value;
      }
      const provider = await fetch(target, { method: "POST", headers, body, signal: abort.signal });
      measurement.status = provider.status;
      if (!provider.ok || !provider.body) throw new Error(`Provider HTTP ${provider.status}; body withheld`);
      response.writeHead(provider.status, { "content-type": provider.headers.get("content-type") ?? "text/event-stream" });
      let carry = ""; const decoder = new TextDecoder();
      const parse = (frame: string) => {
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (!data) return;
        let event: { type?: string; usage?: ProbeUsage; delta?: { stop_reason?: string }; content_block?: { type?: string; name?: string } };
        try { event = JSON.parse(data); } catch { return; }
        if (event.type === "content_block_delta") measurement.firstContentMs ??= Math.round(performance.now() - started);
        if (event.type === "content_block_start" && event.content_block?.type === "tool_use" && event.content_block.name) measurement.toolNames.push(event.content_block.name);
        if (event.type === "message_delta") {
          if (event.usage) measurement.usage = Object.fromEntries(Object.entries(event.usage).filter((entry) => typeof entry[1] === "number"));
          measurement.stopReason = event.delta?.stop_reason ?? measurement.stopReason;
        }
        if (event.type === "message_stop") measurement.complete = true;
      };
      for await (const chunk of provider.body) {
        response.write(chunk); carry += decoder.decode(chunk, { stream: true });
        const frames = carry.split(/\r?\n\r?\n/); carry = frames.pop() ?? "";
        for (const frame of frames) parse(frame);
      }
      carry += decoder.decode(); if (carry.trim()) parse(carry);
      measurement.elapsedMs = Math.round(performance.now() - started); options.measured(measurement); response.end();
      if (!measurement.complete) throw new Error("Provider incomplete stream");
    } catch (error) {
      measurement.elapsedMs = Math.round(performance.now() - started);
      options.onFailure?.(measurement);
      response.destroy();
      const message = abort.signal.aborted
        ? `Provider request timed out after ${requestTimeoutMs}ms`
        : error instanceof Error ? error.message : String(error);
      const safe = /^(Probe|Provider|Request output-token|Unexpected token|Unexpected end)/.test(message)
        ? message
        : "Experiment request failed; details withheld";
      reject(new Error(safe));
    } finally { clearTimeout(timeout); pending.delete(abort); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, failed,
    async close() { for (const abort of pending) abort.abort(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
