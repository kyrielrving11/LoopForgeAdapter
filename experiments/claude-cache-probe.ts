import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeDriver, type PtyFactory } from "../src/hosts/claude.js";
import { LoopForgeSupervisor } from "../src/supervisor.js";
import type { LoopForgeMcpClient } from "../src/mcp/bridge.js";

// Standalone, synthetic experiment. Never a runtime proxy, transcript store or
// LoopForge evidence provider. No request/response bodies or credentials persist.
interface Observation {
  roundIndex: number;
  systemHash: string;
  toolsHash: string;
  attributionBlock: boolean;
  previousRoundAbsent: boolean;
  fixedReferencePresent: boolean;
  status: number;
  firstByteMs: number | null;
  elapsedMs: number;
  finalUsage: Record<string, number> | null;
  complete: boolean;
  nativeUserHash: string | null;
  upstreamUserHash: string | null;
  nativeUserFields: string[];
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const numericUsage = (value: unknown): Record<string, number> | null => {
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
};

async function directControl(upstream: URL) {
  const system = "Synthetic cache availability control " + randomUUID() + "\n" + Array.from({ length: 180 }, (_, i) =>
    `Static reference ${i}: preserve exact original instructions, use live tool schemas, keep current task evidence separate from capability references.\n`).join("");
  const observations = [];
  for (const [i, label] of ["A", "A", "B", "C"].entries()) {
    if (i) await new Promise((resolve) => setTimeout(resolve, 6000));
    const started = performance.now();
    const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
    if (process.env.ANTHROPIC_AUTH_TOKEN) headers.authorization = "Bearer " + process.env.ANTHROPIC_AUTH_TOKEN;
    else headers["x-api-key"] = process.env.ANTHROPIC_API_KEY!;
    const response = await fetch(upstream.href.replace(/\/$/, "") + "/v1/messages", {
      method: "POST", headers, signal: AbortSignal.timeout(30000), body: JSON.stringify({
        model: "deepseek-flash", max_tokens: 32, thinking: { type: "disabled" }, system,
        messages: [{ role: "user", content: "Synthetic request " + label + ". Reply only OK." }],
      }),
    });
    if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}; response body withheld`);
    const body = await response.json() as { usage?: unknown };
    observations.push({ request: label, exactRepeat: i === 1, elapsedMs: Math.round(performance.now() - started), usage: numericUsage(body.usage) });
  }
  return { measuredAt: new Date().toISOString(), model: "deepseek-flash", intervalMs: 6000,
    kind: "direct-anthropic-exact-repeat-and-shared-prefix-control", observations };
}

async function runTrial(live: boolean, omitAttribution: boolean, stableUser: boolean, root: string, upstream: URL | undefined) {
  const workspace = path.join(root, "workspace");
  const config = path.join(root, "config");
  const reference = path.join(root, "capability.md");
  const nonce = randomUUID();
  const markers = [0, 1, 2].map((round) => `SYNTHETIC_ROUND_${nonce}_${round}`);
  const observations: Observation[] = [];
  const systems: string[] = [];
  const requests: string[] = [];
  const stableUserId = "loopforge_probe_" + randomUUID().replaceAll("-", "");
  let rejectProbe!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => { rejectProbe = reject; });
  void failed.catch(() => undefined);
  const pending = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    if (!request.url?.split("?")[0]?.endsWith("/messages")) {
      response.setHeader("content-type", "application/json"); response.end('{"input_tokens":100}'); return;
    }
    const started = performance.now();
    const abort = new AbortController(); pending.add(abort);
    const timeout = setTimeout(() => abort.abort(), 45000);
    try {
      if (observations.length >= 4) throw new Error("Probe request limit reached; no further provider requests allowed");
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const input = JSON.parse(body) as { model: string; max_tokens?: number; system?: unknown; tools?: Array<{ name: string }>; messages: unknown; metadata?: { user_id?: string } };
      if (live && (typeof input.max_tokens !== "number" || input.max_tokens > 256)) throw new Error("Native output limit was not applied; refusing paid request");
      const system = JSON.stringify(input.system);
      const messages = JSON.stringify(input.messages);
      systems.push(system); requests.push(body);
      const nativeUser = input.metadata?.user_id;
      let nativeUserFields: string[] = [];
      if (nativeUser) { try { nativeUserFields = Object.keys(JSON.parse(nativeUser)).sort(); } catch { /* Opaque user ID. */ } }
      // Experimental identity control only. Each trial gets its own namespace;
      // this does not share provider cache identities across actual users.
      if (stableUser) { input.metadata = { ...input.metadata, user_id: stableUserId }; body = JSON.stringify(input); }
      const index = observations.length;
      const roundIndex = markers.findIndex((marker) => messages.includes(marker));
      assert.ok(roundIndex >= 0, "Expected current synthetic round marker");
      const observation: Observation = {
        roundIndex,
        systemHash: hash(system), toolsHash: hash(JSON.stringify(input.tools ?? [])),
        attributionBlock: system.includes("x-anthropic-billing-header"),
        previousRoundAbsent: markers.slice(0, roundIndex).every((marker) => !body.includes(marker)),
        fixedReferencePresent: system.includes("SYNTHETIC_FIXED_CAPABILITY_REFERENCE"),
        status: 200, firstByteMs: null, elapsedMs: 0, finalUsage: null, complete: false,
        nativeUserHash: nativeUser === undefined ? null : hash(nativeUser),
        upstreamUserHash: input.metadata?.user_id === undefined ? null : hash(input.metadata.user_id), nativeUserFields,
      };
      observations.push(observation);
      if (!live) {
        const tool = input.tools?.find(({ name }) => name.endsWith("loopforge_next"))?.name;
        assert.ok(tool, "Expected synthetic submission tool");
        response.writeHead(200, { "content-type": "text/event-stream" });
        const send = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        send({ type: "message_start", message: { id: `probe_${index}`, type: "message", role: "assistant", model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
        send({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `probe_tool_${index}`, name: tool, input: {} } });
        send({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
        send({ type: "content_block_stop", index: 0 });
        send({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } });
        send({ type: "message_stop" }); response.end();
        observation.complete = true; observation.elapsedMs = Math.round(performance.now() - started);
        return;
      }
      const headers: Record<string, string> = {};
      for (const name of ["authorization", "x-api-key", "anthropic-version", "anthropic-beta", "content-type"]) {
        const value = request.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      const target = new URL(upstream!);
      target.pathname = target.pathname.replace(/\/$/, "") + request.url!.split("?")[0]!;
      target.search = new URL(request.url!, "http://localhost").search;
      const provider = await fetch(target, { method: "POST", headers, body, signal: abort.signal });
      observation.status = provider.status;
      if (!provider.ok || !provider.body) throw new Error(`Provider returned HTTP ${provider.status}; response body withheld`);
      response.writeHead(provider.status, { "content-type": provider.headers.get("content-type") ?? "text/event-stream" });
      let carry = "";
      const decoder = new TextDecoder();
      const parse = (frame: string) => {
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (!data) return;
        let event: { type?: string; usage?: unknown };
        try { event = JSON.parse(data); } catch { return; }
        // DeepSeek final message_delta usage is cumulative: never add start usage.
        if (event.type === "message_delta" && event.usage) observation.finalUsage = numericUsage(event.usage);
        if (event.type === "message_stop") observation.complete = true;
      };
      for await (const chunk of provider.body) {
        observation.firstByteMs ??= Math.round(performance.now() - started);
        response.write(chunk);
        carry += decoder.decode(chunk, { stream: true });
        const frames = carry.split(/\r?\n\r?\n/); carry = frames.pop() ?? "";
        for (const frame of frames) parse(frame);
      }
      carry += decoder.decode(); if (carry.trim()) parse(carry);
      observation.elapsedMs = Math.round(performance.now() - started);
      response.end();
      if (!observation.complete) throw new Error("Provider stream ended without message_stop");
    } catch (error) {
      // Log no exception from fetch, request headers, provider body or terminal.
      response.destroy();
      rejectProbe(new Error(error instanceof Error && /^(Probe|Native|Provider|Expected)/.test(error.message) ? error.message : "Probe transport failed; details withheld"));
    } finally { clearTimeout(timeout); pending.delete(abort); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  let submissions = 0;
  const round = (index: number) => ({ content: [
    { type: "text", text: `${markers[index]}\nSynthetic transport probe. Do not perform workspace work. Immediately call the available loopforge_next tool exactly once with an empty object. No text response or other tool calls.` },
    { type: "text", text: JSON.stringify({ contextMode: "fresh_invocation", contextReason: "round_boundary", loopId: "probe-loop", sessionId: "probe-session", submissionHandle: `probe-${index}` }) },
  ] });
  const loopforge: LoopForgeMcpClient = {
    async listTools() { return [{ name: "loopforge_next", description: "Synthetic probe: submit an empty object to move to a fresh conversation. No workspace effects.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }]; },
    async callTool(name) {
      if (name === "loopforge_start") return round(0);
      // Provider cache creation is asynchronous. Do not mistake back-to-back
      // cold requests for a definitive absence of prefix caching.
      if (live && submissions < 2) await new Promise((resolve) => setTimeout(resolve, 6000));
      return ++submissions < 3 ? round(submissions) : { content: [{ type: "text", text: '{"ok":true,"stopReason":"completed"}' }] };
    },
  };
  const nodePty = createRequire(import.meta.url)("node-pty") as { spawn: PtyFactory };
  let hostStarts = 0;
  const driver = new ClaudeCodeDriver({
    reuseProcess: true, capabilityFiles: [reference],
    ptyFactory: (file, args, options) => {
      hostStarts++;
      return nodePty.spawn(file, [...args, "--tools", "", "--permission-mode", "dontAsk", "--ax-screen-reader", "--allowedTools=mcp__loopforge-adapter__loopforge_next"], options);
    },
  });
  let complete!: () => void;
  const done = new Promise<void>((resolve) => { complete = resolve; });
  const supervisor = new LoopForgeSupervisor({ host: driver, loopforge, workspace,
    env: { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? "deepseek-flash[1m]",
      ANTHROPIC_AUTH_TOKEN: live ? process.env.ANTHROPIC_AUTH_TOKEN : "local-probe",
      ANTHROPIC_API_KEY: live ? process.env.ANTHROPIC_API_KEY ?? "" : "",
      CLAUDE_CODE_ATTRIBUTION_HEADER: omitAttribution ? "0" : "1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "256", MAX_THINKING_TOKENS: "0", CLAUDE_CODE_EFFORT_LEVEL: "low",
      ENABLE_TOOL_SEARCH: "false", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    onTerminalResult: () => complete(),
  });
  const timer = setTimeout(() => rejectProbe(new Error("Probe timed out; no further requests will be made")), 90000);
  try {
    await Promise.race([supervisor.start({ task: "synthetic cache probe" }), failed]);
    await Promise.race([done, failed]);
    assert.equal(submissions, 3, "three fresh rounds must submit");
    assert.ok(live ? observations.length >= 3 && observations.length <= 4 : observations.length === 3, "bounded provider request count");
    assert.equal(hostStarts, 1, "native process must be reused");
    assert.ok(observations.every((entry) => entry.previousRoundAbsent && entry.fixedReferencePresent && entry.complete));
    if (live) assert.ok(observations.every((entry) => entry.finalUsage !== null), "Actual final provider usage is required");
    const firstSystemDifference = systems[0] === systems[1] ? null : (() => {
      let i = 0; while (systems[0]![i] === systems[1]![i]) i++;
      return { character: i };
    })();
    return { omitAttribution, stableUser, hostStarts, freshConversations: 3, observations, systemIdentical: new Set(systems).size === 1,
      toolsIdentical: new Set(observations.map((entry) => entry.toolsHash)).size === 1, firstSystemDifference,
      // Bodies are intentionally kept in memory only and discarded on return.
      requestBytes: requests.map((body) => Buffer.byteLength(body)) };
  } finally {
    clearTimeout(timer); for (const abort of pending) abort.abort();
    await supervisor.stop("adapter_error"); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function main() {
  const args = process.argv.slice(2);
  let live = false;
  let compareIdentity = false;
  let control = false;
  let output: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--live") live = true;
    else if (args[i] === "--compare-identity") compareIdentity = true;
    else if (args[i] === "--direct-control") control = true;
    else if (args[i] === "--output" && args[i + 1] && !args[i + 1]!.startsWith("--")) output = args[++i];
    else throw new Error("Usage: probe:claude-cache -- [--live] [--compare-identity | --direct-control] [--output FILE]");
  }
  if (control && (!live || compareIdentity)) throw new Error("--direct-control requires --live and cannot combine with --compare-identity");
  let upstream: URL | undefined;
  if (live) {
    upstream = new URL(process.env.ANTHROPIC_BASE_URL ?? "https://api.deepseek.com/anthropic");
    if (upstream.protocol !== "https:" || upstream.hostname !== "api.deepseek.com" || upstream.pathname.replace(/\/$/, "") !== "/anthropic" || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error("Live experiment supports only the official DeepSeek Anthropic endpoint");
    if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) throw new Error("Live experiment requires an existing provider credential in the environment");
    if (!/^deepseek-flash(\[1m\])?$/.test(process.env.ANTHROPIC_MODEL ?? "deepseek-flash[1m]")) throw new Error("Live experiment is limited to deepseek-flash");
  }
  if (control) {
    const report = await directControl(upstream!);
    process.stdout.write(JSON.stringify(report) + "\n");
    if (output) writeFileSync(path.resolve(output), JSON.stringify(report, null, 2) + "\n");
    return;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "loopforge-cache-probe-"));
  try {
    const workspace = path.join(root, "workspace"); const config = path.join(root, "config");
    mkdirSync(workspace); mkdirSync(config);
    writeFileSync(path.join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: { [workspace.replaceAll("\\", "/")]: { hasTrustDialogAccepted: true } } }));
    writeFileSync(path.join(root, "capability.md"), "# SYNTHETIC_FIXED_CAPABILITY_REFERENCE\n" + Array.from({ length: 360 }, (_, i) => `Reference ${i}: inspect current inputs, use live tool schemas, and keep source documents authoritative.\n`).join(""));
    const trials = [];
    for (const [omitAttribution, stableUser] of compareIdentity ? [[true, false], [true, true]] as const : [[false, false], [true, false]] as const) {
      const trial = await runTrial(live, omitAttribution, stableUser, root, upstream);
      trials.push(trial); process.stdout.write(JSON.stringify({ trial: stableUser ? "stable-provider-user" : omitAttribution ? "omit-attribution" : "native-default", ...trial }) + "\n");
    }
    const report = { measuredAt: new Date().toISOString(), mode: live ? "live-deepseek" : "local-scripted-no-provider-cache-measurement", node: process.version,
      model: process.env.ANTHROPIC_MODEL ?? "deepseek-flash[1m]", referenceLines: 360, settleMs: live ? 6000 : 0, trials };
    if (output) writeFileSync(path.resolve(output), JSON.stringify(report, null, 2) + "\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
}

void main().catch((error: unknown) => { process.stderr.write((error instanceof Error ? error.message : "Cache probe failed") + "\n"); process.exitCode = 1; });
