import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  HostCapabilities,
  HostDriver,
  HostEvent,
  InvocationHandle,
  InvocationInput,
  InvocationStopReason,
} from "../../src/host/contracts.js";
import { LoopForgeMcpBridge, type LoopForgeMcpClient, type McpToolDefinition } from "../../src/mcp/bridge.js";
import { classifyLoopForgeNextResult, type McpToolResult } from "../../src/mcp/loopforge-result.js";
import { LoopForgeSupervisor } from "../../src/supervisor.js";
import { StdioMcpClient } from "../../src/mcp/stdio-client.js";

const execFileAsync = promisify(execFile);
const loopforgeCli = process.env.LOOPFORGE_CLI ?? path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "LoopForge",
  "loopforge",
  "dist",
  "cli.js",
);
const lifecycleE2eSkip = existsSync(loopforgeCli)
  ? false
  : `LoopForge CLI not found at ${loopforgeCli}; set LOOPFORGE_CLI to run lifecycle E2E tests`;

interface InspectedLoop {
  rounds: number[];
  session: {
    entry: {
      loop_lineage: {
        current_round: number;
        status: string;
        round_snapshot: {
          phase: string;
          attempt: number;
        };
      };
    };
  };
}

const capabilities: HostCapabilities = {
  cleanConversation: true,
  interactiveTransport: true,
  roundMetadataDelivery: true,
  promptDeliveryConfirmation: true,
  hardStop: true,
  workspaceContinuity: true,
  toolResultInterception: true,
  warmHostRuntime: false,
  warmExternalMcp: false,
  providerCacheTelemetry: false,
};

class ScriptedInvocation implements InvocationHandle {
  readonly invocationId = randomUUID();
  readonly sessionId = randomUUID();
  readonly pid = 0;

  write(): void {}

  async *[Symbol.asyncIterator](): AsyncIterator<HostEvent> {
    // The test drives lifecycle tools directly through the supervisor.
  }
}

class ScriptedHost implements HostDriver {
  readonly id = "scripted-e2e-host";
  readonly starts: InvocationInput[] = [];
  readonly stops: Array<{ reason: InvocationStopReason }> = [];

  async probe(): Promise<HostCapabilities> {
    return capabilities;
  }

  async startInvocation(input: InvocationInput): Promise<InvocationHandle> {
    this.starts.push(input);
    return new ScriptedInvocation();
  }

  async stopInvocation(_invocation: InvocationHandle, reason: InvocationStopReason): Promise<void> {
    this.stops.push({ reason });
  }
}

class DropCommittedResponseClient implements LoopForgeMcpClient {
  constructor(private readonly inner: LoopForgeMcpClient) {}

  listTools(): Promise<McpToolDefinition[]> {
    return this.inner.listTools();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.inner.callTool(name, args);
    if (name === "loopforge_next") {
      throw new Error("Simulated adapter loss after LoopForge committed the round");
    }
    return result;
  }
}

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "loopforge-adapter-lifecycle-e2e-"));
  const project = path.join(root, "project");
  mkdirSync(project);
  return project;
}

function client(project: string): StdioMcpClient {
  return new StdioMcpClient({
    command: process.execPath,
    args: [loopforgeCli, "mcp", "--workspace", project],
    cwd: project,
  });
}

