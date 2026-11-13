#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioMcpClient } from "./mcp/stdio-client.js";
import { ClaudeCodeDriver } from "./hosts/claude.js";
import { LoopForgeSupervisor } from "./supervisor.js";
import type { InvocationHandle } from "./host/contracts.js";

const HELP = `LoopForge Adapter

Usage:
  loopforge-adapter start --task TEXT [options]
  loopforge-adapter resume --loop-id LOOP_ID [options]

Options:
  --workspace DIR                 Agent and LoopForge runtime workspace (default: cwd)
  --mcp-config FILE               Existing Claude MCP config to extend
  --claude-runtime MODE           restart (default) or reuse with native session hooks
  --loopforge-command COMMAND     LoopForge MCP command (default: loopforge)
  --loopforge-cli FILE            Use this LoopForge dist/cli.js entrypoint
  --loopforge-arg ARG             Prefix argument for --loopforge-command (repeatable)
  --input-json JSON               Exact JSON object passed to start/resume
  --input-file FILE               Read the exact start/resume object from a JSON file
  --task TEXT                     Convenience field for start
  --loop-id ID                    Durable LoopForge id for start/resume
  --max-rounds N                  Convenience field for start
  --plan-source FILE              Convenience field for start
  --constraint TEXT               Convenience field for start (repeatable)
  --criterion TEXT                Convenience field for start (repeatable)
  --invocation-lost               Convenience field for resume
  --current-user-instruction TEXT Convenience field for resume

The adapter uses Claude Code's ordinary interactive PTY path. Configure the
provider through the environment variables documented by the provider.
`;

export interface AdapterCliOptions {
  command: "start" | "resume";
  workspace: string;
  loopforgeCommand: string;
  loopforgeArgs: string[];
  loopforgeCliPath?: string;
  mcpConfigPath?: string;
  claudeRuntime: "restart" | "reuse";
  input: Record<string, unknown>;
}

function value(args: string[], index: number, flag: string): [string, number] {
  const next = args[index + 1];
  if (next === undefined || next.startsWith("-")) throw new Error(`${flag} requires a value`);
  return [next, index + 1];
}

