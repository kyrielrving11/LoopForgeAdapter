import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeDriver, type PtyFactory } from "../src/hosts/claude.js";
import { LoopForgeSupervisor } from "../src/supervisor.js";
import type { LoopForgeMcpClient } from "../src/mcp/bridge.js";
import { startAnthropicProbe, type ProbeMeasurement, type ProbeRequest } from "./anthropic-probe.js";
import type { WorkloadServiceEvent } from "./workload-service.js";

type Fault = "none" | "invalid-round" | "legacy-crash" | "check-error" | "end-turn";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const reference = `# TypeScript tag library capability reference
This is static coding guidance, not a task plan or previous task history.
Use current round requirements and current workspace files as inputs.
Read a source before changing it. Prefer a small pure function over an abstraction.
The project runs TypeScript directly under the installed Node runtime. Do not add dependencies.
The external workload service exposes fixture and check tools. Read fixture at the start of each task.
The fixture returns ephemeral transport diagnostics as well as public examples. Do not copy diagnostic markers into code or submissions.
The check tool runs independent read-only tests held outside the editable source directory.
A passed check is an observation about the current files, not a promise about untested cases.
Keep earlier accepted behavior while adding the current export. Avoid mutation of callers' arrays.
Unicode normalization, case conversion, and whitespace handling are distinct operations.
Trimming removes leading and trailing whitespace. A whitespace regular expression can collapse internal runs.
NFC normalizes canonically equivalent Unicode spellings. Case conversion here is locale independent.
An ordered Set can retain first appearance while eliminating duplicates. Ignore empty normalized tags when aggregating.
Object property names may collide with Object.prototype names. When counting arbitrary strings, choose a safe dictionary.
Do not store hidden task state in module globals. Functions should depend only on their arguments.
Treat tool schemas as the authority for arguments. A skill body being available does not mean a skill was activated.
Use Read, Write or Edit to work only inside the provided temporary workspace. No shell or network tools are needed.
If an acceptance check fails, inspect the specific failure and current source before making a correction.
Do not claim check success without running the actual check tool for the current task.
Submit only after the current check passes. The experiment fixture determines invocation switching; you do not need to clear the host yourself.
`;

const implementation = (round: number) => `export function normalizeTag(input: string): string { return input.normalize("NFC").trim().toLowerCase().replace(/\\s+/g, " "); }\n` +
  (round >= 1 ? `export function uniqueTags(inputs: readonly string[]): string[] { return [...new Set(inputs.map(normalizeTag).filter(Boolean))]; }\n` : "") +
  (round >= 2 ? `export function countTags(inputs: readonly string[]): Record<string, number> { const counts: Record<string, number> = Object.create(null); for (const input of inputs) { const tag = normalizeTag(input); if (tag) counts[tag] = (counts[tag] ?? 0) + 1; } return counts; }\n` : "");

