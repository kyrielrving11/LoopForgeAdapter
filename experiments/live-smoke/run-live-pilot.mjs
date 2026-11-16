import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startAnthropicProbe } from '../../dist/experiments/anthropic-probe.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adapterCli = path.join(root, 'dist/src/cli.js');
const maxRequests = 24;
const runTimeoutMs = 180_000;

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) throw new Error('Every option requires a value');
    result[flag.slice(2)] = value;
    index += 1;
  }
  for (const key of ['workspace', 'mcp-config', 'loopforge-cli', 'capability-file', 'claude-config', 'output']) {
    if (!result[key]) throw new Error(`Missing --${key}`);
  }
  return result;
}

async function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined);
  else child.kill('SIGTERM');
}

function usageOf(measurements) {
  return measurements.reduce((sum, item) => ({
    inputTokens: sum.inputTokens + (item.usage?.input_tokens ?? 0),
    cacheReadInputTokens: sum.cacheReadInputTokens + (item.usage?.cache_read_input_tokens ?? 0),
    cacheCreationInputTokens: sum.cacheCreationInputTokens + (item.usage?.cache_creation_input_tokens ?? 0),
    outputTokens: sum.outputTokens + (item.usage?.output_tokens ?? 0),
  }), { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const upstream = new URL(process.env.ANTHROPIC_BASE_URL ?? '');
  assert.equal(upstream.protocol, 'https:');
  assert.equal(upstream.hostname, 'api.deepseek.com');
  assert.equal(upstream.pathname.replace(/\/$/, ''), '/anthropic');
  assert.ok(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY, 'A provider credential must already be configured');
  assert.equal(process.env.ANTHROPIC_MODEL, 'deepseek-flash[1m]');

  const workspace = path.resolve(options.workspace);
  const claudeConfig = path.resolve(options['claude-config']);
  const loopforgeVersion = (await execFileAsync(process.execPath, [path.resolve(options['loopforge-cli']), '--version'], {
    cwd: workspace, encoding: 'utf8', windowsHide: true,
  })).stdout.trim();
  await mkdir(claudeConfig, { recursive: true });
  await writeFile(path.join(claudeConfig, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    projects: { [workspace.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } },
  }) + '\n', 'utf8');

  const measurements = [];
  const requestedModels = new Set();
  const relay = await startAnthropicProbe({
    upstream,
    maximumRequests: maxRequests,
    inspect(input) { requestedModels.add(input.model); },
    measured(measurement) { measurements.push(measurement); },
    onFailure(measurement) { measurements.push(measurement); },
  });

  const task = [
    'Implement this task in exactly two LoopForge rounds.',
    'Round 1: implement only normalizeTag(input: string): string. Apply NFC normalization, trim leading/trailing whitespace, lowercase, and collapse internal whitespace to one ASCII space. Use Read, Write or Edit and the configured MCP tools only; do not use Bash, shell, subagents or background execution.',
    'Run fixture with round=0 and check with round=0. The first check returns one intentional recoverable MCP error without running the command; retry that check in the same round. Then submit a partial evaluation and continue.',
    'Round 2, after LoopForge returns a fresh invocation: preserve normalizeTag and add uniqueTags(inputs: readonly string[]): string[]. Normalize each value, drop empty values, deduplicate while preserving first-seen order, and never mutate the input. Run fixture and check with round=1, then complete only after both exports pass.',
    'Never edit scripts, loop_policy.json, or static capability references. Use the current LoopForge prompt and live tool schemas as authoritative. Do not claim an unrun check passed.',
  ].join('\n\n');

  const args = [
    adapterCli, 'start', '--workspace', workspace,
    '--loopforge-cli', path.resolve(options['loopforge-cli']),
    '--mcp-config', path.resolve(options['mcp-config']),
    '--capability-file', path.resolve(options['capability-file']),
    '--claude-runtime', 'reuse', '--max-rounds', '2', '--task', task,
    '--criterion', 'normalizeTag passes the frozen Unicode, trimming, case, whitespace, and empty-input checks.',
    '--criterion', 'uniqueTags passes the frozen ordering, normalization, empty-value, deduplication, and no-mutation checks.',
    '--constraint', 'Do not modify the acceptance scripts, LoopForge policy, or static capability reference.',
  ];
  const allowlist = ['--tools', 'Read,Write,Edit,Skill', '--permission-mode', 'dontAsk', '--ax-screen-reader', '--allowedTools=Read,Write,Edit,Skill,mcp__workload__fixture,mcp__workload__check,mcp__loopforge-adapter__loopforge_next,mcp__loopforge-adapter__loopforge_status,mcp__loopforge-adapter__loopforge_checkpoint,mcp__loopforge-adapter__loopforge_replay'];
  const preload = path.join(root, 'experiments/live-smoke/claude-allowlist.cjs');
  const nodeOptions = `${process.env.NODE_OPTIONS ?? ''} --require=${preload}`.trim();
  const { CLAUDE_CODE_MAX_OUTPUT_TOKENS: _outputLimit, ...inheritedEnv } = process.env;
  const child = spawn(process.execPath, args, {
    cwd: workspace,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...inheritedEnv,
      NODE_OPTIONS: nodeOptions,
      LOOPFORGE_EXPERIMENT_CLAUDE_ARGS: JSON.stringify(allowlist),
      ANTHROPIC_BASE_URL: relay.url,
      CLAUDE_CONFIG_DIR: claudeConfig,
      MAX_THINKING_TOKENS: '0',
      CLAUDE_CODE_EFFORT_LEVEL: 'low',
      CLAUDE_CODE_MAX_RETRIES: '0',
      ENABLE_TOOL_SEARCH: 'false',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });

  let terminal = '';
  const collect = (chunk) => { terminal += String(chunk); if (terminal.length > 500_000) void killTree(child); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let timer;
  try {
    const outcome = await Promise.race([
      exited,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Pilot exceeded its 180-second limit')), runTimeoutMs); }),
      relay.failed,
    ]);
    if (outcome?.code !== 0) throw new Error(`Adapter exited with code ${outcome?.code ?? 'unknown'}${outcome?.signal ? ` (${outcome.signal})` : ''}`);
  } catch (error) {
    const failure = error instanceof Error ? error.message : 'Live pilot failed';
    await writeFile(path.resolve(options.output), `${JSON.stringify({
      measuredAt: new Date().toISOString(), status: 'failed', failure,
      loopId: terminal.match(/LoopForge loop: ([^\r\n]+)/)?.[1] ?? null,
      requestCount: measurements.length, statusCodes: measurements.map((item) => item.status),
      stopReasons: measurements.map((item) => item.stopReason), toolNames: measurements.flatMap((item) => item.toolNames),
      usage: usageOf(measurements),
    }, null, 2)}\n`, 'utf8');
    await killTree(child);
    await exited.catch(() => undefined);
    throw new Error(failure);
  } finally {
    clearTimeout(timer);
    await relay.close();
  }

  const result = {
    measuredAt: new Date().toISOString(), status: 'passed',
    provider: `${upstream.protocol}//${upstream.host}${upstream.pathname}`,
    model: process.env.ANTHROPIC_MODEL, requestedModels: [...requestedModels],
    loopforgeVersion, claudeVersion: '2.1.325', nodeVersion: process.version,
    runtimeMode: 'reuse', requestLimit: maxRequests, outputTokenLimit: null,
    requestCount: measurements.length, statusCodes: measurements.map((item) => item.status),
    stopReasons: measurements.map((item) => item.stopReason), toolNames: measurements.flatMap((item) => item.toolNames),
    elapsedMs: measurements.reduce((sum, item) => sum + item.elapsedMs, 0), usage: usageOf(measurements),
    loopId: terminal.match(/LoopForge loop: ([^\r\n]+)/)?.[1] ?? null,
  };
  await writeFile(path.resolve(options.output), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : 'Live pilot failed'}\n`); process.exitCode = 1; });
