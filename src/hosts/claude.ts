import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ClaudeRuntime } from "./claude-runtime.js";
import { captureFixedCapabilities } from "./fixed-capabilities.js";
import type {
  HostCapabilities,
  HostDriver,
  InvocationBridgeConfig,
  InvocationHandle,
  InvocationInput,
  InvocationStopReason,
} from "../host/contracts.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  kill(): void;
  dispose?(): void;
  destroy?(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

interface PtyOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  useConpty?: boolean;
}

export type PtyFactory = (file: string, args: string[], options: PtyOptions) => PtyProcess;
export type StopProcessTree = (pid: number) => Promise<void>;

interface ClaudeDriverOptions {
  executable?: string;
  platform?: NodeJS.Platform;
  ptyFactory?: PtyFactory;
  stopProcessTree?: StopProcessTree;
  bridgeServerPath?: string;
  bridgeServerName?: string;
  readCliHelp?: (executable: string) => Promise<string>;
  readCliVersion?: (executable: string) => Promise<string>;
  /** Use native session hooks to confirm /clear before reusing a process. */
  reuseProcess?: boolean;
  /** Explicit static skill/tool documentation to supply to every fresh model conversation. */
  capabilityFiles?: readonly string[];
  lifecycleTimeoutMs?: number;
}

function defaultPtyFactory(file: string, args: string[], options: PtyOptions): PtyProcess {
  const nodePty = require("node-pty") as { spawn: PtyFactory };
  return nodePty.spawn(file, args, options);
}

function defaultExecutable(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      const installed = path.join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
      if (existsSync(installed)) return installed;
    }
    return "claude.exe";
  }
  return "claude";
}