async function trial(live: boolean, stableUser: boolean, fault: Fault, outputPath?: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), "loopforge-workload-"));
  const workspace = path.join(root, "workspace"); const config = path.join(root, "config");
  mkdirSync(workspace); mkdirSync(config); mkdirSync(path.join(workspace, "src"));
  const source = path.join(workspace, "src/tags.ts"); writeFileSync(source, "// Implement the current public API here.\n");
  const skillDirectory = path.join(workspace, ".claude/skills/tag-review"); mkdirSync(skillDirectory, { recursive: true });
  const nonce = randomUUID();
  const skillMarker = "ON_DEMAND_SKILL_" + nonce;
  const toolMarkers = [0, 1, 2].map((i) => `DYNAMIC_FIXTURE_${nonce}_${i}`);
  const roundMarkers = [0, 1, 2].map((i) => `WORKLOAD_ROUND_${nonce}_${i}`);
  writeFileSync(path.join(skillDirectory, "SKILL.md"), `---\nname: tag-review\ndescription: Review pure tag-library functions against Unicode and object-key edge cases.\n---\n${skillMarker}\nReview the current requirements; check whitespace, canonical Unicode spellings, empty inputs and prototype-sensitive keys where applicable. This marker is ephemeral diagnostics, never copy it into files.\n`);
  writeFileSync(path.join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: { [workspace.replaceAll("\\", "/")]: { hasTrustDialogAccepted: true } } }));
  const capabilityFile = path.join(root, "coding-reference.md"); writeFileSync(capabilityFile, reference);
  const acceptanceFile = path.join(root, "acceptance.cjs");
  writeFileSync(acceptanceFile, `const assert=require('node:assert/strict');const {pathToFileURL}=require('node:url');
(async()=>{const m=await import(pathToFileURL(process.env.WORKLOAD_SOURCE).href);const round=Number(process.env.WORKLOAD_ROUND);
assert.equal(m.normalizeTag('  CaFe\\t AU  LAIT  '),'cafe au lait');assert.equal(m.normalizeTag(' CAFE\\u0301 '),'café');assert.equal(m.normalizeTag(' \\t '),'');assert.equal(m.normalizeTag('__proto__'),'__proto__');
if(round>=1){const input=[' A ','a','','CAFÉ',' cafe\\u0301 ','B'];assert.deepEqual(m.uniqueTags(input),['a','café','b']);assert.deepEqual(input,[' A ','a','','CAFÉ',' cafe\\u0301 ','B']);}
if(round>=2){const result=m.countTags(['__proto__',' __PROTO__ ','constructor','A','a','',' café ','cafe\\u0301']);assert.equal(Object.getPrototypeOf(result),null);assert.deepEqual(Object.entries(result),[['__proto__',2],['constructor',1],['a',2],['café',2]]);}
console.log('ACCEPTANCE_PASSED');})().catch(()=>{console.log('ACCEPTANCE_FAILED');process.exitCode=1;});`);
  const acceptanceHash = hash(readFileSync(acceptanceFile, "utf8"));
  const serviceLog = path.join(root, "service.jsonl");
  const service = fileURLToPath(new URL("./workload-service.js", import.meta.url));
  const mcpConfig = path.join(root, "mcp.json"); writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { workload: {
    command: process.execPath, args: [service], env: { WORKLOAD_SOURCE: source, WORKLOAD_MARKERS: JSON.stringify(toolMarkers), WORKLOAD_LOG: serviceLog,
      WORKLOAD_ACCEPTANCE: acceptanceFile, WORKLOAD_WORKSPACE: workspace,
      WORKLOAD_LEGACY_CRASH: fault === "legacy-crash" ? "1" : "0", WORKLOAD_INJECT_CHECK_ERROR: fault === "check-error" ? "1" : "0" },
  } } }));
  const upstream = live ? new URL(process.env.ANTHROPIC_BASE_URL ?? "https://api.deepseek.com/anthropic") : undefined;
  const measurements: Array<ProbeMeasurement & { round: number; firstRequest: boolean; systemHash: string; toolsHash: string; nativeUserHash: string | null;
    previousPromptAbsent: boolean; previousToolResultAbsent: boolean; oldSkillBodyAbsent: boolean; currentToolResultPresent: boolean; fixedReferencePresent: boolean; toolErrors: string[];
    toolResults: Array<{ tool: string; idHash: string; error: boolean; detail: string }> }> = [];
  const firstRequests = new Set<number>(); let currentMeasurement: typeof measurements[number] | undefined;
  let activeRound = 0; let hostStarts = 0; const nativeSessions: string[] = [];
  let executionReject!: (error: Error) => void;
  const executionFailed = new Promise<never>((_, reject) => { executionReject = reject; });
  void executionFailed.catch(() => undefined);
  const step = [0, 0, 0];
  const relay = await startAnthropicProbe({ ...(upstream ? { upstream } : {}),
    ...(stableUser ? { stableUserId: "workload_" + randomUUID().replaceAll("-", "") } : {}), maximumRequests: 36, maximumOutputTokens: 1024,
    inspect(input: ProbeRequest) {
      const body = JSON.stringify(input); const messages = JSON.stringify(input.messages);
      const round = roundMarkers.findIndex((marker) => messages.includes(marker)); assert.ok(round >= 0 && round === activeRound);
      const firstRequest = !firstRequests.has(round); firstRequests.add(round);
      assert.ok(measurements.filter((entry) => entry.round === round).length < 12, "Probe current task exceeded its request budget");
      const toolErrors: string[] = [];
      const toolResults: typeof measurements[number]["toolResults"] = [];
      const toolNames = new Map<string, string>();
      const scrub = (text: string) => text.replaceAll(root, "<temp>").replaceAll(root.replaceAll("\\", "/"), "<temp>")
        .replace(/[A-Za-z]:[^\s\"']+/g, "<path>").replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>");
      for (const message of Array.isArray(input.messages) ? input.messages : []) {
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block.type === "tool_use") toolNames.set(block.id, block.name);
          if (block.type === "tool_result") toolResults.push({ tool: toolNames.get(block.tool_use_id) ?? "unknown", idHash: hash(String(block.tool_use_id)),
            error: block.is_error === true, detail: block.is_error ? scrub(typeof block.content === "string" ? block.content : JSON.stringify(block.content)).slice(0, 600) : "" });
          if (block.type === "tool_result" && block.is_error) {
            const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
            // Synthetic experiment only; strip all paths and identifiers.
            toolErrors.push(scrub(text).slice(0,400));
          }
        }
      }
      currentMeasurement = { round, firstRequest, systemHash: hash(JSON.stringify(input.system)), toolsHash: hash(JSON.stringify(input.tools)),
        nativeUserHash: typeof input.metadata?.user_id === "string" ? hash(input.metadata.user_id) : null,
        previousPromptAbsent: roundMarkers.slice(0, round).every((marker) => !body.includes(marker)),
        previousToolResultAbsent: toolMarkers.slice(0, round).every((marker) => !body.includes(marker)),
        oldSkillBodyAbsent: !body.includes(skillMarker), currentToolResultPresent: messages.includes(toolMarkers[round]!), toolErrors, toolResults,
        fixedReferencePresent: JSON.stringify(input.system).includes(JSON.stringify(reference).slice(1,-1)),
        status: 0, elapsedMs: 0, firstContentMs: null, usage: null, complete: false, stopReason: null, toolNames: [],
      };
      assert.ok(currentMeasurement.previousPromptAbsent && currentMeasurement.previousToolResultAbsent, "Fresh workload must not inherit previous prompts or tool results");
      assert.ok(currentMeasurement.fixedReferencePresent, "Complete selected static reference must remain in native system context");
      if (round > 0 && firstRequest) assert.ok(currentMeasurement.oldSkillBodyAbsent, "Old expanded skill must not silently survive clear");
      measurements.push(currentMeasurement);
      if (events().some((event) => event.kind === "fatal")) executionReject(new Error("MCP fixture exited after invalid arguments; no check ran"));
    },
    measured(measurement) {
      Object.assign(currentMeasurement!, measurement);
      process.stdout.write(JSON.stringify({ progress: true, stableUser, round: currentMeasurement!.round, request: measurements.length,
        stopReason: measurement.stopReason, toolNames: measurement.toolNames, usage: measurement.usage, toolErrors: currentMeasurement!.toolErrors }) + "\n");
    },
    localReply(input) {
      if (fault === "end-turn") return { text: "Stopping here without submitting the current round." };
      const round = activeRound; const stage = step[round]!++; const tool = (suffix: string) => input.tools!.find(({ name }) => name === suffix || name.endsWith(suffix))!.name;
      if (round === 0 && stage === 0) return { name: tool("Skill"), input: { skill: "loopforge-static:tag-review" } };
      const position = stage - (round === 0 ? 1 : 0);
      if (position === 0) return { name: tool("fixture"), input: { round } };
      if (position === 1) return { name: tool("Write"), input: { file_path: source, content: implementation(round) } };
      if (position === 2) return { name: tool("check"), input: { round: round === 0 && ["invalid-round", "legacy-crash"].includes(fault) ? 9 : round } };
      if (round === 0 && fault !== "none" && position === 3) return { name: tool("check"), input: { round } };
      return { name: tool("loopforge_next"), input: { summary: "Current task checked." } };
    },
  });
  const events = (): WorkloadServiceEvent[] => existsSync(serviceLog) ? readFileSync(serviceLog, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as WorkloadServiceEvent) : [];
  const requirements = [
    'Implement and export normalizeTag(input: string): string in src/tags.ts. Normalize Unicode to NFC, trim, lowercase using locale-independent toLowerCase, collapse internal whitespace runs into one ASCII space. Empty/whitespace-only yields an empty string. Invoke the available loopforge-static:tag-review skill once this task.',
    'Preserve normalizeTag and add export uniqueTags(inputs: readonly string[]): string[]. Normalize each input, drop empty tags, remove duplicates and preserve order of first appearance. Do not mutate the input.',
    'Preserve previous exports and add export countTags(inputs: readonly string[]): Record<string, number>. Normalize inputs, drop empties and count occurrences. Return a null-prototype dictionary so __proto__ and constructor are ordinary keys.',
  ];
  const roundInput = () => ({ content: [
    { type: "text", text: `${roundMarkers[activeRound]}\nTemporary TypeScript coding exercise, task ${activeRound}. ${requirements[activeRound]}\nUse only the supplied temporary workspace. Start by calling workload fixture with round=${activeRound}. Modify src/tags.ts using native file tools, call workload check with round=${activeRound}, fix failures if necessary, then call loopforge_next with a short summary. Do not stop with a text reply. Do not read other projects or copy diagnostic markers into files.` },
    { type: "text", text: JSON.stringify({ contextMode: "fresh_invocation", contextReason: "round_boundary", loopId: "workload-loop", sessionId: "workload-session", submissionHandle: `workload-${activeRound}` }) },
  ] });
  let supervisor!: LoopForgeSupervisor;
  const loopforge: LoopForgeMcpClient = {
    async listTools() { return [{ name: "loopforge_next", description: "Exercise-only round submission after workload check passes. Continue through the current task sequence; no real LoopForge storage is connected.", inputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false } }]; },
    async callTool(name) {
      if (name === "loopforge_start") return roundInput();
      assert.equal(name, "loopforge_next");
      assert.equal(hash(readFileSync(acceptanceFile, "utf8")), acceptanceHash, "Independent checks must remain unchanged");
      const currentEvents = events().filter((event) => event.round === activeRound);
      assert.ok(currentEvents.some((event) => event.kind === "fixture"), "Agent must observe the current fixture");
      assert.equal(currentEvents.filter((event) => event.kind === "check").at(-1)?.passed, true, "Current source must pass the independent command");
      assert.equal(currentEvents.filter((event) => event.kind === "check").at(-1)?.sourceHash, hash(readFileSync(source, "utf8")), "Source must still match the passed check");
      nativeSessions.push(hash(supervisor.activeInvocation!.sessionId));
      activeRound++;
      return activeRound < 3 ? roundInput() : { content: [{ type: "text", text: '{"ok":true,"stopReason":"completed"}' }] };
    },
  };
  const nodePty = createRequire(import.meta.url)("node-pty") as { spawn: PtyFactory };
  const driver = new ClaudeCodeDriver({ reuseProcess: true, capabilityFiles: [capabilityFile], ptyFactory: (file, args, options) => {
    hostStarts++; return nodePty.spawn(file, [...args, "--tools", "Read,Write,Edit,Skill", "--permission-mode", "dontAsk", "--ax-screen-reader",
      "--allowedTools=Read,Write,Edit,Skill,mcp__workload__fixture,mcp__workload__check,mcp__loopforge-adapter__loopforge_next"], options);
  } });
  let complete!: () => void; const done = new Promise<void>((resolve) => { complete = resolve; });
  supervisor = new LoopForgeSupervisor({ host: driver, loopforge, workspace, mcpConfigPath: mcpConfig,
    env: { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: relay.url, ANTHROPIC_AUTH_TOKEN: live ? process.env.ANTHROPIC_AUTH_TOKEN : "local-probe",
      ANTHROPIC_API_KEY: live ? process.env.ANTHROPIC_API_KEY ?? "" : "", ANTHROPIC_MODEL: "deepseek-flash[1m]", CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "1024", MAX_THINKING_TOKENS: "0", CLAUDE_CODE_EFFORT_LEVEL: "low", ENABLE_TOOL_SEARCH: "false",
      DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, onTerminalResult: () => complete(),
  });
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Workload timeout; completed rounds=${activeRound}, requests=${measurements.length}`)), 180000); });
  const started = performance.now(); let failure: string | undefined;
  const monitor = async (initial: NonNullable<LoopForgeSupervisor["activeInvocation"]>) => {
    let invocation: typeof initial | undefined = initial;
    while (invocation) {
      for await (const event of invocation) {
        if (event.type === "turn_ended") throw new Error(`Claude turn ended without submitting task ${activeRound}: ${event.reason}`);
        if (event.type === "failed") throw new Error(event.message);
      }
      invocation = await supervisor.nextInvocation(invocation.invocationId);
    }
    if (activeRound < 3) throw new Error("Host exited before completing the task sequence");
  };
  try {
    const initial = await Promise.race([supervisor.start({ task: "isolated workload" }), relay.failed, executionFailed, timeout]);
    assert.ok(initial);
    const watching = monitor(initial).catch((error: Error) => executionReject(error));
    void watching;
    await Promise.race([done, relay.failed, executionFailed, timeout]);
    assert.equal(activeRound, 3); assert.equal(new Set(nativeSessions).size, 3); assert.equal(hostStarts, 1);
    assert.ok(measurements.every((entry) => entry.complete));
    for (let round = 0; round < 3; round++) assert.ok(measurements.some((entry) => entry.round === round && entry.currentToolResultPresent), "Current-round tool result must reach the provider");
    assert.ok(measurements.some((entry) => entry.round === 0 && !entry.oldSkillBodyAbsent), "Native skill body must actually load in the first task");
    assert.equal(readFileSync(capabilityFile, "utf8"), reference);
  } catch (error) { failure = error instanceof Error ? error.message : "Workload failed"; }
  finally { clearTimeout(timer); await supervisor.stop("adapter_error").catch(() => { failure ??= "Host shutdown failed"; }); await relay.close(); }
  const serviceEvents = events();
  const report = { measuredAt: new Date().toISOString(), mode: live ? "live-deepseek" : "local-scripted-no-cost-measurement", stableUser, fault,
    passed: failure === undefined, ...(failure ? { failure } : {}), elapsedMs: Math.round(performance.now() - started), artificialRoundDelayMs: 0,
    hostStarts, mcpStarts: serviceEvents.filter((event) => event.kind === "start").length, nativeSessionHashes: nativeSessions,
    checks: serviceEvents.filter((event) => event.kind === "check").map(({ round, passed }) => ({ round, passed })),
    serviceErrors: serviceEvents.filter((event) => event.kind === "argument-error" || event.kind === "injected-error" || event.kind === "fatal").map(({ kind, round, tool }) => ({ kind, round, tool })),
    serviceEvents: serviceEvents.map(({pid, ...event}) => event),
    finalSourceHash: hash(readFileSync(source, "utf8")), measurements,
  };
  if (outputPath) {
    writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
    writeFileSync(outputPath.replace(/\.json$/, ".tags.ts"), readFileSync(source, "utf8"));
  }
  process.stdout.write(JSON.stringify({ stableUser, passed: report.passed, failure, elapsedMs: report.elapsedMs, hostStarts: report.hostStarts, mcpStarts: report.mcpStarts,
    requests: measurements.length, firstRequests: measurements.filter((entry) => entry.firstRequest).map((entry) => ({ round: entry.round, ...entry.usage })),
    checks: report.checks }) + "\n");
  rmSync(root, { recursive: true, force: true });
  if (failure) throw new Error(failure);
}

async function main() {
  let live = false; let output: string | undefined; let stableOnly = false; let fault: Fault = "none";
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--live") live = true;
    else if (args[i] === "--stable-only") stableOnly = true;
    else if (args[i] === "--fault" && ["invalid-round", "legacy-crash", "check-error", "end-turn"].includes(args[i + 1]!)) fault = args[++i] as Fault;
    else if (args[i] === "--output-dir" && args[i + 1] && !args[i + 1]!.startsWith("--")) output = path.resolve(args[++i]!);
    else throw new Error("Usage: probe:claude-workload -- [--live] [--stable-only] [--fault invalid-round|legacy-crash|check-error|end-turn] [--output-dir DIR]");
  }
  if (live) {
    assert.ok(fault === "none" || fault === "check-error", "Invalid model arguments are only scripted locally; live faults are service-side errors");
    assert.equal(process.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic", "Official DeepSeek endpoint required");
    assert.ok(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY, "Existing provider credential required");
  }
  if (output) mkdirSync(output, { recursive: true });
  for (const stableUser of stableOnly ? [true] : [false, true]) await trial(live, stableUser, fault, output ? path.join(output, stableUser ? "stable-user.json" : "native-user.json") : undefined);
}

void main().catch((error: unknown) => { process.stderr.write((error instanceof Error ? error.message : "Workload failed") + "\n"); process.exitCode = 1; });
