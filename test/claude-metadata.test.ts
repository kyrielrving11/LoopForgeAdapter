import assert from "node:assert/strict";
import { test } from "node:test";
import { projectClaudeHostContext, renderClaudeHostContext } from "../src/hosts/claude-metadata.js";

test("Claude host context is a deterministic allowlist projection", () => {
  const metadata = {
    contextMode: "fresh_invocation",
    contextReason: "next_round",
    sessionId: "session-private",
    loopId: "loop-private",
    submissionHandle: { transactionId: "transaction-private" },
    submission_guidance: { criteria: ["private"], commands: ["private"] },
    roundFacts: { files: ["private.ts"] },
  } as Record<string, unknown>;
  const expected = {
    authority: "current_prompt_and_live_mcp_schema",
    priorConversation: "not_available",
    workspace: "continues_across_invocations",
  };
  assert.deepEqual(projectClaudeHostContext(metadata), expected);
  const rendered = renderClaudeHostContext(metadata);
  assert.equal(rendered, JSON.stringify(expected));
  assert.ok(!rendered.includes("submission-private"));
  assert.ok(!rendered.includes("session-private"));
  assert.ok(!rendered.includes("private.ts"));
});

test("Claude host context rejects malformed transport metadata", () => {
  assert.throws(() => projectClaudeHostContext({ contextReason: "next_round" }), /context mode/);
  assert.throws(() => projectClaudeHostContext({ contextMode: "fresh_invocation", contextReason: "" }), /invalid/);
});

test("Claude host context is stable across changing round metadata", () => {
  const first = renderClaudeHostContext({ contextMode: "fresh_invocation", contextReason: "first_round" });
  const next = renderClaudeHostContext({ contextMode: "fresh_invocation", contextReason: "next_round", sessionId: "new" });
  assert.equal(first, next);
});