async function inspect(project: string, loopId: string): Promise<InspectedLoop> {
  const result = await execFileAsync(process.execPath, [loopforgeCli, "inspect", loopId, "--json"], {
    cwd: project,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(result.stdout) as InspectedLoop;
}

function submissionHandle(host: ScriptedHost): Record<string, unknown> {
  const value = host.starts[0]?.metadata.submissionHandle;
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test("real LoopForge MCP keeps workspace continuity across a fresh round", { skip: lifecycleE2eSkip }, async () => {
  const project = workspace();
  const loopId = randomUUID();
  const loopforge = client(project);
  const host = new ScriptedHost();
  const supervisor = new LoopForgeSupervisor({ host, loopforge, workspace: project });
  try {
    await supervisor.start({
      loopId,
      task: "Create one marker, then continue to a second round.",
      maxRounds: 2,
    });
    writeFileSync(path.join(project, "round-one.txt"), "ROUND_ONE_DONE", "utf8");

    const decision = await supervisor.handleAgentToolCall("loopforge_next", {
      submissionHandle: submissionHandle(host),
      evaluation: {
        outcome: "partial",
        output_summary: "Created and checked the Round 1 marker.",
        constraint_violations: [],
        should_continue: true,
        execution_report: { files_changed: ["round-one.txt"] },
      },
    });

    assert.equal(decision.kind, "handoff");
    assert.equal(host.starts.length, 2);
    assert.equal(host.starts[1]?.metadata.contextMode, "fresh_invocation");
    assert.equal(host.starts[1]?.metadata.contextReason, "next_round");
    assert.match(host.starts[1]?.prompt ?? "", /Round 2/);

    const state = await inspect(project, loopId);
    assert.deepEqual(state.rounds, [1]);
    assert.equal(state.session.entry.loop_lineage.current_round, 2);
    assert.equal(state.session.entry.loop_lineage.round_snapshot.phase, "prompted");
    assert.equal(state.session.entry.loop_lineage.status, "running");
    assert.equal(
      readFileSync(path.join(project, "round-one.txt"), "utf8"),
      "ROUND_ONE_DONE",
    );
  } finally {
    await supervisor.pause().catch(() => undefined);
    await supervisor.stop("adapter_error").catch(() => undefined);
    await loopforge.close().catch(() => undefined);
    rmSync(path.dirname(project), { recursive: true, force: true });
  }
});

test("real LoopForge pause and resume redeliver the same held round", { skip: lifecycleE2eSkip }, async () => {
  const project = workspace();
  const loopId = randomUUID();
  const firstClient = client(project);
  const firstHost = new ScriptedHost();
  const firstSupervisor = new LoopForgeSupervisor({ host: firstHost, loopforge: firstClient, workspace: project });
  try {
    await firstSupervisor.start({ loopId, task: "Pause before doing any work.", maxRounds: 2 });
    const firstPrompt = firstHost.starts[0]?.prompt;
    const paused = await firstSupervisor.pause();
    assert.ok(paused);
    await firstClient.close();

    const resumedClient = client(project);
    const resumedHost = new ScriptedHost();
    const resumedSupervisor = new LoopForgeSupervisor({
      host: resumedHost,
      loopforge: resumedClient,
      workspace: project,
    });
    try {
      await resumedSupervisor.resume({ loopId, invocationLost: true });
      assert.equal(resumedHost.starts.length, 1);
      assert.equal(resumedHost.starts[0]?.prompt, firstPrompt);
      assert.equal(resumedHost.starts[0]?.metadata.contextMode, "fresh_invocation");
      assert.equal(resumedHost.starts[0]?.metadata.contextReason, "first_round");

      const state = await inspect(project, loopId);
      assert.deepEqual(state.rounds, []);
      assert.equal(state.session.entry.loop_lineage.current_round, 1);
      assert.equal(state.session.entry.loop_lineage.status, "running");
      assert.equal(state.session.entry.loop_lineage.round_snapshot.attempt, 1);
    } finally {
      await resumedSupervisor.pause().catch(() => undefined);
      await resumedSupervisor.stop("adapter_error").catch(() => undefined);
      await resumedClient.close().catch(() => undefined);
    }
  } finally {
    await firstSupervisor.stop("adapter_error").catch(() => undefined);
    await firstClient.close().catch(() => undefined);
    rmSync(path.dirname(project), { recursive: true, force: true });
  }
});

test("resume reconciles a committed round when its MCP response is lost", { skip: lifecycleE2eSkip }, async () => {
  const project = workspace();
  const loopId = randomUUID();
  const initialClient = client(project);
  let resumedClient: StdioMcpClient | undefined;
  let supervisor: LoopForgeSupervisor | undefined;
  try {
    const started = await initialClient.callTool("loopforge_start", {
      loopId,
      task: "Commit Round 1 and continue to Round 2.",
      maxRounds: 2,
    });
    const startedPrompt = classifyLoopForgeNextResult(started);
    assert.equal(startedPrompt.kind, "prompt");
    if (startedPrompt.kind !== "prompt") return;

    const bridge = new LoopForgeMcpBridge(new DropCommittedResponseClient(initialClient));
    await assert.rejects(() => bridge.callAgentTool("loopforge_next", {
      submissionHandle: startedPrompt.metadata.submissionHandle,
      evaluation: {
        outcome: "partial",
        output_summary: "Round 1 was committed; the MCP response was intentionally lost.",
        constraint_violations: [],
        should_continue: true,
      },
    }), /Simulated adapter loss/);

    const committed = await inspect(project, loopId);
    assert.deepEqual(committed.rounds, [1]);
    assert.equal(committed.session.entry.loop_lineage.current_round, 2);
    assert.equal(committed.session.entry.loop_lineage.round_snapshot.phase, "prompted");

    await initialClient.close();
    resumedClient = client(project);
    const host = new ScriptedHost();
    supervisor = new LoopForgeSupervisor({ host, loopforge: resumedClient, workspace: project });
    await supervisor.resume({ loopId, invocationLost: true });

    assert.equal(host.starts.length, 1);
    assert.equal(host.starts[0]?.metadata.contextMode, "fresh_invocation");
    assert.equal(host.starts[0]?.metadata.contextReason, "next_round");
    assert.match(host.starts[0]?.prompt ?? "", /Round 2/);

    const recovered = await inspect(project, loopId);
    assert.deepEqual(recovered.rounds, [1]);
    assert.equal(recovered.session.entry.loop_lineage.current_round, 2);
    assert.equal(recovered.session.entry.loop_lineage.status, "running");
  } finally {
    await supervisor?.pause().catch(() => undefined);
    await supervisor?.stop("adapter_error").catch(() => undefined);
    await resumedClient?.close().catch(() => undefined);
    await initialClient.close().catch(() => undefined);
    rmSync(path.dirname(project), { recursive: true, force: true });
  }
});

test("resume surfaces a committed terminal result without starting another Agent", { skip: lifecycleE2eSkip }, async () => {
  const project = workspace();
  const loopId = randomUUID();
  const initialClient = client(project);
  let resumedClient: StdioMcpClient | undefined;
  let supervisor: LoopForgeSupervisor | undefined;
  try {
    const started = await initialClient.callTool("loopforge_start", {
      loopId,
      task: "Complete this final-round recovery check.",
      maxRounds: 1,
    });
    const startedPrompt = classifyLoopForgeNextResult(started);
    assert.equal(startedPrompt.kind, "prompt");
    if (startedPrompt.kind !== "prompt") return;

    const bridge = new LoopForgeMcpBridge(new DropCommittedResponseClient(initialClient));
    await assert.rejects(() => bridge.callAgentTool("loopforge_next", {
      submissionHandle: startedPrompt.metadata.submissionHandle,
      evaluation: {
        outcome: "success",
        output_summary: "The final-round recovery check is complete.",
        constraint_violations: [],
        should_continue: false,
      },
    }), /Simulated adapter loss/);

    const committed = await inspect(project, loopId);
    assert.deepEqual(committed.rounds, [1]);
    assert.equal(committed.session.entry.loop_lineage.status, "stopped");

    await initialClient.close();
    resumedClient = client(project);
    const host = new ScriptedHost();
    const terminalResults: McpToolResult[] = [];
    supervisor = new LoopForgeSupervisor({
      host,
      loopforge: resumedClient,
      workspace: project,
      onTerminalResult: (result) => terminalResults.push(result),
    });
    const invocation = await supervisor.resume({ loopId, invocationLost: true });

    assert.equal(invocation, undefined);
    assert.equal(host.starts.length, 0);
    assert.equal(terminalResults.length, 1);
    assert.equal(supervisor.activeInvocationId, undefined);

    const recovered = await inspect(project, loopId);
    assert.deepEqual(recovered.rounds, [1]);
    assert.equal(recovered.session.entry.loop_lineage.status, "stopped");
  } finally {
    await supervisor?.stop("adapter_error").catch(() => undefined);
    await resumedClient?.close().catch(() => undefined);
    await initialClient.close().catch(() => undefined);
    rmSync(path.dirname(project), { recursive: true, force: true });
  }
});
