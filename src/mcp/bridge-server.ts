import { createInterface } from "node:readline";
import { BridgeControlClient, bridgeResultForAgent, type BridgeControlEndpoint } from "./control.js";
import { HOST_ADMISSION_FIELD } from "../host/contracts.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reply(id: number | string | null | undefined, result: Record<string, unknown>): void {
  if (id === undefined) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function errorReply(id: number | string | null | undefined, code: number, message: string): void {
  if (id === undefined) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function requestFromLine(line: string): JsonRpcRequest | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed) || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") return undefined;
    return parsed as unknown as JsonRpcRequest;
  } catch {
    return undefined;
  }
}

function endpointFromEnvironment(): BridgeControlEndpoint {
  const address = process.env.LOOPFORGE_ADAPTER_CONTROL_ENDPOINT;
  const token = process.env.LOOPFORGE_ADAPTER_CONTROL_TOKEN;
  if (!address || !token) throw new Error("LoopForge bridge control endpoint is not configured");
  return { address, token };
}

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

async function run(): Promise<void> {
  const control = new BridgeControlClient(endpointFromEnvironment());
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  const handle = async (request: JsonRpcRequest): Promise<void> => {
    try {
      switch (request.method) {
        case "initialize":
          reply(request.id, {
            protocolVersion: typeof request.params?.protocolVersion === "string" &&
              SUPPORTED_PROTOCOL_VERSIONS.includes(request.params.protocolVersion as typeof SUPPORTED_PROTOCOL_VERSIONS[number])
              ? request.params.protocolVersion
              : SUPPORTED_PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: "loopforge-adapter-bridge", version: "0.1.0" },
            instructions: "The Adapter owns LoopForge lifecycle start, resume, pause, and stop. Use the live LoopForge tools, schemas, prompt, and submission_guidance for all round field meanings and decisions.",
          });
          return;
        case "ping":
          reply(request.id, {});
          return;
        case "notifications/initialized":
        case "notifications/cancelled":
          return;
        case "tools/list": {
          const tools = await control.listTools();
          reply(request.id, { tools });
          return;
        }
        case "tools/call": {
          const name = request.params?.name;
          const args = request.params?.arguments;
          if (typeof name !== "string" || !isRecord(args)) {
            errorReply(request.id, -32602, "tools/call requires a tool name and object arguments");
            return;
          }
          const { [HOST_ADMISSION_FIELD]: admission, ...payload } = args;
          const decision = await control.callTool(name, payload, typeof admission === "string" ? admission : undefined);
          const result = bridgeResultForAgent(decision);
          if (result) reply(request.id, result);
          // A fresh or terminal decision is intentionally withheld. The
          // supervisor retires the old session or stops its host before
          // delivering any subsequent prompt.
          return;
        }
        default:
          errorReply(request.id, -32601, `Unsupported method ${request.method}`);
      }
    } catch (error: unknown) {
      errorReply(request.id, -32000, error instanceof Error ? error.message : String(error));
    }
  };
  input.on("line", (line) => {
    if (!line.trim()) return;
    const request = requestFromLine(line);
    if (!request) {
      errorReply(undefined, -32700, "Invalid JSON-RPC request");
      return;
    }
    const operation = handle(request);
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  });
  await new Promise<void>((resolve) => input.once("close", resolve));
  await Promise.all(pending);
  await control.close();
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
