import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Link to source skill directories; never synthesize or retain skill content. */
export function exposeClaudeSkills(directory: string, workspace: string, env: NodeJS.ProcessEnv, pluginIds: string[]): string[] {
  const config = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const sources = new Map<string, string>();
  const roots = [path.join(config, "skills"), path.join(workspace, ".claude/skills")];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(name) || ["synced", "anthropic-skills"].includes(name.toLowerCase())) continue;
      const source = path.join(root, name);
      if (existsSync(path.join(source, "SKILL.md"))) sources.set(name, source);
    }
  }
  const plugins: string[] = [];
  if (sources.size) {
    const plugin = path.join(directory, "static-skills");
    mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
    mkdirSync(path.join(plugin, "skills"));
    writeFileSync(path.join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "loopforge-static", version: "1.0.0" }));
    for (const [name, source] of sources) symlinkSync(source, path.join(plugin, "skills", name), process.platform === "win32" ? "junction" : "dir");
    plugins.push(plugin);
  }
  const cache = path.join(config, "plugins/cache");
  const pluginNames = new Set<string>();
  for (const id of pluginIds) {
    const [name, marketplace] = id.split("@");
    if (!name || !marketplace || pluginNames.has(name)) continue;
    const marketplaceRoot = path.join(cache, marketplace);
    const pluginRoot = path.join(marketplaceRoot, name);
    if (!existsSync(pluginRoot)) continue;
    const versions = readdirSync(pluginRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    const sourceRoot = versions.map((version) => path.join(marketplaceRoot, name, version)).find((candidate) => existsSync(path.join(candidate, ".claude-plugin/plugin.json")));
    if (!sourceRoot) continue;
    const skills = path.join(sourceRoot, "skills");
    if (!existsSync(skills)) continue;
    const target = path.join(directory, `plugin-${name}`);
    mkdirSync(path.join(target, ".claude-plugin"), { recursive: true });
    mkdirSync(path.join(target, "skills"));
    writeFileSync(path.join(target, ".claude-plugin/plugin.json"), JSON.stringify({ name, version: "1.0.0" }));
    for (const skill of readdirSync(skills)) {
      const source = path.join(skills, skill);
      if (/^[a-zA-Z0-9_.-]+$/.test(skill) && existsSync(path.join(source, "SKILL.md"))) {
        symlinkSync(source, path.join(target, "skills", skill), process.platform === "win32" ? "junction" : "dir");
      }
    }
    plugins.push(target);
    pluginNames.add(name);
  }
  return plugins;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function merge(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const result = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const previous = result[key];
    result[key] = Array.isArray(previous) && Array.isArray(value) ? [...new Set([...previous, ...value])]
      : record(previous) && record(value) ? merge(previous, value) : value;
  }
  return result;
}

function absolutePattern(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
  return `/${normalized}`;
}

/** Preserve setting-relative permission/sandbox paths when relocating settings. */
function rebase(settings: Record<string, unknown>, base: string): void {
  const permissions = settings.permissions;
  if (record(permissions)) {
    for (const key of ["allow", "deny", "ask"]) {
      const rules = permissions[key];
      if (Array.isArray(rules)) permissions[key] = rules.map((rule: unknown) => typeof rule === "string"
        ? rule.replace(/^(Read|Edit|Write)\((!?)(\/[^/].*)\)$/, (_, tool: string, negate: string, pattern: string) =>
          `${tool}(${negate}${absolutePattern(path.join(base, pattern.slice(1)))})`) : rule);
    }
    if (Array.isArray(permissions.additionalDirectories)) permissions.additionalDirectories = permissions.additionalDirectories.map((entry: string) => path.resolve(base, entry));
  }
  const sandbox = settings.sandbox;
  if (!record(sandbox)) return;
  const resolvePath = (entry: string) => entry.startsWith("~") || path.isAbsolute(entry) ? entry : path.resolve(base, entry);
  if (record(sandbox.filesystem)) for (const key of ["allowRead", "denyRead", "allowWrite", "denyWrite"]) {
    const paths = sandbox.filesystem[key];
    if (Array.isArray(paths)) sandbox.filesystem[key] = paths.map(resolvePath);
  }
  if (record(sandbox.credentials) && Array.isArray(sandbox.credentials.files)) {
    sandbox.credentials.files = sandbox.credentials.files.map((entry: unknown) => record(entry) && typeof entry.path === "string" ? { ...entry, path: resolvePath(entry.path) } : entry);
  }
}

/** A launch-only snapshot of operational settings; never a memory/profile store. */
export function claudeIsolation(workspace: string, supplied: NodeJS.ProcessEnv | undefined): {
  settings: Record<string, unknown>; env: NodeJS.ProcessEnv; pluginIds: string[];
} {
  const inherited = { ...process.env, ...supplied };
  const config = inherited.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  // Managed hooks cannot be disabled without overriding administrator policy.
  // This driver deliberately supports unmanaged hosts; do not silently bypass it.
  const managedRoots = process.platform === "win32"
    ? [inherited.ProgramFiles, inherited["ProgramFiles(x86)"], inherited.ProgramData].filter((value): value is string => Boolean(value)).map((root) => path.join(root, "ClaudeCode"))
    : [process.platform === "darwin" ? "/Library/Application Support/ClaudeCode" : "/etc/claude-code"];
  if ([...managedRoots, config].some((root) => existsSync(path.join(root, "managed-settings.json")) || existsSync(path.join(root, "managed-settings.d")))) {
    throw new Error("Managed Claude settings require a separate isolation integration; this driver cannot attest their hooks");
  }
  let settings: Record<string, unknown> = {};
  let enabledPlugins: Record<string, unknown> = {};
  const operational = new Set(["env", "permissions", "sandbox", "model", "availableModels", "apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh"]);
  for (const [file, base] of [
    [path.join(config, "settings.json"), config],
    [path.join(workspace, ".claude/settings.json"), workspace],
    [path.join(workspace, ".claude/settings.local.json"), workspace],
  ] as const) {
    if (!existsSync(file)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(file, "utf8")); }
    catch { throw new Error("Claude operational settings are invalid JSON"); }
    if (!record(parsed)) throw new Error("Claude operational settings must be an object");
    if (record(parsed.enabledPlugins)) enabledPlugins = merge(enabledPlugins, parsed.enabledPlugins);
    const selected = Object.fromEntries(Object.entries(parsed).filter(([key]) => operational.has(key)));
    rebase(selected, base);
    settings = merge(settings, selected);
  }
  const env = { ...inherited };
  // Credential/model environment stays in the child environment, not temp files.
  if (record(settings.env)) for (const [key, value] of Object.entries(settings.env)) {
    if (typeof value === "string") env[key] = value;
  }
  Object.assign(env, supplied);
  delete settings.env;
  if (env.CLAUDE_CODE_SIMPLE === "1" || env.CLAUDE_CODE_SAFE_MODE === "1") {
    throw new Error("Claude bare/safe mode disables the adapter lifecycle hooks");
  }
  Object.assign(env, {
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_AGENT_VIEW: "1", CLAUDE_CODE_DISABLE_BG_EXIT_HANDOFF: "1",
    CLAUDE_CODE_DISABLE_CRON: "1", CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND: "1",
    CLAUDE_CODE_DISABLE_WORKFLOWS: "1", CLAUDE_CODE_DISABLE_WINDOWS_SHELL_LAUNCHER: "1",
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0",
  });
  return { settings: { ...settings, autoMemoryEnabled: false }, env,
    pluginIds: Object.entries(enabledPlugins).filter(([, enabled]) => enabled === true).map(([id]) => id) };
}
