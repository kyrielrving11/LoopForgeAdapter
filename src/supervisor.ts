import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HostCapabilities, HostDriver, InvocationHandle, InvocationInput } from "./host/contracts.js";
import { LoopForgeMcpBridge, type BridgeCallResult, type LoopForgeMcpClient } from "./mcp/bridge.js";
import { BridgeControlServer, type BridgeControlRequest, type BridgeControlResponse, type BridgeToolDecision } from "./mcp/control.js";
import { classifyLoopForgePromptResult, type McpToolResult } from "./mcp/loopforge-result.js";

const REQUIRED_AUTOMATIC_CAPABILITIES: Array<keyof HostCapabilities> = [
  "cleanConversation",
  "interactiveTransport",
  "roundMetadataDelivery",
  "promptDeliveryConfirmation",
  "hardStop",
  "workspaceContinuity",
  "toolResultInterception",
];

export class AutomaticBoundaryUnavailableError extends Error {
  constructor(readonly missing: Array<keyof HostCapabilities>) {
    super(`Automatic boundary mode is unavailable: ${missing.join(", ")}`);
    this.name = "AutomaticBoundaryUnavailableError";
  }
}

export type AgentToolResult =
  | { kind: "deliver"; invocationId: string; result: McpToolResult }
  | { kind: "handoff"; previousInvocationId: string; replacementInvocationId: string; result: McpToolResult }
  | { kind: "terminal"; previousInvocationId: string; result: McpToolResult };

export interface SupervisorOptions {
  host: HostDriver;
  loopforge: LoopForgeMcpClient;
  workspace: string;
  mcpConfigPath?: string;
  env?: NodeJS.ProcessEnv;
  bridgeServerPath?: string;
  bridgeServerName?: string;
  onTerminalResult?: (result: McpToolResult) => void;
}

/**
 * Owns orchestration only. LoopForge remains authoritative for lifecycle and
 * prompt facts; the host remains authoritative for the Agent process.
 */
export class LoopForgeSupervisor {
  private readonly bridge: LoopForgeMcpBridge;
  private readonly host: HostDriver;
  private readonly loopforge: LoopForgeMcpClient;
  private readonly workspace: string;
  private readonly mcpConfigPath: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly bridgeServerPath: string;
  private readonly bridgeServerName: string;
  private readonly onTerminalResult: ((result: McpToolResult) => void) | undefined;
  private operations: Promise<void> = Promise.resolve();
  private active: InvocationHandle | undefined;
  private activeControl: BridgeControlServer | undefined;
  private activeControlEndpoint: { address: string; token: string } | undefined;
  private activeSessionId: string | undefined;
  private activeLoopId: string | undefined;
  private capabilities: HostCapabilities | undefined;

