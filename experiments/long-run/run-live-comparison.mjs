import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startAnthropicProbe } from '../../dist/experiments/anthropic-probe.js';

const execFileAsync = promisify((await import('node:child_process')).execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adapterCli = path.join(root, 'dist/src/cli.js');
const task = [
  'Implement a local dependency task runner. Input is a JSON task graph; validate duplicate IDs, missing dependencies, and cycles; schedule runnable tasks deterministically while respecting a concurrency limit; support failed-task retries, skipping tasks with failed dependencies, run cancellation, and per-task timeouts; emit structured events and a final result. Provide a programmatic API and a CLI that reads JSON and writes JSONL, and document failure exit codes. Use TypeScript, Node.js >=18, and zero runtime dependencies. You decide task decomposition, round boundaries, tools, and completion. Follow LoopForge live guidance for every submission.',
  '',
  'At the start of each clean invocation, call the workload fixture tool with a short phase label. Use the task-runner skill when useful. Before each LoopForge submission, call the workload check tool and fix any reported failures. The configured after-phase acceptance command is independent evidence and must also pass before completion. Keep the acceptance scripts, LoopForge policy, static skill, and fixture service unchanged. Do not claim an unrun command passed.',
].join('\n');
const taskHash = createHash('sha256').update(task).digest('hex');
const maxRequests = 64;
const runTimeoutMs = 15 * 60 * 1000;
const adapterCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]; const value = args[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) throw new Error('Every option requires a value');
    result[flag.slice(2)] = value; index += 1;
  }
  for (const key of ['fixture-root', 'loopforge-cli', 'output-dir']) if (!result[key]) throw new Error(`Missing --${key}`);
  return result;
}

const sha256 = (content) => createHash('sha256').update(content).digest('hex');
const tokenUsage = (items) => items.reduce((sum, item) => ({
  input: sum.input + (item.usage?.input_tokens ?? 0),
  cacheRead: sum.cacheRead + (item.usage?.cache_read_input_tokens ?? 0),
  cacheCreation: sum.cacheCreation + (item.usage?.cache_creation_input_tokens ?? 0),
  output: sum.output + (item.usage?.output_tokens ?? 0),
}), { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 });

