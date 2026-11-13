# Host integration and support boundary

The implemented host is local, unmanaged Claude Code through a real PTY.
The interfaces live in [contracts.ts](../src/host/contracts.ts); this document
does not define a second protocol or duplicate LoopForge field meanings.

## Capability checks

Automatic operation requires clean conversation creation, interactive
transport, round metadata delivery, hard stop, workspace continuity and
tool-result interception. The supervisor refuses to start if a required
capability is absent.

The Claude driver checks the installed CLI version, required flags, `node-pty`
and its compiled bridge/hook files. Version 2.1.323 is the tested baseline;
the probe accepts newer versions with the necessary flags. Flag presence
alone is not a certification of future Claude behavior: rerun the native
acceptance tests after upgrades.

| Mode | New model conversation | Claude process | Ordinary MCP connections |
| --- | --- | --- | --- |
| `restart` (default) | New native session | Replaced after confirmed exit | Relaunched with the host |
| `reuse` | Confirmed native `/clear` | Retained if clear succeeds | Retained if the host/server keeps them open |
| `reuse` fallback | New native session after confirmed exit | Replaced | Relaunched with the host |

The supervisor's LoopForge MCP process remains separate and alive during
ordinary invocation replacement in either mode. Reuse does not promise that
an external server will never disconnect or reset its internal state.
`providerCacheTelemetry` is false: no provider cache metric is collected.

## Launch settings

The driver uses `--setting-sources ""`, `--strict-mcp-config` and generated
launch settings with its own lifecycle hooks. It reads only these operational
keys from user, workspace and local settings: `env`, `permissions`, `sandbox`,
`model`, `availableModels`, `apiKeyHelper`, `awsAuthRefresh`,
`awsCredentialExport` and `gcpAuthRefresh`. Setting-relative permission and
sandbox paths are rebased. Environment settings go to the child environment,
not the generated settings file. Supplied driver environment overrides them.

User/project settings hooks, output styles and original plugin runtime code
are not imported. Auto-memory, background tasks/subagents, Agent View, cron,
workflows, experimental agent teams, asynchronous MCP task handoff and
Windows shell handoff are disabled. `Monitor` and `CronCreate` are disallowed.
Foreground subagents remain available under the execution boundary.

The original settings and skill files are never rewritten. The launch
snapshot can still contain operational helper commands and an explicit MCP
configuration can contain credentials; treat local temporary files according
to their actual contents. No secrets belong in committed examples.

Detected `managed-settings.json` or `managed-settings.d` causes rejection.
Registry, MDM and server-delivered policies have not been certified. Managed
environments require a separate integration and are outside this release's
supported scope. Bare/safe mode is rejected because it disables lifecycle
hooks. The adapter does not bypass administrator policy.

## Skills and MCP

- User skill directories under the Claude config directory and immediate
  workspace `.claude/skills` directories containing `SKILL.md` are linked
  into a temporary `loopforge-static` plugin. Workspace names override user
  names. Calls use `loopforge-static:<skill-name>`.
- Enabled plugin IDs from settings are looked up in the conventional
  `plugins/cache/<marketplace>/<plugin>/<version>/skills` tree. Only skill
  directories are linked; calls preserve `<plugin>:<skill-name>`. Cache
  versions are selected by reverse string order among directories with a
  manifest, not by the installed-plugin registry or semantic version rules.
- Only simple directory names are exposed; `synced` and `anthropic-skills`
  are excluded from the ordinary skill roots. Ancestor/nested skill discovery,
  custom agent definitions and arbitrary plugin locations are not reproduced.
- Skills remain original source files, including their supporting files and
  frontmatter. Explicit skill invocation is Agent action; a skill's own
  instructions or behavior are not sanitized by this adapter. Do not describe
  this as disabling every possible skill-level hook.
- Ordinary MCP servers must be supplied through `--mcp-config`. User/global,
  project and original plugin MCP registrations are not automatically loaded.
  The private server name `loopforge-adapter` is reserved and replaces any
  entry of that name in the generated copy. Use absolute executable/script
  paths where needed; the input configuration file is not edited.

The available skill catalog and tool services can remain accessible across
fresh invocations. Expanded skill text, previous tool outputs and implicit
model habits are not carried into the next conversation by the adapter.

## Limits and validation

Clean context means a new model conversation. Static host instructions such
as `CLAUDE.md`, installed skills and workspace files may still be available.
The agent can deliberately read old files, and an MCP server may return its
own memory. The adapter neither scans these for meaning nor treats them as
LoopForge's committed round facts. Arbitrary shell detachment and remote work
cannot be contained solely by these hooks.

Provider KV/prefix caches are controlled by the provider and Claude. Process
reuse is neither evidence of a cache hit nor a guarantee of token savings.
The adapter does not depend on those caches for clean-session correctness.

The recorded native validation environment is Windows, Node.js 24.16.0 and
Claude Code 2.1.323, with a local scripted Anthropic-compatible endpoint.
The runtime declares Node.js >=18. Linux/macOS and other Node/CLI versions
need their own acceptance run; they are not certified by this Windows run.

On Windows, `node-pty` may print an `AttachConsole failed` helper warning
during teardown. It has occurred with successful tests and confirmed host
exit. An actual missing exit confirmation remains a failure, even if a
similar warning appears.