async function stopTree(pid: number, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface PreparedMcpConfig {
  path?: string;
  cleanup(): void;
}

function prepareMcpConfig(
  basePath: string | undefined,
  bridge: InvocationBridgeConfig | undefined,
  bridgeServerName: string,
): PreparedMcpConfig {
  if (!bridge) return {
    ...(basePath === undefined ? {} : { path: path.resolve(basePath) }),
    cleanup() {},
  };
  let config: Record<string, unknown> = { mcpServers: {} };
  if (basePath !== undefined) {
    const parsed: unknown = JSON.parse(readFileSync(basePath, "utf8"));
    if (!isRecord(parsed)) throw new Error("MCP configuration must be a JSON object");
    config = parsed;
  }
  const servers = config.mcpServers;
  if (servers !== undefined && !isRecord(servers)) {
    throw new Error("MCP configuration mcpServers must be an object");
  }
  const mergedServers = { ...(isRecord(servers) ? servers : {}), [bridgeServerName]: {
    command: bridge.command,
    args: bridge.args,
    env: bridge.env,
  } };
  config = { ...config, mcpServers: mergedServers };
  const directory = mkdtempSync(path.join(os.tmpdir(), "loopforge-adapter-mcp-"));
  const generatedPath = path.join(directory, "config.json");
  writeFileSync(generatedPath, JSON.stringify(config));
  return {
    path: generatedPath,
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

export class ClaudeCodeDriver implements HostDriver {
  readonly id = "claude-code";
  private readonly platform: NodeJS.Platform;
  private readonly executable: string;
  private readonly ptyFactory: PtyFactory;
  private readonly stopTree: StopProcessTree;
  private readonly bridgeServerPath: string;
  private readonly bridgeServerName: string;
  private readonly readCliHelp: (executable: string) => Promise<string>;
  private readonly readCliVersion: (executable: string) => Promise<string>;
  private readonly reuseProcess: boolean;
  private readonly capabilityFiles: readonly string[];
  private readonly lifecycleTimeoutMs: number;
  private runtime: ClaudeRuntime | undefined;

  constructor(options: ClaudeDriverOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.executable = options.executable ?? defaultExecutable(this.platform);
    this.ptyFactory = options.ptyFactory ?? defaultPtyFactory;
    this.stopTree = options.stopProcessTree ?? ((pid) => stopTree(pid, this.platform));
    this.bridgeServerPath = options.bridgeServerPath ?? path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../mcp/bridge-server.js",
    );
    this.bridgeServerName = options.bridgeServerName ?? "loopforge-adapter";
    this.reuseProcess = options.reuseProcess ?? false;
    this.capabilityFiles = (options.capabilityFiles ?? []).map((file) => path.resolve(file));
    this.lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? 15000;
    this.readCliHelp = options.readCliHelp ?? (async (executable) => {
      const result = await execFileAsync(executable, ["--help"], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      return `${result.stdout}\n${result.stderr}`;
    });
    this.readCliVersion = options.readCliVersion ?? (async (executable) => (await execFileAsync(executable, ["--version"], {
      timeout: 5000, maxBuffer: 16384, windowsHide: true,
    })).stdout);
  }

  async probe(): Promise<HostCapabilities> {
    captureFixedCapabilities(this.capabilityFiles);
    const installed = this.executable.includes(path.sep) ? existsSync(this.executable) : true;
    let ptyAvailable = false;
    try {
      const nodePty = require("node-pty") as { spawn?: unknown };
      ptyAvailable = typeof nodePty.spawn === "function";
    } catch {
      ptyAvailable = false;
    }
    const bridgeAvailable = existsSync(this.bridgeServerPath);
    let help = "";
    let version = "";
    if (installed && ptyAvailable) {
      try { help = await this.readCliHelp(this.executable); } catch { help = ""; }
      try { version = await this.readCliVersion(this.executable); } catch { version = ""; }
    }
    const supports = (option: string) => help.includes(option);
    if (this.capabilityFiles.length && !supports("--append-system-prompt-file") && !supports("--append-system-prompt[-file]")) {
      throw new Error("Fixed capability background requires Claude --append-system-prompt-file support");
    }
    // Environment switches are silently ignored by older hosts. Do not claim
    // isolation from flag support alone; 2.1.323 is the verified baseline.
    const parsedVersion = version.match(/^(\d+)\.(\d+)\.(\d+)/);
    const [major = 0, minor = 0, patch = 0] = parsedVersion?.slice(1).map(Number) ?? [];
    const supportedVersion = major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 323)));
    const lifecycleAvailable = supportedVersion && supports("--plugin-dir") && supports("--setting-sources") && supports("--strict-mcp-config") && supports("--disallowedTools") && supports("--settings") && existsSync(path.resolve(
      path.dirname(fileURLToPath(import.meta.url)), "claude-hook.js",
    ));
    return {
      cleanConversation: installed && ptyAvailable && supports("--session-id") && lifecycleAvailable,
      interactiveTransport: installed && ptyAvailable,
      roundMetadataDelivery: installed && ptyAvailable && lifecycleAvailable,
      promptDeliveryConfirmation: installed && ptyAvailable && supports("--session-id") && lifecycleAvailable,
      hardStop: installed && ptyAvailable,
      workspaceContinuity: true,
      toolResultInterception: installed && ptyAvailable && bridgeAvailable &&
        supports("--session-id") && lifecycleAvailable && supports("--mcp-config"),
      warmHostRuntime: installed && ptyAvailable && this.reuseProcess && lifecycleAvailable,
      warmExternalMcp: installed && ptyAvailable && this.reuseProcess && lifecycleAvailable && supports("--mcp-config"),
      providerCacheTelemetry: false,
    };
  }

  async startInvocation(input: InvocationInput): Promise<InvocationHandle> {
    if (!input.prompt.trim()) throw new Error("Invocation prompt must not be empty");
    const workspace = path.resolve(input.workspace);
    if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
      throw new Error(`Workspace is not a directory: ${workspace}`);
    }
    if (input.mcpConfigPath && !existsSync(input.mcpConfigPath)) {
      throw new Error(`MCP configuration does not exist: ${input.mcpConfigPath}`);
    }
    if (input.bridge && !existsSync(this.bridgeServerPath)) {
      throw new Error(`LoopForge MCP bridge does not exist: ${this.bridgeServerPath}`);
    }

    if (this.runtime) throw new Error("A Claude runtime is already active");
    const bridgeServerName = input.bridge?.serverName ?? this.bridgeServerName;
    const preparedMcp = prepareMcpConfig(input.mcpConfigPath, input.bridge, bridgeServerName);
    const runtime = new ClaudeRuntime({
      executable: this.executable, platform: this.platform, ptyFactory: this.ptyFactory,
      stopProcessTree: this.stopTree, timeoutMs: this.lifecycleTimeoutMs,
      mcpConfigPath: preparedMcp.path, bridgeServerName,
      capabilityFiles: this.capabilityFiles,
      cleanup: preparedMcp.cleanup,
    });
    this.runtime = runtime;
    try { return await runtime.start(input); }
    catch (error) { this.runtime = undefined; throw error; }
  }

  beginToolCall(handle: InvocationHandle, name: string, admission?: string): () => void {
    if (!this.runtime?.isCurrent(handle)) throw new Error("Claude invocation handle is inactive");
    return this.runtime.beginToolCall(name, admission);
  }

  async stopInvocation(handle: InvocationHandle, reason: InvocationStopReason): Promise<void> {
    const runtime = this.runtime;
    if (!runtime?.isCurrent(handle)) throw new Error("Claude invocation handle is inactive");
    await runtime.stop(reason);
    this.runtime = undefined;
  }

  async replaceInvocation(handle: InvocationHandle, input: InvocationInput): Promise<InvocationHandle> {
    const runtime = this.runtime;
    if (!runtime?.owns(handle)) throw new Error("Claude invocation handle is inactive");
    runtime.assertReplacement(handle, input);
    if (this.reuseProcess && runtime.hasCurrentCapabilities()) {
      try { return await runtime.replace(handle, input); }
      catch {
        // Failed session/prompt confirmation never authorizes more work in
        // this process. Confirm its exit before redelivering from cold.
        runtime.report("Claude session or prompt delivery was not confirmed; restarting the host and its MCP connections.");
        await runtime.stop("adapter_error");
        this.runtime = undefined;
        return this.startInvocation(input);
      }
    }
    if (this.reuseProcess) runtime.report("Fixed capability sources changed or became unreadable; restarting the host before delivering the next input.");
    await this.stopInvocation(handle, "fresh_invocation");
    return this.startInvocation(input);
  }
}
