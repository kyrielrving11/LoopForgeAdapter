import { callClaudeLifecycleHook, claudePromptHash, type ClaudeHookInput } from "./claude-lifecycle.js";
import { HOST_ADMISSION_FIELD } from "../host/contracts.js";

async function run(): Promise<void> {
  const address = process.env.LOOPFORGE_CLAUDE_HOOK_ENDPOINT;
  const token = process.env.LOOPFORGE_CLAUDE_HOOK_TOKEN;
  if (!address || !token) throw new Error("Claude lifecycle endpoint is not configured");
  let body = "";
  for await (const chunk of process.stdin) {
    body += String(chunk);
    if (body.length > 1024 * 1024) throw new Error("Claude hook input is too large");
  }
  const raw = JSON.parse(body) as ClaudeHookInput & { prompt?: unknown; tool_input?: Record<string, unknown>; tool_response?: Record<string, unknown> };
  // Deliberately do not forward transcript_path, tool inputs, tool outputs,
  // prompts, or any other content in Claude's hook envelope.
  const input: ClaudeHookInput = {
    hook_event_name: raw.hook_event_name,
    session_id: raw.session_id,
    cwd: raw.cwd,
    ...(raw.source === undefined ? {} : { source: raw.source }),
    ...(raw.reason === undefined ? {} : { reason: raw.reason }),
    ...(raw.tool_name === undefined ? {} : { tool_name: raw.tool_name }),
    ...(raw.tool_use_id === undefined ? {} : { tool_use_id: raw.tool_use_id }),
    ...(raw.agent_id === undefined ? {} : { agent_id: raw.agent_id }),
    ...(raw.hook_event_name === "UserPromptSubmit" && typeof raw.prompt === "string"
      ? { promptHash: claudePromptHash(raw.prompt) } : {}),
    background: (["Bash", "PowerShell", "Agent", "Task"].includes(raw.tool_name ?? "") &&
      (raw.tool_input?.run_in_background === true || raw.tool_input?.isolation === "remote")) ||
      raw.tool_response?.isAsync === true || raw.tool_response?.status === "async_launched" ||
      raw.tool_response?.status === "remote_launched" || typeof raw.tool_response?.backgroundTaskId === "string",
  };
  const output = await callClaudeLifecycleHook({ address, token }, input);
  const admission = output.adapterAdmission;
  delete output.adapterAdmission;
  if (typeof admission === "string") output.hookSpecificOutput = {
    hookEventName: "PreToolUse",
    updatedInput: { ...raw.tool_input, [HOST_ADMISSION_FIELD]: admission },
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

void run().catch(() => {
  // Exit 2 blocks PreToolUse and UserPromptSubmit on a lost Supervisor.
  process.stderr.write("LoopForge host lifecycle is unavailable; no action was authorized.\n");
  process.exitCode = 2;
});
