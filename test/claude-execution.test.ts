import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeExecutionBoundary } from "../src/hosts/claude-execution.js";
import type { ClaudeHookInput } from "../src/hosts/claude-lifecycle.js";

const event = (hook_event_name: string, tool_use_id: string, tool_name = "Read", extra: Partial<ClaudeHookInput> = {}): ClaudeHookInput => ({ hook_event_name, tool_use_id, tool_name, session_id: "native", cwd: "/workspace", ...extra });
const submit = "mcp__loopforge-adapter__loopforge_next";
const admission = (output: Record<string, unknown>) => output.adapterAdmission as string;

test("submission is blocked until all concurrent tools and subagents finish", () => {
  const boundary = new ClaudeExecutionBoundary("loopforge-adapter");
  boundary.preTool(event("PreToolUse", "slow", "mcp__external__slow"));
  boundary.observe(event("SubagentStart", "parent", "Agent", { agent_id: "child" }));
  const token = admission(boundary.preTool(event("PreToolUse", "submit", submit)));
  assert.throws(() => boundary.begin("loopforge_next", token), /must finish/);
  boundary.observe(event("PostToolUse", "slow"));
  assert.throws(() => boundary.begin("loopforge_next", token), /must finish/);
  boundary.observe(event("SubagentStop", "parent", "Agent", { agent_id: "child" }));
  const release = boundary.begin("loopforge_next", token);
  assert.match(JSON.stringify(boundary.preTool(event("PreToolUse", "late"))), /deny/);
  assert.equal(boundary.canReplace(), true);
  release();
});

test("a foreground Agent call remains in flight after its child's stop hook", () => {
  const boundary = new ClaudeExecutionBoundary("loopforge-adapter");
  boundary.preTool(event("PreToolUse", "agent", "Agent"));
  boundary.observe(event("SubagentStart", "agent", "Agent", { agent_id: "child" }));
  boundary.observe(event("SubagentStop", "agent", "Agent", { agent_id: "child" }));
  const token = admission(boundary.preTool(event("PreToolUse", "submit", submit)));
  assert.throws(() => boundary.begin("loopforge_next", token), /must finish/);
  boundary.observe(event("PostToolUse", "agent", "Agent"));
  boundary.begin("loopforge_next", token)();
});

test("execution admissions are one-use, tool-bound and absent in a new native session", () => {
  const boundary = new ClaudeExecutionBoundary("loopforge-adapter");
  const token = admission(boundary.preTool(event("PreToolUse", "submit", submit)));
  assert.throws(() => boundary.begin("loopforge_status", token), /no current/);
  boundary.begin("loopforge_next", token)();
  assert.throws(() => boundary.begin("loopforge_next", token), /no current/);
  assert.throws(() => new ClaudeExecutionBoundary("loopforge-adapter").begin("loopforge_next", token), /no current/);
});

test("background requests, monitors and subagent governance are denied before execution", () => {
  const boundary = new ClaudeExecutionBoundary("loopforge-adapter");
  for (const input of [event("PreToolUse", "bg", "Bash", { background: true }), event("PreToolUse", "monitor", "Monitor"), event("PreToolUse", "cron", "CronCreate"), event("PreToolUse", "nested", submit, { agent_id: "child" })]) {
    assert.match(JSON.stringify(boundary.preTool(input)), /deny/);
  }
  assert.equal(boundary.canReplace(), true);
  const token = admission(boundary.preTool(event("PreToolUse", "main", submit)));
  boundary.begin("loopforge_next", token)();
});

test("failed and permission-denied tools release execution ownership; async outcomes fail closed", () => {
  for (const hook of ["PostToolUseFailure", "PermissionDenied"]) {
    const boundary = new ClaudeExecutionBoundary("loopforge-adapter");
    boundary.preTool(event("PreToolUse", "work"));
    boundary.observe(event(hook, "work"));
    assert.equal(boundary.canReplace(), true);
  }
  const boundary = new ClaudeExecutionBoundary("loopforge-adapter");
  boundary.preTool(event("PreToolUse", "work", "Agent"));
  boundary.observe(event("PostToolUse", "work", "Agent", { background: true }));
  const token = admission(boundary.preTool(event("PreToolUse", "submit", submit)));
  assert.equal(boundary.canReplace(), false);
  assert.throws(() => boundary.begin("loopforge_next", token), /uncontained/);
});
