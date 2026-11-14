/** Private transport field removed by the bridge before a LoopForge call. */
export const HOST_ADMISSION_FIELD = "__loopforge_adapter_admission";

export interface HostCapabilities {
  cleanConversation: boolean;
  interactiveTransport: boolean;
  roundMetadataDelivery: boolean;
  /** Host-observed initial input must match before readiness or tool execution. */
  promptDeliveryConfirmation: boolean;
  hardStop: boolean;
  workspaceContinuity: boolean;
  toolResultInterception: boolean;
  warmHostRuntime: boolean;
  warmExternalMcp: boolean;
  providerCacheTelemetry: boolean;
}

export interface InvocationInput {
  prompt: string;
  metadata: Record<string, unknown>;
  workspace: string;
  mcpConfigPath?: string;
  bridge?: InvocationBridgeConfig;
  env?: NodeJS.ProcessEnv;
}

export interface InvocationBridgeConfig {
  serverName: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type InvocationStopReason =
  | "fresh_invocation"
  | "terminal"
  | "user_interrupt"
  | "adapter_error";

export type HostEvent =
  | { type: "started"; pid: number; sessionId: string }
  | { type: "output"; data: string }
  | { type: "diagnostic"; message: string }
  /** Native turn ended; this is neither a LoopForge submission nor completion. */
  | { type: "turn_ended"; reason: "response_completed" | "api_error" }
  | { type: "stopping"; reason: InvocationStopReason }
  | { type: "exited"; exitCode: number; signal?: number }
  | { type: "failed"; message: string };

export interface InvocationHandle extends AsyncIterable<HostEvent> {
  readonly invocationId: string;
  readonly sessionId: string;
  readonly pid: number;
  write(data: string): void;
}

export interface HostDriver {
  readonly id: string;
  probe(): Promise<HostCapabilities>;
  /** Resolve only after native session and exact initial input are confirmed. */
  startInvocation(input: InvocationInput): Promise<InvocationHandle>;
  stopInvocation(handle: InvocationHandle, reason: InvocationStopReason): Promise<void>;
  /** Validate one-use execution ownership before forwarding; release on reply. */
  beginToolCall?(handle: InvocationHandle, name: string, admission?: string): () => void;
  /** Retire the old context and confirm the replacement session and input. */
  replaceInvocation?(handle: InvocationHandle, input: InvocationInput): Promise<InvocationHandle>;
}
