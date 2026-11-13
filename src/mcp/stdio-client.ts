import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { LoopForgeMcpClient, McpToolDefinition } from "./bridge.js";
import type { McpToolResult } from "./loopforge-result.js";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export interface StdioMcpClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: (
    command: string,
    args: string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
  ) => ChildProcessWithoutNullStreams;
}

export class McpRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "McpRpcError";
  }
}

/** A single long-lived JSON-lines MCP client. It owns transport only. */
export class StdioMcpClient implements LoopForgeMcpClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private lineReader?: ReturnType<typeof createInterface>;
  private nextId = 1;
  private started: Promise<void> | undefined;
  private readonly pending = new Map<number, { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private readonly spawnProcess: NonNullable<StdioMcpClientOptions["spawnProcess"]>;

  constructor(private readonly options: StdioMcpClientOptions) {
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.request("tools/list", {});
    if (!Array.isArray(result.tools)) throw new Error("MCP tools/list returned no tools array");
    return result.tools as McpToolDefinition[];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.request("tools/call", { name, arguments: args });
    return result as McpToolResult;
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    this.lineReader?.close();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.kill();
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);
    this.child = undefined;
    this.started = undefined;
    this.rejectPending(new Error("MCP client closed"));
  }

  private async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureStarted();
    return this.sendRequest(method, params);
  }

  private ensureStarted(): Promise<void> {
    if (this.started) return this.started;
    this.started = this.startTransport();
    return this.started;
  }

  private async startTransport(): Promise<void> {
    const spawnOptions = {
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    };
    const child = this.spawnProcess(this.options.command, this.options.args ?? [], spawnOptions);
    this.child = child;
    child.stdout.setEncoding("utf8");
    this.lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lineReader.on("line", (line) => this.handleLine(line));
    child.once("error", (error) => this.rejectPending(error instanceof Error ? error : new Error(String(error))));
    child.once("close", (code, signal) => {
      this.rejectPending(new Error(`MCP process exited (${code ?? "null"}, ${signal ?? "null"})`));
    });
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "loopforge-adapter", version: "0.1.0" },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("MCP transport is not started"));
    const id = this.nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let response: JsonRpcResponse;
    try { response = JSON.parse(line) as JsonRpcResponse; } catch { return; }
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.error) pending.reject(new McpRpcError(response.error.code, response.error.message, response.error.data));
    else if (!response.result) pending.reject(new Error("MCP response has no result"));
    else pending.resolve(response.result);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
