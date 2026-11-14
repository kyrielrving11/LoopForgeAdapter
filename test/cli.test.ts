import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseCli } from "../src/cli.js";

function workspace(run: (directory: string) => void): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), "loopforge-adapter-cli-"));
  mkdirSync(path.join(directory, "project"));
  try { run(path.join(directory, "project")); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test("CLI builds start input without reinterpreting LoopForge fields", () => workspace((directory) => {
  const parsed = parseCli([
    "start",
    "--workspace", directory,
    "--task", "ship the change",
    "--max-rounds", "4",
    "--constraint", "keep the public API",
    "--criterion", "the check passes",
  ], "linux");
  assert.notEqual(parsed, "help");
  if (parsed === "help") return;
  assert.equal(parsed.command, "start");
  assert.deepEqual(parsed.input, {
    task: "ship the change",
    maxRounds: 4,
    constraints: ["keep the public API"],
    criteria: ["the check passes"],
  });
  assert.deepEqual(parsed.loopforgeArgs, []);
  assert.equal(parsed.loopforgeCommand, "loopforge");
}));

test("CLI preserves exact resume JSON and custom LoopForge entrypoint", () => workspace((directory) => {
  const parsed = parseCli([
    "resume",
    "--workspace", directory,
    "--loopforge-cli", path.join(directory, "loopforge-cli.js"),
    "--input-json", '{"loopId":"loop-1","invocationLost":false}',
  ], "win32");
  assert.notEqual(parsed, "help");
  if (parsed === "help") return;
  assert.equal(parsed.command, "resume");
  assert.deepEqual(parsed.input, { loopId: "loop-1", invocationLost: false });
  assert.equal(parsed.loopforgeCommand, process.execPath);
  assert.deepEqual(parsed.loopforgeArgs, [path.join(directory, "loopforge-cli.js")]);
}));

test("CLI rejects ambiguous exact and convenience input", () => workspace((directory) => {
  assert.throws(() => parseCli([
    "start", "--workspace", directory, "--input-json", '{"task":"x"}', "--task", "y",
  ], "linux"), /Do not combine/);
}));

test("CLI keeps host reuse selection outside LoopForge invocation input", () => workspace((directory) => {
  const parsed = parseCli(["start", "--workspace", directory, "--task", "x", "--claude-runtime", "reuse"]);
  assert.notEqual(parsed, "help");
  if (parsed === "help") return;
  assert.equal(parsed.claudeRuntime, "reuse");
  assert.deepEqual(parsed.input, { task: "x" });
  assert.throws(() => parseCli(["start", "--task", "x", "--claude-runtime", "unknown"]), /must be restart or reuse/);
}));

test("CLI keeps ordered capability files outside exact and convenience LoopForge inputs", () => workspace((directory) => {
  for (const input of [["--task", "x"], ["--input-json", '{"task":"x"}']]) {
    const parsed = parseCli(["start", "--workspace", directory, ...input,
      "--capability-file", "reference.md", "--capability-file", path.join(directory, "SKILL.md")]);
    assert.notEqual(parsed, "help");
    if (parsed === "help") return;
    assert.deepEqual(parsed.capabilityFiles, [path.resolve("reference.md"), path.join(directory, "SKILL.md")]);
    assert.deepEqual(parsed.input, { task: "x" });
  }
  assert.throws(() => parseCli(["start", "--task", "x", "--capability-file"]), /requires a value/);
}));
