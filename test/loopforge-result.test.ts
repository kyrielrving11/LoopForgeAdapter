import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyLoopForgeNextResult, isSupervisorOwnedTool } from "../src/mcp/loopforge-result.js";

function result(metadata: Record<string, unknown>) {
  return {
    content: [
      { type: "text", text: "A LoopForge prompt" },
      { type: "text", text: JSON.stringify(metadata) },
    ],
  };
}

test("classifies prompt metadata without scanning prompt prose", () => {
  const classified = classifyLoopForgeNextResult(result({
    contextMode: "same_round_retry",
    contextReason: "same_check_rejection",
    submissionHandle: "h-1",
  }));
  assert.equal(classified.kind, "prompt");
  if (classified.kind === "prompt") {
    assert.equal(classified.metadata.contextMode, "same_round_retry");
    assert.equal(classified.prompt, "A LoopForge prompt");
  }
});

test("preserves fresh invocation as a structured boundary", () => {
  const classified = classifyLoopForgeNextResult(result({
    contextMode: "fresh_invocation",
    contextReason: "round_boundary",
    submissionHandle: "h-2",
  }));
  assert.equal(classified.kind, "prompt");
  if (classified.kind === "prompt") assert.equal(classified.metadata.contextMode, "fresh_invocation");
});

test("preserves LoopForge submission handles as opaque structured metadata", () => {
  const submissionHandle = { sessionId: "session-1", roundId: "round-1", transactionId: "tx-1" };
  const classified = classifyLoopForgeNextResult(result({
    contextMode: "fresh_invocation",
    contextReason: "first_round",
    submissionHandle,
  }));
  assert.equal(classified.kind, "prompt");
  if (classified.kind === "prompt") assert.deepEqual(classified.metadata.submissionHandle, submissionHandle);
});

test("rejects prompt results without legal metadata", () => {
  const classified = classifyLoopForgeNextResult({ content: [{ type: "text", text: "prompt" }] });
  assert.equal(classified.kind, "invalid");
});

test("keeps errors and terminal results distinct", () => {
  assert.equal(classifyLoopForgeNextResult({ isError: true, content: [{ type: "text", text: "error" }] }).kind, "error");
  assert.equal(classifyLoopForgeNextResult({ content: [{ type: "text", text: JSON.stringify({ ok: true, stopReason: "completed" }) }] }).kind, "terminal");
});

test("only supervisor-owned lifecycle tools are filtered", () => {
  assert.equal(isSupervisorOwnedTool("loopforge_start"), true);
  assert.equal(isSupervisorOwnedTool("loopforge_resume"), true);
  assert.equal(isSupervisorOwnedTool("loopforge_next"), false);
  assert.equal(isSupervisorOwnedTool("loopforge_status"), false);
});
