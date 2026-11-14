/** Isolated experiment fixture. Never connected to a real LoopForge Vault. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

export interface WorkloadServiceEvent {
  kind: "start" | "received" | "fixture" | "check" | "argument-error" | "injected-error" | "fatal" | "exit";
  pid: number;
  round?: number;
  tool?: string;
  passed?: boolean;
  sourceHash?: string;
  code?: number;
}

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing fixture configuration: ${name}`);
  return value;
};
const source = required("WORKLOAD_SOURCE");
const logFile = required("WORKLOAD_LOG");
const acceptance = required("WORKLOAD_ACCEPTANCE");
const workspace = required("WORKLOAD_WORKSPACE");
const markers = JSON.parse(required("WORKLOAD_MARKERS")) as string[];
const log = (event: Omit<WorkloadServiceEvent, "pid">) => appendFileSync(logFile, JSON.stringify({ ...event, pid: process.pid }) + "\n");
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
let injected = false;
log({ kind: "start" });
process.on("uncaughtExceptionMonitor", () => log({ kind: "fatal" }));
process.on("exit", (code) => log({ kind: "exit", code }));

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let request: Record<string, unknown>;
  try { const parsed: unknown = JSON.parse(line); if (!record(parsed)) return; request = parsed; }
  catch { process.stdout.write('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Invalid JSON"}}\n'); return; }
  if (request.id === undefined) return;
  const reply = (result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  const error = (code: number, message: string) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code, message } }) + "\n");
  const params = record(request.params) ? request.params : {};
  if (request.method === "initialize") {
    reply({ protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "workload", version: "2" } }); return;
  }
  if (request.method === "ping") { reply({}); return; }
  if (request.method === "tools/list") {
    reply({ tools: ["fixture", "check"].map((name) => ({ name,
      description: name === "fixture" ? "Read current task examples and ephemeral tool diagnostic." : "Run independent acceptance checks for the current task and earlier behavior.",
      inputSchema: { type: "object", properties: { round: { type: "integer", minimum: 0, maximum: 2 } }, required: ["round"], additionalProperties: false },
    })) }); return;
  }
  if (request.method !== "tools/call") { error(-32601, "Unknown method"); return; }
  const tool = params.name;
  if (tool !== "fixture" && tool !== "check") { error(-32602, "Unknown tool"); return; }
  const args = record(params.arguments) ? params.arguments : {};
  const round = args.round;
  log({ kind: "received", tool, ...(typeof round === "number" ? { round } : {}) });
  if (!Number.isInteger(round) || typeof round !== "number" || round < 0 || round > 2 || Object.keys(args).some((key) => key !== "round")) {
    log({ kind: "argument-error", tool });
    // Regression-only reproduction of the original handler. No recovery here:
    // the native host must observe a real service death, not a simulated reply.
    if (process.env.WORKLOAD_LEGACY_CRASH === "1") throw new Error("Invalid round");
    reply({ isError: true, content: [{ type: "text", text: "Invalid tool arguments. round must be an integer from 0 to 2 for the current task; no check was run. Correct the arguments and retry." }] }); return;
  }
  if (tool === "fixture") {
    log({ kind: "fixture", round });
    reply({ content: [{ type: "text", text: JSON.stringify({ diagnostic: markers[round], examples: [" Café -> café", "A + a -> one unique tag", "__proto__ is a normal tag key"] }) }] }); return;
  }
  if (process.env.WORKLOAD_INJECT_CHECK_ERROR === "1" && !injected) {
    injected = true; log({ kind: "injected-error", tool, round });
    reply({ isError: true, content: [{ type: "text", text: "DIAGNOSTIC_CHECK_ERROR: one injected tool error; no acceptance command ran. Retry check with the same valid round argument." }] }); return;
  }
  const sourceHash = createHash("sha256").update(readFileSync(source)).digest("hex");
  const checked = spawnSync(process.execPath, [acceptance], { cwd: workspace,
    env: { ...process.env, WORKLOAD_ROUND: String(round) }, encoding: "utf8", timeout: 10000, windowsHide: true, maxBuffer: 65536 });
  const passed = checked.status === 0 && checked.stdout.includes("ACCEPTANCE_PASSED");
  log({ kind: "check", round, passed, sourceHash });
  reply({ content: [{ type: "text", text: JSON.stringify({ passed, exitCode: checked.status,
    observation: passed ? "ACCEPTANCE_PASSED" : "ACCEPTANCE_FAILED" }) }] });
});
