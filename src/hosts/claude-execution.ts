import { randomUUID } from "node:crypto";
import type { ClaudeHookInput } from "./claude-lifecycle.js";

interface Execution { name: string; admission?: string }

/** Volatile execution ownership only: no arguments, results, claims or history. */
export class ClaudeExecutionBoundary {
  private readonly tools = new Map<string, Execution>();
  private readonly agents = new Set<string>();
  private readonly admissions = new Map<string, string>();
  private submitting = false;
  private uncontained = false;
  constructor(private readonly bridgeName: string) {}

  preTool(event: ClaudeHookInput): Record<string, unknown> {
    const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
    if (this.submitting) return deny("LoopForge submission is in progress; no new work may start");
    if (!event.tool_use_id || !event.tool_name) return deny("Missing Claude execution identity");
    const governance = event.tool_name.startsWith(`mcp__${this.bridgeName}__`);
    if (event.background || ["Monitor", "CronCreate"].includes(event.tool_name)) return deny("Background execution cannot cross a LoopForge boundary; use foreground work");
    if (governance && event.agent_id) return deny("Only the main Agent may call LoopForge tools");
    if (this.tools.has(event.tool_use_id)) {
      // A later denial/completion cannot safely be attributed to either use.
      this.uncontained = true;
      return deny("Duplicate Claude execution identity");
    }
    const admission = governance ? randomUUID() : undefined;
    this.tools.set(event.tool_use_id, { name: event.tool_name, ...(admission ? { admission } : {}) });
    if (admission) this.admissions.set(admission, event.tool_use_id);
    // Only the relay sees raw input and adds this transport field locally.
    return admission ? { adapterAdmission: admission } : {};
  }

  observe(event: ClaudeHookInput): void {
    if (event.hook_event_name === "SubagentStart") {
      if (event.agent_id) this.agents.add(event.agent_id);
      else this.uncontained = true;
    } else if (event.hook_event_name === "SubagentStop") {
      if (event.agent_id) this.agents.delete(event.agent_id);
    } else if (["PostToolUse", "PostToolUseFailure", "PermissionDenied"].includes(event.hook_event_name)) {
      if (event.background) this.uncontained = true;
      const execution = event.tool_use_id ? this.tools.get(event.tool_use_id) : undefined;
      if (execution?.admission) this.admissions.delete(execution.admission);
      if (event.tool_use_id) this.tools.delete(event.tool_use_id);
    }
  }

  begin(name: string, admission: string | undefined): () => void {
    const id = admission ? this.admissions.get(admission) : undefined;
    const execution = id ? this.tools.get(id) : undefined;
    if (!id || !execution || execution.name !== `mcp__${this.bridgeName}__${name}` || this.submitting) {
      throw new Error("LoopForge tool call has no current main-Agent execution admission");
    }
    if (name === "loopforge_next" && (this.uncontained || this.agents.size || this.tools.size !== 1)) {
      throw new Error("LoopForge submission blocked: foreground tools/subagents must finish and no uncontained background work may remain");
    }
    this.admissions.delete(admission!);
    if (name === "loopforge_next") this.submitting = true;
    return () => { this.submitting = false; };
  }

  canReplace(): boolean {
    return !this.uncontained && !this.agents.size && this.tools.size <= 1 && [...this.tools.values()].every((tool) => tool.name === `mcp__${this.bridgeName}__loopforge_next`);
  }
}