  constructor(options: SupervisorOptions) {
    this.host = options.host;
    this.loopforge = options.loopforge;
    this.bridge = new LoopForgeMcpBridge(options.loopforge);
    this.workspace = options.workspace;
    this.mcpConfigPath = options.mcpConfigPath;
    this.env = options.env;
    this.bridgeServerPath = options.bridgeServerPath ?? path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "mcp/bridge-server.js",
    );
    this.bridgeServerName = options.bridgeServerName ?? "loopforge-adapter";
    this.onTerminalResult = options.onTerminalResult;
  }

  get activeInvocationId(): string | undefined {
    return this.active?.invocationId;
  }

  get activeInvocation(): InvocationHandle | undefined {
    return this.active;
  }

  get activeLoopSessionId(): string | undefined {
    return this.activeSessionId;
  }

  get activeLoopIdValue(): string | undefined {
    return this.activeLoopId;
  }

  async probe(): Promise<HostCapabilities> {
    return this.runExclusive(async () => {
      this.capabilities = await this.host.probe();
      return this.capabilities;
    });
  }

  async start(args: Record<string, unknown>): Promise<InvocationHandle | undefined> {
    return this.startLifecycle("loopforge_start", args);
  }

  async resume(args: Record<string, unknown>): Promise<InvocationHandle | undefined> {
    return this.startLifecycle("loopforge_resume", args);
  }

  async handleAgentToolCall(name: string, args: Record<string, unknown>, admission?: string): Promise<AgentToolResult> {
    const invocationId = this.active?.invocationId;
    return this.runExclusive(async () => {
      const current = this.active;
      if (!current || current.invocationId !== invocationId) throw new Error("Agent invocation is inactive or stale");
      const release = this.host.beginToolCall?.(current, name, admission);
      try {
        const decision = await this.bridge.callAgentTool(name, args);
        return await this.applyAgentDecision(current, decision);
      } finally { release?.(); }
    });
  }

  /** Wait for an in-flight handoff before the CLI selects the next stream. */
  async nextInvocation(previousId: string): Promise<InvocationHandle | undefined> {
    return this.runExclusive(async () => this.active?.invocationId === previousId ? undefined : this.active);
  }

  async stop(reason: "terminal" | "user_interrupt" | "adapter_error" = "terminal"): Promise<void> {
    await this.runExclusive(async () => {
      const current = this.active;
      if (!current) return;
      await this.host.stopInvocation(current, reason);
      this.active = undefined;
      await this.activeControl?.close();
      this.activeControl = undefined;
      this.activeSessionId = undefined;
      this.activeLoopId = undefined;
    });
  }

  async pause(): Promise<McpToolResult | undefined> {
    return this.runExclusive(async () => {
      const current = this.active;
      const sessionId = this.activeSessionId;
      if (!current || !sessionId) return undefined;
      await this.host.stopInvocation(current, "user_interrupt");
      this.active = undefined;
      await this.activeControl?.close();
      this.activeControl = undefined;
      this.activeSessionId = undefined;
      this.activeLoopId = undefined;
      return this.loopforge.callTool("loopforge_pause", { sessionId });
    });
  }

  private async startLifecycle(tool: "loopforge_start" | "loopforge_resume", args: Record<string, unknown>): Promise<InvocationHandle | undefined> {
    return this.runExclusive(async () => {
      if (this.active) throw new Error("A LoopForge invocation is already active");
      await this.ensureAutomaticCapabilities();
      const result = await this.loopforge.callTool(tool, args);
      const classification = classifyLoopForgePromptResult(result);
      if (classification.kind === "terminal") {
        this.onTerminalResult?.(result);
        return undefined;
      }
      if (classification.kind !== "prompt") {
        throw new Error(`LoopForge ${tool} did not return a held prompt (${classification.kind})`);
      }
      const control = await this.openControl();
      try {
        const invocation = await this.host.startInvocation(this.inputFor(classification.prompt, classification.metadata, control));
        this.active = invocation;
        this.activeControl = control.server;
        this.activeControlEndpoint = control.endpoint;
        this.activeSessionId = this.sessionIdFrom(classification.metadata);
        this.activeLoopId = this.loopIdFrom(classification.metadata);
        return invocation;
      } catch (error) {
        await control.server.close();
        throw error;
      }
    });
  }

  private async ensureAutomaticCapabilities(): Promise<void> {
    const capabilities = this.capabilities ?? await this.host.probe();
    this.capabilities = capabilities;
    const missing = REQUIRED_AUTOMATIC_CAPABILITIES.filter((capability) => !capabilities[capability]);
    if (missing.length > 0) throw new AutomaticBoundaryUnavailableError(missing);
  }

  private inputFor(
    prompt: string,
    metadata: Record<string, unknown>,
    control: { endpoint: { address: string; token: string }; server: BridgeControlServer },
  ): InvocationInput {
    return {
      prompt,
      metadata,
      workspace: this.workspace,
      bridge: {
        serverName: this.bridgeServerName,
        command: process.execPath,
        args: [this.bridgeServerPath],
        env: {
          LOOPFORGE_ADAPTER_CONTROL_ENDPOINT: control.endpoint.address,
          LOOPFORGE_ADAPTER_CONTROL_TOKEN: control.endpoint.token,
        },
      },
      ...(this.mcpConfigPath === undefined ? {} : { mcpConfigPath: this.mcpConfigPath }),
      ...(this.env === undefined ? {} : { env: this.env }),
    };
  }

  private async applyAgentDecision(current: InvocationHandle, decision: BridgeCallResult): Promise<AgentToolResult> {
    switch (decision.kind) {
      case "forward":
      case "same_round_retry":
      case "error":
      case "invalid":
        return { kind: "deliver", invocationId: current.invocationId, result: decision.result };
      case "terminal":
        await this.host.stopInvocation(current, "terminal");
        this.active = undefined;
        await this.activeControl?.close();
        this.activeControl = undefined;
        this.activeSessionId = undefined;
        this.activeLoopId = undefined;
        this.onTerminalResult?.(decision.result);
        return { kind: "terminal", previousInvocationId: current.invocationId, result: decision.result };
      case "fresh_invocation": {
        if (this.host.replaceInvocation && this.activeControl && this.activeControlEndpoint) {
          try {
            const replacement = await this.host.replaceInvocation(current, this.inputFor(
              decision.classification.prompt, decision.classification.metadata,
              { server: this.activeControl, endpoint: this.activeControlEndpoint },
            ));
            this.active = replacement;
            this.activeSessionId = this.sessionIdFrom(decision.classification.metadata);
            this.activeLoopId = this.loopIdFrom(decision.classification.metadata);
            return { kind: "handoff", previousInvocationId: current.invocationId,
              replacementInvocationId: replacement.invocationId, result: decision.result };
          } catch (error) {
            await this.activeControl.close();
            this.activeControl = undefined;
            this.activeControlEndpoint = undefined;
            throw error;
          }
        }
        await this.host.stopInvocation(current, "fresh_invocation");
        this.active = undefined;
        await this.activeControl?.close();
        this.activeControl = undefined;
        const control = await this.openControl();
        try {
          const replacement = await this.host.startInvocation(this.inputFor(decision.classification.prompt, decision.classification.metadata, control));
          this.active = replacement;
          this.activeControl = control.server;
          this.activeControlEndpoint = control.endpoint;
          this.activeSessionId = this.sessionIdFrom(decision.classification.metadata);
          this.activeLoopId = this.loopIdFrom(decision.classification.metadata);
          return {
            kind: "handoff",
            previousInvocationId: current.invocationId,
            replacementInvocationId: replacement.invocationId,
            result: decision.result,
          };
        } catch (error) {
          await control.server.close();
          throw error;
        }
      }
    }
  }

  private async openControl(): Promise<{ endpoint: { address: string; token: string }; server: BridgeControlServer }> {
    const server = new BridgeControlServer();
    const endpoint = await server.listen((request) => this.handleControlRequest(request));
    return { endpoint, server };
  }

  private sessionIdFrom(metadata: Record<string, unknown>): string | undefined {
    return typeof metadata.sessionId === "string" && metadata.sessionId.length > 0
      ? metadata.sessionId
      : undefined;
  }

  private loopIdFrom(metadata: Record<string, unknown>): string | undefined {
    return typeof metadata.loopId === "string" && metadata.loopId.length > 0
      ? metadata.loopId
      : undefined;
  }

  private async handleControlRequest(request: BridgeControlRequest): Promise<BridgeControlResponse> {
    if (request.type === "list_tools") {
      return { type: "list_tools_result", requestId: request.requestId, tools: await this.bridge.listAgentTools() };
    }
    const decision = await this.handleAgentToolCall(request.name, request.args, request.admission);
    return {
      type: "call_tool_result",
      requestId: request.requestId,
      decision: this.controlDecision(decision),
    };
  }

  private controlDecision(decision: AgentToolResult): BridgeToolDecision {
    switch (decision.kind) {
      case "deliver": return { kind: "deliver", result: decision.result };
      case "handoff": return { kind: "handoff", result: decision.result };
      case "terminal": return { kind: "terminal", result: decision.result };
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operations.then(operation, operation);
    this.operations = run.then(() => undefined, () => undefined);
    return run;
  }
}
