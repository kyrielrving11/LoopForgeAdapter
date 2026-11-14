/**
 * Projects LoopForge transport metadata into the small host context Claude
 * may see at SessionStart. The supervisor keeps the original object for
 * routing and handle ownership; this projection is not a second protocol.
 */

export interface ClaudeHostContext {
  authority: "current_prompt_and_live_mcp_schema";
  priorConversation: "not_available";
  workspace: "continues_across_invocations";
}

function isContextMode(value: unknown): value is "same_round_retry" | "fresh_invocation" {
  return value === "same_round_retry" || value === "fresh_invocation";
}

/**
 * Return the fixed host context allowed into Claude's model-visible context.
 * Internal identities, boundary labels, handles, guidance and unknown
 * extension fields stay in the supervisor's transport object. The fixed shape
 * also keeps this system-context prefix stable across rounds.
 */
export function projectClaudeHostContext(metadata: Record<string, unknown>): ClaudeHostContext {
  if (!isContextMode(metadata.contextMode)) throw new Error("LoopForge metadata has no legal context mode");
  if (typeof metadata.contextReason !== "string" || metadata.contextReason.length === 0) {
    throw new Error("LoopForge metadata has an invalid context reason");
  }
  return {
    authority: "current_prompt_and_live_mcp_schema",
    priorConversation: "not_available",
    workspace: "continues_across_invocations",
  };
}

export function renderClaudeHostContext(metadata: Record<string, unknown>): string {
  return JSON.stringify(projectClaudeHostContext(metadata));
}
