import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

export interface ClaudeHookInput {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  source?: string;
  reason?: string;
  tool_name?: string;
  tool_use_id?: string;
  agent_id?: string;
  /** Execution-control signal only, never an input/output payload. */
  background?: boolean;
}

export interface ClaudeHookEndpoint { address: string; token: string }

/** Ephemeral host lifecycle signals only; no transcript or round facts. */
export class ClaudeLifecycleServer {
  private readonly address = process.platform === "win32"
    ? `\\\\.\\pipe\\loopforge-claude-${randomUUID()}`
    : path.join(os.tmpdir(), `loopforge-claude-${randomUUID()}.sock`);
  private readonly token = randomUUID();
  private readonly sockets = new Set<net.Socket>();
  private server: net.Server | undefined;

  async listen(handler: (input: ClaudeHookInput) => Record<string, unknown>): Promise<ClaudeHookEndpoint> {
    const server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      socket.setTimeout(5000, () => socket.destroy());
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 16384) { socket.destroy(); return; }
        if (!buffer.includes("\n")) return;
        try {
          const message = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as { token?: unknown; input?: ClaudeHookInput };
          const input = message.input;
          if (message.token !== this.token || !input || typeof input.session_id !== "string" ||
            typeof input.hook_event_name !== "string" || typeof input.cwd !== "string") {
            socket.destroy();
            return;
          }
          socket.end(`${JSON.stringify(handler(input))}\n`);
        } catch { socket.destroy(); }
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.address, resolve);
    });
    return { address: this.address, token: this.token };
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32") rmSync(this.address, { force: true });
  }
}

/** Hook subprocess connects only to the driver-owned local endpoint. */
export async function callClaudeLifecycleHook(endpoint: ClaudeHookEndpoint, input: ClaudeHookInput): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint.address);
    let buffer = "";
    let received = false;
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy(new Error("Claude lifecycle hook timed out")));
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify({ token: endpoint.token, input })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      try {
        const output = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as Record<string, unknown>;
        received = true;
        resolve(output);
        socket.destroy();
      } catch (error) { socket.destroy(); reject(error); }
    });
    socket.once("close", () => { if (!received) reject(new Error("Claude lifecycle hook connection closed")); });
  });
}
