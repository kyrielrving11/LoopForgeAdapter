import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import type { McpToolDefinition } from "./bridge.js";
import type { McpToolResult } from "./loopforge-result.js";

export type BridgeControlRequest =
  | { type: "list_tools"; requestId: string }
  | { type: "call_tool"; requestId: string; name: string; args: Record<string, unknown>; admission?: string };

export type BridgeControlResponse =
  | { type: "list_tools_result"; requestId: string; tools: McpToolDefinition[] }
  | { type: "call_tool_result"; requestId: string; decision: BridgeToolDecision }
  | { type: "error"; requestId?: string; message: string };

export type BridgeToolDecision =
  | { kind: "deliver"; result: McpToolResult }
  | { kind: "same_round_retry"; result: McpToolResult }
  | { kind: "error"; result: McpToolResult }
  | { kind: "invalid"; result: McpToolResult }
  | { kind: "handoff"; result: McpToolResult }
  | { kind: "terminal"; result: McpToolResult };

interface ControlHello {
  type: "hello";
  token: string;
}

export interface BridgeControlEndpoint {
  address: string;
  token: string;
}

type ControlMessage = ControlHello | BridgeControlRequest | BridgeControlResponse;

function endpointPath(): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\loopforge-adapter-${randomUUID()}`;
  return path.join(os.tmpdir(), `loopforge-adapter-${randomUUID()}.sock`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function send(socket: net.Socket, message: ControlMessage): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

function parseMessage(line: string): ControlMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed as unknown as ControlMessage : undefined;
  } catch {
    return undefined;
  }
}

export type ControlRequestHandler = (request: BridgeControlRequest) => Promise<BridgeControlResponse>;

/**
 * One-use, local-only control endpoint for a single Claude invocation.
 * The random address and token are both required; no network listener is used.
 */
export class BridgeControlServer {
  private readonly address = endpointPath();
  private readonly token = randomUUID();
  private server: net.Server | undefined;
  private socket: net.Socket | undefined;

  async listen(handler: ControlRequestHandler): Promise<BridgeControlEndpoint> {
    if (this.server) throw new Error("Bridge control server is already listening");
    const server = net.createServer((socket) => this.accept(socket, handler));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.address);
    });
    return { address: this.address, token: this.token };
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    this.socket = undefined;
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32") rmSync(this.address, { force: true });
  }

  private accept(socket: net.Socket, handler: ControlRequestHandler): void {
    if (this.socket) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    let authenticated = false;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const message = parseMessage(line);
        if (!message) {
          socket.destroy();
          return;
        }
        if (!authenticated) {
          if (message.type !== "hello" || message.token !== this.token) {
            socket.destroy();
            return;
          }
          authenticated = true;
          continue;
        }
        if (message.type !== "list_tools" && message.type !== "call_tool") continue;
        void handler(message).then((response) => {
          if (!socket.destroyed) send(socket, response);
        }).catch((error: unknown) => {
          if (!socket.destroyed) send(socket, {
            type: "error",
            requestId: message.requestId,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
    });
    socket.once("close", () => {
      if (this.socket === socket) this.socket = undefined;
    });
    socket.once("error", () => {
      if (this.socket === socket) this.socket = undefined;
    });
  }
}

export class BridgeControlClient {
  private socket: net.Socket | undefined;
  private buffer = "";
  private connected: Promise<void> | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<string, {
    resolve: (response: BridgeControlResponse) => void;
    reject: (error: Error) => void;
  }>();

  constructor(private readonly endpoint: BridgeControlEndpoint) {}

  async listTools(): Promise<McpToolDefinition[]> {
    const response = await this.request({ type: "list_tools", requestId: this.newRequestId() });
    if (response.type !== "list_tools_result") throw new Error(response.type === "error" ? response.message : "Invalid list_tools response");
    return response.tools;
  }

  async callTool(name: string, args: Record<string, unknown>, admission?: string): Promise<BridgeToolDecision> {
    const response = await this.request({ type: "call_tool", requestId: this.newRequestId(), name, args, ...(admission === undefined ? {} : { admission }) });
    if (response.type !== "call_tool_result") throw new Error(response.type === "error" ? response.message : "Invalid call_tool response");
    return response.decision;
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    this.socket = undefined;
    this.connected = undefined;
    this.rejectPending(new Error("Bridge control client closed"));
  }

  private newRequestId(): string {
    return `${process.pid}-${this.nextRequestId++}`;
  }

  private async request(request: BridgeControlRequest): Promise<BridgeControlResponse> {
    await this.connect();
    const socket = this.socket;
    if (!socket) throw new Error("Bridge control socket is not connected");
    return new Promise((resolve, reject) => {
      this.pending.set(request.requestId, { resolve, reject });
      send(socket, request);
    });
  }

  private connect(): Promise<void> {
    if (this.connected) return this.connected;
    this.connected = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.endpoint.address);
      this.socket = socket;
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        send(socket, { type: "hello", token: this.endpoint.token });
        resolve();
      });
      socket.on("data", (chunk: string) => this.handleData(chunk));
      socket.once("error", (error) => {
        this.connected = undefined;
        this.rejectPending(error instanceof Error ? error : new Error(String(error)));
        reject(error);
      });
      socket.once("close", () => {
        this.connected = undefined;
        this.socket = undefined;
        this.rejectPending(new Error("Bridge control server closed"));
      });
    });
    return this.connected;
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const message = parseMessage(line);
      if (!message || message.type === "hello") continue;
      if (message.type !== "list_tools_result" && message.type !== "call_tool_result" && message.type !== "error") continue;
      const requestId = message.requestId;
      if (!requestId) continue;
      const pending = this.pending.get(requestId);
      if (!pending) continue;
      this.pending.delete(requestId);
      pending.resolve(message);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function isBridgeCallResult(value: unknown): value is BridgeToolDecision {
  return isRecord(value) && typeof value.kind === "string" && isRecord(value.result);
}

export function bridgeResultForAgent(decision: BridgeToolDecision): McpToolResult | undefined {
  if (decision.kind === "deliver" || decision.kind === "same_round_retry" || decision.kind === "error" || decision.kind === "invalid") {
    return decision.result;
  }
  return undefined;
}
