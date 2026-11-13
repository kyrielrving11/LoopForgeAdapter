export interface McpContentItem {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpToolResult {
  content?: McpContentItem[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface LoopForgePromptMetadata {
  contextMode: "same_round_retry" | "fresh_invocation";
  contextReason: string;
  submissionHandle?: unknown;
  submission_guidance?: unknown;
  [key: string]: unknown;
}

export type LoopForgeResultClassification =
  | { kind: "prompt"; prompt: string; metadata: LoopForgePromptMetadata; result: McpToolResult }
  | { kind: "terminal"; result: McpToolResult }
  | { kind: "error"; result: McpToolResult }
  | { kind: "invalid"; reason: string; result: McpToolResult };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetadata(value: string): LoopForgePromptMetadata | null {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (!isRecord(parsed)) return null;
  if (parsed.contextMode !== "same_round_retry" && parsed.contextMode !== "fresh_invocation") return null;
  if (typeof parsed.contextReason !== "string" || parsed.contextReason.length === 0) return null;
  return parsed as LoopForgePromptMetadata;
}

function isJsonObjectText(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed);
  } catch {
    return false;
  }
}

export function classifyLoopForgeNextResult(result: McpToolResult): LoopForgeResultClassification {
  if (result.isError === true) return { kind: "error", result };
  const content = result.content;
  if (!Array.isArray(content)) return { kind: "invalid", reason: "MCP result has no content array", result };
  const promptItem = content.find((item) => item?.type === "text" && typeof item.text === "string" && item.text.length > 0);
  if (!promptItem || typeof promptItem.text !== "string") return { kind: "terminal", result };
  const promptIndex = content.indexOf(promptItem);
  const metadataItem = content.slice(promptIndex + 1).find((item) => item?.type === "text" && typeof item.text === "string");
  if (!metadataItem || typeof metadataItem.text !== "string") {
    if (isJsonObjectText(promptItem.text)) return { kind: "terminal", result };
    return { kind: "invalid", reason: "Prompt result has no structured metadata content block", result };
  }
  const metadata = parseMetadata(metadataItem.text);
  if (!metadata) return { kind: "invalid", reason: "Prompt result metadata is not a legal LoopForge envelope", result };
  return { kind: "prompt", prompt: promptItem.text, metadata, result };
}

export const classifyLoopForgePromptResult = classifyLoopForgeNextResult;

export function isSupervisorOwnedTool(name: string): boolean {
  return new Set(["loopforge_start", "loopforge_resume", "loopforge_pause", "loopforge_stop"]).has(name);
}
