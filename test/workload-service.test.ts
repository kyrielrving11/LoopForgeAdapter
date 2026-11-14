import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { StdioMcpClient } from "../src/mcp/stdio-client.js";
import type { WorkloadServiceEvent } from "../experiments/workload-service.js";

test("invalid workload arguments return a recoverable error without killing MCP or fabricating a check", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "loopforge-service-test-"));
  const source = path.join(root, "tags.ts");
  const acceptance = path.join(root, "acceptance.cjs");
  const log = path.join(root, "service.jsonl");
  writeFileSync(source, "export {};\n");
  writeFileSync(acceptance, "console.log('ACCEPTANCE_PASSED');\n");
  const client = new StdioMcpClient({ command: process.execPath,
    args: [fileURLToPath(new URL("../experiments/workload-service.js", import.meta.url))], cwd: root,
    env: { ...process.env, WORKLOAD_SOURCE: source, WORKLOAD_LOG: log, WORKLOAD_ACCEPTANCE: acceptance,
      WORKLOAD_WORKSPACE: root, WORKLOAD_MARKERS: '["zero","one","two"]', WORKLOAD_LEGACY_CRASH: "0", WORKLOAD_INJECT_CHECK_ERROR: "0" },
  });
  try {
    for (const round of [9, -1, "0", null]) {
      const result = await client.callTool("check", { round });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /no check was run/);
    }
    const observations = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as WorkloadServiceEvent);
    assert.equal(observations().filter((event) => event.kind === "check").length, 0);
    assert.equal((await client.listTools()).length, 2);
    const checked = await client.callTool("check", { round: 0 });
    assert.match(JSON.stringify(checked), /ACCEPTANCE_PASSED/);
    assert.equal(observations().filter((event) => event.kind === "start").length, 1);
    assert.equal(observations().filter((event) => event.kind === "check").length, 1);
    assert.ok(observations().find((event) => event.kind === "check")?.sourceHash);
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
});