function parseJsonObject(source: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function existingDirectory(directory: string): string {
  const resolved = path.resolve(directory);
  if (!existsSync(resolved)) throw new Error(`Workspace does not exist: ${resolved}`);
  if (!statSync(resolved).isDirectory()) throw new Error(`Workspace is not a directory: ${resolved}`);
  return resolved;
}

export function parseCli(argv: string[], platform: NodeJS.Platform = process.platform): AdapterCliOptions | "help" {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") return "help";
  if (command !== "start" && command !== "resume") throw new Error(`Unknown command: ${command}\n\n${HELP}`);

  let workspace = process.cwd();
  let loopforgeCommand = platform === "win32" ? "loopforge.cmd" : "loopforge";
  const loopforgeArgs: string[] = [];
  let loopforgeCliPath: string | undefined;
  let mcpConfigPath: string | undefined;
  let claudeRuntime: "restart" | "reuse" = "restart";
  let inputJson: string | undefined;
  let inputFile: string | undefined;
  let task: string | undefined;
  let loopId: string | undefined;
  let maxRounds: number | undefined;
  let planSource: string | undefined;
  const constraints: string[] = [];
  const criteria: string[] = [];
  let invocationLost = false;
  let currentUserInstruction: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--workspace") {
      [workspace, index] = value(args, index, flag);
    } else if (flag === "--mcp-config") {
      [mcpConfigPath, index] = value(args, index, flag);
    } else if (flag === "--claude-runtime") {
      const [mode, nextIndex] = value(args, index, flag);
      if (mode !== "restart" && mode !== "reuse") throw new Error("--claude-runtime must be restart or reuse");
      claudeRuntime = mode;
      index = nextIndex;
    } else if (flag === "--loopforge-command") {
      [loopforgeCommand, index] = value(args, index, flag);
    } else if (flag === "--loopforge-cli") {
      [loopforgeCliPath, index] = value(args, index, flag);
      loopforgeCliPath = path.resolve(loopforgeCliPath);
      loopforgeCommand = process.execPath;
      loopforgeArgs.push(loopforgeCliPath);
    } else if (flag === "--loopforge-arg") {
      const item = args[index + 1];
      if (item === undefined) throw new Error(`${flag} requires a value`);
      index += 1;
      loopforgeArgs.push(item);
    } else if (flag === "--input-json") {
      [inputJson, index] = value(args, index, flag);
    } else if (flag === "--input-file") {
      [inputFile, index] = value(args, index, flag);
    } else if (flag === "--task") {
      [task, index] = value(args, index, flag);
    } else if (flag === "--loop-id") {
      [loopId, index] = value(args, index, flag);
    } else if (flag === "--max-rounds") {
      const raw: string = value(args, index, flag)[0];
      index += 1;
      maxRounds = Number(raw);
      if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error("--max-rounds must be a positive integer");
    } else if (flag === "--plan-source") {
      [planSource, index] = value(args, index, flag);
    } else if (flag === "--constraint") {
      const item: string = value(args, index, flag)[0];
      index += 1;
      constraints.push(item);
    } else if (flag === "--criterion") {
      const item: string = value(args, index, flag)[0];
      index += 1;
      criteria.push(item);
    } else if (flag === "--invocation-lost") {
      invocationLost = true;
    } else if (flag === "--current-user-instruction") {
      [currentUserInstruction, index] = value(args, index, flag);
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  workspace = existingDirectory(workspace);
  if (mcpConfigPath !== undefined) mcpConfigPath = path.resolve(mcpConfigPath);
  if (inputJson !== undefined && inputFile !== undefined) throw new Error("Use only one of --input-json and --input-file");
  const convenienceUsed = task !== undefined || loopId !== undefined || maxRounds !== undefined ||
    planSource !== undefined || constraints.length > 0 || criteria.length > 0 || invocationLost ||
    currentUserInstruction !== undefined;
  if ((inputJson !== undefined || inputFile !== undefined) && convenienceUsed) {
    throw new Error("Do not combine --input-json/--input-file with convenience input flags");
  }

  let input: Record<string, unknown>;
  if (inputJson !== undefined) input = parseJsonObject(inputJson, "--input-json");
  else if (inputFile !== undefined) input = parseJsonObject(readFileSync(path.resolve(inputFile), "utf8"), "--input-file");
  else if (command === "start") {
    if (!task) throw new Error("start requires --task, --input-json, or --input-file");
    input = { task };
    if (loopId !== undefined) input.loopId = loopId;
    if (maxRounds !== undefined) input.maxRounds = maxRounds;
    if (planSource !== undefined) input.planSource = planSource;
    if (constraints.length > 0) input.constraints = constraints;
    if (criteria.length > 0) input.criteria = criteria;
  } else {
    if (!loopId) throw new Error("resume requires --loop-id, --input-json, or --input-file");
    input = { loopId };
    if (invocationLost) input.invocationLost = true;
    if (currentUserInstruction !== undefined) input.currentUserInstruction = currentUserInstruction;
  }

  return {
    command,
    workspace,
    loopforgeCommand,
    loopforgeArgs,
    claudeRuntime,
    ...(loopforgeCliPath === undefined ? {} : { loopforgeCliPath }),
    ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
    input,
  };
}

function localLoopForgeEntrypoint(workspace: string): string | undefined {
  let current = workspace;
  while (true) {
    const candidate = path.join(current, "node_modules", "loopforge", "dist", "cli.js");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const prefixes = [process.env.npm_config_prefix];
  if (process.env.APPDATA) prefixes.push(path.join(process.env.APPDATA, "npm"));
  for (const prefix of prefixes) {
    if (!prefix) continue;
    const candidate = path.join(prefix, "node_modules", "loopforge", "dist", "cli.js");
    if (existsSync(candidate)) return candidate;
  }

  const root = process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm root -g"], { encoding: "utf8", windowsHide: true })
    : spawnSync("npm", ["root", "-g"], { encoding: "utf8", windowsHide: true });
  if (root.status === 0) {
    const candidate = path.join(root.stdout.trim(), "loopforge", "dist", "cli.js");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function loopforgeClient(options: AdapterCliOptions): StdioMcpClient {
  let command = options.loopforgeCommand;
  let prefixArgs = options.loopforgeArgs;
  if (!options.loopforgeCliPath && command === "loopforge.cmd" && prefixArgs.length === 0) {
    const entrypoint = localLoopForgeEntrypoint(options.workspace);
    if (!entrypoint) {
      throw new Error("LoopForge was not found in this workspace or the global npm prefix; pass --loopforge-cli PATH");
    }
    command = process.execPath;
    prefixArgs = [entrypoint];
  }
  const args = [...prefixArgs, "mcp", "--workspace", options.workspace];
  if (options.loopforgeCliPath && !existsSync(options.loopforgeCliPath)) {
    throw new Error(`LoopForge CLI entrypoint does not exist: ${options.loopforgeCliPath}`);
  }
  return new StdioMcpClient({
    command,
    args,
    cwd: options.workspace,
  });
}

async function drive(
  supervisor: LoopForgeSupervisor,
  initial: InvocationHandle,
  onInterrupt: () => void,
): Promise<number | undefined> {
  let invocation: InvocationHandle | undefined = initial;
  let exitCode: number | undefined;
  const wasRaw = Boolean(process.stdin.isTTY && process.stdin.isRaw);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const forwardInput = (chunk: Buffer | string) => {
    const input = chunk.toString();
    if (input.includes("\u0003")) {
      onInterrupt();
      return;
    }
    try { supervisor.activeInvocation?.write(input); } catch { /* invocation is handing off */ }
  };
  process.stdin.on("data", forwardInput);
  process.stdin.resume();
  try {
    while (invocation) {
      for await (const event of invocation) {
        if (event.type === "output") process.stdout.write(event.data);
        if (event.type === "diagnostic") process.stderr.write(`[LoopForge Adapter] ${event.message}\n`);
        if (event.type === "exited") exitCode = event.exitCode;
      }
      invocation = await supervisor.nextInvocation(invocation.invocationId);
    }
  } finally {
    process.stdin.off("data", forwardInput);
    process.stdin.pause();
    if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
    // This adapter process owns the interactive stdin for one invocation.
    // Release the TTY after the host stream ends so a completed run can exit.
    process.stdin.destroy();
  }
  return exitCode;
}

function printResult(result: { content?: Array<{ text?: string }> }): void {
  for (const item of result.content ?? []) {
    if (typeof item.text === "string") process.stdout.write(`${item.text}\n`);
  }
}

export async function run(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseCli(argv);
  if (parsed === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  const loopforge = loopforgeClient(parsed);
  const supervisor = new LoopForgeSupervisor({
    host: new ClaudeCodeDriver({ reuseProcess: parsed.claudeRuntime === "reuse" }),
    loopforge,
    workspace: parsed.workspace,
    ...(parsed.mcpConfigPath === undefined ? {} : { mcpConfigPath: parsed.mcpConfigPath }),
    onTerminalResult: printResult,
  });
  let interrupt: Promise<unknown> | undefined;
  const onInterrupt = () => {
    const loopId = supervisor.activeLoopIdValue;
    interrupt ??= supervisor.pause().catch((error: unknown) => {
      process.stderr.write(`LoopForge pause failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }).then((result) => {
      if (!result) return;
      process.stdout.write(`LoopForge paused${loopId ? ` (${loopId})` : ""}.\n`);
      printResult(result);
    });
  };
  process.once("SIGINT", onInterrupt);
  try {
    const input = parsed.command === "start"
      ? parsed.input
      : { ...parsed.input, invocationLost: parsed.input.invocationLost ?? true };
    const invocation = parsed.command === "start"
      ? await supervisor.start(input)
      : await supervisor.resume(input);
    if (!invocation) return 0;
    if (supervisor.activeLoopIdValue) {
      process.stdout.write(`LoopForge loop: ${supervisor.activeLoopIdValue}\n`);
    }
    const exitCode = await drive(supervisor, invocation, onInterrupt);
    if (interrupt) await interrupt;
    else if (supervisor.activeInvocation) {
      const loopId = supervisor.activeLoopIdValue;
      const paused = await supervisor.pause();
      process.stdout.write(`Claude invocation exited; LoopForge paused${loopId ? ` (${loopId})` : ""}.\n`);
      if (paused) printResult(paused);
      return exitCode === undefined || exitCode === 0 ? 0 : 1;
    }
    return 0;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    await supervisor.stop("adapter_error").catch(() => undefined);
    await loopforge.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