function runSync(command, args, cwd, timeout = 180_000) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status ?? result.error?.code ?? 'unknown'}): ${(result.stderr ?? '').trim().slice(-2000)}`);
  return result.stdout;
}

function claudeVersion(cwd) {
  try {
    if (process.platform === 'win32') return runSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'claude --version'], cwd).trim();
    return runSync('claude', ['--version'], cwd).trim();
  } catch { return 'unknown'; }
}

async function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined);
  else child.kill('SIGTERM');
}

async function readJsonLines(file) {
  try { return (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
}

async function runTrial({ fixtureRoot, fixtureCommit, loopforgeCli, outputDir, id, mode }) {
  const trialDir = path.join(outputDir, id);
  const workspace = path.join(trialDir, 'workspace');
  const claudeConfig = path.join(trialDir, 'claude-config');
  const mcpConfig = path.join(trialDir, 'mcp.json');
  const serviceLog = path.join(trialDir, 'service-events.jsonl');
  const providerFile = path.join(trialDir, 'provider-summary.json');
  const lifecycleFile = path.join(trialDir, 'host-lifecycle.jsonl');
  const transcriptFile = path.join(trialDir, 'adapter-transcript.log');
  await mkdir(trialDir, { recursive: false });
  await mkdir(claudeConfig, { recursive: true });
  runSync('git', ['clone', '--quiet', '--shared', '--no-checkout', fixtureRoot, workspace], root);
  runSync('git', ['checkout', '--quiet', '--detach', fixtureCommit], workspace);
  const checkedCommit = runSync('git', ['rev-parse', 'HEAD'], workspace).trim();
  assert.equal(checkedCommit, fixtureCommit, 'Trial workspace must use the frozen fixture commit');

  const npmInstallStarted = performance.now();
  const npmInstall = process.platform === 'win32'
    ? runSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm ci'], workspace, 180_000)
    : runSync('npm', ['ci'], workspace, 180_000);
  const npmInstallMs = Math.round(performance.now() - npmInstallStarted);
  await writeFile(path.join(trialDir, 'setup.log'), npmInstall, 'utf8');
  await writeFile(path.join(claudeConfig, '.claude.json'), `${JSON.stringify({
    hasCompletedOnboarding: true,
    projects: { [workspace.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } },
  }, null, 2)}\n`, 'utf8');
  await writeFile(mcpConfig, `${JSON.stringify({ mcpServers: { workload: {
    command: process.execPath,
    args: [path.join(workspace, 'tools/fixture-service.mjs')],
    env: {
      FIXTURE_SOURCE: path.join(workspace, 'src/task-runner.ts'), FIXTURE_LOG: serviceLog,
      FIXTURE_ACCEPTANCE: path.join(workspace, 'scripts/acceptance-runner.cjs'),
      FIXTURE_WORKSPACE: workspace, FIXTURE_MARKER: 'long-run-fixture-v1',
    },
  } } }, null, 2)}\n`, 'utf8');

  const provider = new URL(process.env.ANTHROPIC_BASE_URL ?? '');
  assert.equal(provider.protocol, 'https:');
  assert.equal(provider.hostname, 'api.deepseek.com');
  assert.equal(provider.pathname.replace(/\/$/, ''), '/anthropic');
  assert.equal(process.env.ANTHROPIC_MODEL, 'deepseek-flash[1m]');
  assert.ok(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY, 'A configured provider credential is required');

  const measurements = [];
  const requestedModels = new Set();
  const measuredSet = new WeakSet();
  const relay = await startAnthropicProbe({
    upstream: provider, maximumRequests: maxRequests, requestTimeoutMs: 180_000,
    inspect(input) { requestedModels.add(input.model); },
    measured(item) {
      if (!measuredSet.has(item)) { measuredSet.add(item); measurements.push(item); }
    },
    onFailure(item) { if (!measuredSet.has(item)) { measuredSet.add(item); measurements.push(item); } },
  });

  const allowedTools = [
    'Read', 'Write', 'Edit', 'Bash', 'Skill',
    'mcp__workload__fixture', 'mcp__workload__check',
    'mcp__loopforge-adapter__loopforge_next', 'mcp__loopforge-adapter__loopforge_status',
    'mcp__loopforge-adapter__loopforge_checkpoint', 'mcp__loopforge-adapter__loopforge_replay',
  ];
  const preload = path.join(root, 'experiments/live-smoke/claude-allowlist.cjs');
  const childStartedAt = performance.now();
  const startedWallClock = new Date().toISOString();
  const { CLAUDE_CODE_MAX_OUTPUT_TOKENS: _outputLimit, ...inheritedEnv } = process.env;
  const child = spawn(process.execPath, [adapterCli, 'start', '--workspace', workspace,
    '--loopforge-cli', loopforgeCli, '--mcp-config', mcpConfig, '--claude-runtime', mode,
    '--task', task], {
    cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...inheritedEnv,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${preload}`.trim(),
      LOOPFORGE_EXPERIMENT_CLAUDE_ARGS: JSON.stringify(['--tools', 'Read,Write,Edit,Bash,Skill', '--permission-mode', 'dontAsk', '--ax-screen-reader', `--allowedTools=${allowedTools.join(',')}`]),
      LOOPFORGE_EXPERIMENT_LIFECYCLE_LOG: lifecycleFile,
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

  let lineCarry = '';
  let transcript = '';
  let loopId = null;
  let adapterDiagnostics = [];
  let outputOverflow = false;
  const collect = (chunk) => {
    const text = String(chunk);
    transcript += text;
    lineCarry += text;
    if (lineCarry.length > 1024 * 1024) { outputOverflow = true; void killTree(child); return; }
    const lines = lineCarry.split(/\r?\n/); lineCarry = lines.pop() ?? '';
    for (const line of lines) {
      const found = line.match(/LoopForge loop: ([a-f0-9-]{20,})/i);
      if (found) loopId = found[1];
      if (line.includes('[LoopForge Adapter]')) adapterDiagnostics.push(line.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 500));
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let timer;
  let runFailure;
  let outcome;
  try {
    outcome = await Promise.race([
      exited,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Trial exceeded its 15-minute execution budget')), runTimeoutMs); }),
      relay.failed,
    ]);
    if (outcome?.code !== 0) runFailure = `Adapter exited with code ${outcome?.code ?? 'unknown'}${outcome?.signal ? ` (${outcome.signal})` : ''}`;
  } catch (error) {
    runFailure = error instanceof Error ? error.message : 'Trial failed';
    await killTree(child);
    await exited.catch(() => undefined);
  } finally {
    clearTimeout(timer);
    await relay.close();
  }
  if (lineCarry) {
    const found = lineCarry.match(/LoopForge loop: ([a-f0-9-]{20,})/i);
    if (found) loopId = found[1];
  }
  const elapsedMs = Math.round(performance.now() - childStartedAt);
  await writeFile(transcriptFile, transcript, 'utf8');
  const usage = tokenUsage(measurements);
  const lifecycle = await readJsonLines(lifecycleFile);
  const services = await readJsonLines(serviceLog);
  let loopInspection = null;
  let loopExplain = null;
  if (loopId) {
    try { loopInspection = JSON.parse(runSync(process.execPath, [loopforgeCli, 'inspect', loopId, '--json'], workspace)); }
    catch (error) { adapterDiagnostics.push(`Loop inspection failed: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown'}`); }
    try { loopExplain = JSON.parse(runSync(process.execPath, [loopforgeCli, 'explain', loopId, '--json'], workspace)); }
    catch (error) { adapterDiagnostics.push(`Loop explanation failed: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown'}`); }
  }
  const finalCommand = spawnSync(process.execPath, [path.join(workspace, 'scripts/final-acceptance.cjs')], {
    cwd: workspace, encoding: 'utf8', timeout: 180_000, windowsHide: true, maxBuffer: 65536,
  });
  const finalAcceptance = { exitCode: finalCommand.status, passed: finalCommand.status === 0 && finalCommand.stdout.includes('FINAL_ACCEPTANCE_PASSED') };
  await writeFile(path.join(trialDir, 'final-acceptance.json'), `${JSON.stringify(finalAcceptance, null, 2)}\n`, 'utf8');
  const terminalRound = loopExplain?.rounds?.at(-1);
  const loopMachineSuccess = terminalRound?.loopStopReason === 'completed' && terminalRound?.evidencePosture?.machineBackedSuccess === true;
  const lifecycleEvents = lifecycle.filter((event) => event.type !== 'output');
  const report = {
    id, mode, status: runFailure ? (loopMachineSuccess && finalAcceptance.passed ? 'task-completed-host-exit-failure' : 'failed') : 'completed',
    ...(runFailure ? { failure: runFailure } : {}), adapterExitCode: outcome?.code ?? null,
    startedAt: startedWallClock, elapsedMs, npmInstallMs,
    environment: {
      platform: process.platform, node: process.version,
      claudeCode: claudeVersion(root),
      loopforge: runSync(process.execPath, [loopforgeCli, '--version'], workspace).trim(),
      model: process.env.ANTHROPIC_MODEL, provider: `${provider.protocol}//${provider.host}${provider.pathname}`,
      adapterCommit, fixtureCommit, fixtureWorkspaceCommit: checkedCommit,
    },
    taskSha256: taskHash,
    hashes: {
      policy: sha256(await readFile(path.join(workspace, 'loop_policy.json'))),
      skill: sha256(await readFile(path.join(workspace, '.claude/skills/task-runner/SKILL.md'))),
      fixtureService: sha256(await readFile(path.join(workspace, 'tools/fixture-service.mjs'))),
      acceptance: sha256(await readFile(path.join(workspace, 'scripts/acceptance.cjs'))),
    },
    provider: {
      maximumRequests: maxRequests, requestTimeoutMs: 180_000, outputTokenLimit: null, measuredTokenBudget: null,
      requestCount: measurements.length, statusCodes: measurements.map((item) => item.status),
      completeResponses: measurements.filter((item) => item.complete).length,
      elapsedMs: measurements.reduce((sum, item) => sum + item.elapsedMs, 0),
      requestedModels: [...requestedModels], usage,
      cost: 'unknown', cacheSavings: 'unknown',
    },
    host: {
      lifecycleEvents,
      uniqueHostPids: [...new Set(lifecycleEvents.filter((event) => event.type === 'started').map((event) => event.pid))],
      confirmedSessions: lifecycleEvents.filter((event) => event.type === 'started').length,
      reuseConfirmations: lifecycleEvents.filter((event) => event.type === 'diagnostic' && event.category === 'session_reused').length,
      restartFallbacks: lifecycleEvents.filter((event) => event.type === 'diagnostic' && event.category === 'host_restart_fallback').length,
      adapterDiagnostics,
      rawTranscriptSaved: true,
    },
    workloadService: {
      events: services,
      starts: services.filter((event) => event.kind === 'start').length,
      pids: [...new Set(services.filter((event) => event.kind === 'start').map((event) => event.pid))],
    },
    loopId, loopInspection, loopExplain, finalAcceptance,
    artifacts: {
      provider: path.basename(providerFile), serviceEvents: path.basename(serviceLog),
      transcript: path.basename(transcriptFile),
      lifecycle: path.basename(lifecycleFile), workspace: 'workspace', claudeConfig: 'removed after run',
    },
    outputOverflow,
  };
  await writeFile(providerFile, `${JSON.stringify({ ...report.provider, requestedModels: report.provider.requestedModels }, null, 2)}\n`, 'utf8');
  await writeFile(path.join(trialDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rm(claudeConfig, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ id, mode, status: report.status, failure: runFailure, elapsedMs, requests: measurements.length, rounds: loopInspection?.rounds?.length ?? null, finalAcceptance: finalAcceptance.passed, hostPids: report.host.uniqueHostPids.length, mcpStarts: report.workloadService.starts })}\n`);
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixtureRoot = path.resolve(options['fixture-root']);
  const outputDir = path.resolve(options['output-dir']);
  const fixtureCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureRoot, encoding: 'utf8' }).trim();
  const ids = (options['run-ids'] ?? 'A0,B0').split(',').map((value) => value.trim()).filter(Boolean);
  if (ids.length < 1 || ids.length > 2 || new Set(ids).size !== ids.length) throw new Error('Use one run id or one two-run feasibility pair');
  const modes = { A0: 'restart', B0: 'reuse', A1: 'restart', B1: 'reuse', B2: 'reuse', A2: 'restart', A3: 'restart', B3: 'reuse', A4: 'restart', B4: 'reuse', A5: 'restart', B5: 'reuse' };
  await mkdir(outputDir, { recursive: true });
  const results = [];
  for (const id of ids) {
    const mode = modes[id];
    if (!mode) throw new Error(`Unknown run id: ${id}`);
    results.push(await runTrial({ fixtureRoot, fixtureCommit, loopforgeCli: path.resolve(options['loopforge-cli']), outputDir, id, mode }));
  }
  const summary = {
    measuredAt: new Date().toISOString(), status: results.every((result) => result.status === 'completed') ? 'completed' : 'contains-failures',
    fixtureCommit, taskSha256: taskHash, sequence: ids,
    budgets: { executionMs: runTimeoutMs, requestsPerRun: maxRequests, requestTimeoutMs: 180_000, outputTokensPerRequest: null, measuredInputTokensPerRun: null, outputTokensPerRun: null, providerCostUsd: 'unknown' },
    results: results.map((result) => ({ id: result.id, mode: result.mode, status: result.status, elapsedMs: result.elapsedMs, requests: result.provider.requestCount, rounds: result.loopInspection?.rounds?.length ?? null, finalAcceptance: result.finalAcceptance.passed })),
    conclusion: ids.length === 2 ? 'Feasibility pair only; do not infer statistical significance or treat this pair as the three paired comparison samples.' : 'Single feasibility companion run; the paired comparison remains incomplete.',
  };
  await writeFile(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : 'Long-run feasibility pair failed'}\n`); process.exitCode = 1; });
