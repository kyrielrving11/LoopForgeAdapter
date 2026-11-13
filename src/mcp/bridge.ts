import {
  classifyLoopForgeNextResult,
  isSupervisorOwnedTool,
  type LoopForgeResultClassification,
  type McpToolResult,
} from "./loopforge-result.js";

export interface McpToolDefinition {
  name: string;
  [key: string]: unknown;
}

export interface LoopForgeMcpClient {
  listTools(): Promise<McpToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

export type BridgeCallResult =
  | { kind: "forward"; result: McpToolResult }
  | { kind: "same_round_retry"; classification: Extract<LoopForgeResultClassification, { kind: "prompt" }>; result: McpToolResult }
  | { kind: "fresh_invocation"; classification: Extract<LoopForgeResultClassification, { kind: "prompt" }>; result: McpToolResult }
  | { kind: "terminal"; result: McpToolResult }
  | { kind: "error"; result: McpToolResult }
  | { kind: "invalid"; reason: string; result: McpToolResult };

/**
 * Host-neutral LoopForge MCP routing. The caller owns the actual MCP server
 * transport and decides how a fresh result is withheld from the old host
 * invocation. This object never stores a handle, round cursor, or transcript.
 */
export class LoopForgeMcpBridge {
  constructor(private readonly client: LoopForgeMcpClient) {}

  async listAgentTools(): Promise<McpToolDefinition[]> {
    const tools = await this.client.listTools();
    return tools.filter((tool) => !isSupervisorOwnedTool(tool.name));
  }

  async callAgentTool(name: string, args: Record<string, unknown>): Promise<BridgeCallResult> {
    if (isSupervisorOwnedTool(name)) {
      throw new Error(`Supervisor-owned LoopForge tool cannot be called by the Agent: ${name}`);
    }
    const result = await this.client.callTool(name, args);
    if (name !== "loopforge_next") return { kind: "forward", result };

    const classification = classifyLoopForgeNextResult(result);
    switch (classification.kind) {
      case "prompt":
        return classification.metadata.contextMode === "fresh_invocation"
          ? { kind: "fresh_invocation", classification, result }
          : { kind: "same_round_retry", classification, result };
      case "terminal": return { kind: "terminal", result };
      case "error": return { kind: "error", result };
      case "invalid": return { kind: "invalid", reason: classification.reason, result };
    }
  }
}
