# LoopForge Adapter user guide

The adapter wraps local Claude Code and enforces the invocation boundary
returned by LoopForge. LoopForge owns durable facts and current round input;
the agent owns judgment and actions. The adapter owns lifecycle and transport,
without a learned profile or independent history store.

## Prerequisites and installation

Use Node.js >=18, an interactive terminal, a complete local Claude Code
>=2.1.323 installation and a separately installed or built LoopForge runtime.
The recorded native acceptance baseline is Windows, Node.js 24.16.0, Claude
Code 2.1.323 and LoopForge 4.0.7. Other LoopForge releases, host versions and
Linux/macOS require their own native acceptance run. Version checks alone do
not certify future releases.

Run `claude` directly in the target workspace first to complete authentication,
provider setup and trust. Provider environment is inherited. DeepSeek users
should follow its [official integration guide](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code).
The adapter does not load `.env` automatically or maintain a provider-key
store. Keep real credentials out of committed examples and MCP files.

Clone the repository, then enter the adapter checkout:

```powershell
git clone https://github.com/kyrielrving11/LoopForgeAdapter.git
cd LoopForgeAdapter
npm ci
npm test
node dist/src/cli.js help
```

Tests build first; `npm run build` builds without running tests. The build
cleans old `dist` output. If npm blocks dependency install scripts, allow
`node-pty` installation under your local npm policy. Its native PTY component
must be available. Windows uses ConPTY.

After building, optionally run `npm install -g .` to install the
`loopforge-adapter` command. Without global installation, use
`node dist/src/cli.js` from this checkout instead. This guide does not assume
that the adapter has been published on npm.

## Start, pause and resume

When LoopForge is installed:

```powershell
loopforge-adapter start --workspace "C:\work\my-project" --task "Implement the requested change" --claude-runtime reuse
```

For a separate LoopForge source checkout, supply its built entrypoint:

```powershell
loopforge-adapter start --workspace "C:\work\my-project" --loopforge-cli "C:\work\LoopForge\loopforge\dist\cli.js" --task "Implement the requested change" --claude-runtime reuse
```

The workspace must exist. It is used by both Claude and LoopForge MCP and is
preserved across context changes. The agent submits its own round evaluation;
field meaning comes from LoopForge's live schemas, prompt and
`submission_guidance`, not an adapter copy.

The prompt and live MCP schemas are the model's authority for round facts.
Structured LoopForge metadata stays in the adapter's volatile routing path;
the model receives a fixed host note that contains no round IDs, submission
handles, guidance or dynamic boundary labels.

Record the printed `LoopForge loop: <id>`. Ctrl+C requests host shutdown and a
LoopForge pause; check the returned pause result. Resume in the same workspace:

A native `Stop` or `StopFailure` means a Claude turn ended, not that the
LoopForge round completed. If the round remains open, an interactive terminal
shows a diagnostic and lets you continue. Without an interactive terminal,
the CLI stops the host, requests a LoopForge pause and returns exit code 1.
It never invents a continuation, submission or round advance. Claude still
owns API retry timing; `StopFailure` arrives after those retries end.

```powershell
loopforge-adapter resume --workspace "C:\work\my-project" --loop-id loop-... --claude-runtime reuse
```

Supply the same `--loopforge-cli`, `--mcp-config` and `--capability-file` options again if required.
The CLI defaults to `invocationLost: true`, letting LoopForge reconstruct
the current invocation. It does not resume a Claude transcript or need an
adapter state file. After an abrupt exit, LoopForge still decides lease and
recovery eligibility; do not edit its Vault to bypass those checks.

## Choose a runtime mode

| Mode | Behavior |
| --- | --- |
| `restart` (default) | Confirm old host exit, then start a new Claude process and session |
| `reuse` | Confirm native `/clear` through old-session end and new-session start hooks; keep the host and ordinary MCP connections |

A failed clear falls back to restart only after confirmed exit. Missing exit
confirmation blocks further delivery. An external MCP server can still
disconnect or reset itself; reuse does not guarantee its availability.

Both modes also wait for the current session's `UserPromptSubmit` hook to
confirm the exact prompt digest before declaring readiness or permitting
tools. Whitespace and newlines are not normalized. A missing or different
receipt fails closed; reuse can fall back to a confirmed host restart. The
digest is volatile and never becomes LoopForge history. This checks input
observed by the hook, not provider receipt or model understanding.

`same_round_retry` is delivered inside the current conversation.
`fresh_invocation` creates a new one, which may still represent the same
logical round. LoopForge decides these boundaries. Host reuse preserves
services and skill availability, not prior dialogue, tool outputs, expanded
skill bodies, implicit habits or guaranteed provider KV/prefix cache hits.
Explicitly selected reference text can be supplied separately as described below.

## Fixed capability references

For a small set of skill/tool instructions needed throughout a run, explicitly
select the original UTF-8 documents. This is optional and disabled by default:

```powershell
loopforge-adapter start --workspace "C:\work\my-project" --task "Implement the requested change" --claude-runtime reuse --capability-file "C:\skills\review\SKILL.md" --capability-file "C:\tools\usage.md"
```

`--capability-file` is repeatable and works with start, resume and exact JSON
input. Relative paths resolve from the adapter launch directory, not from
`--workspace`. Documents retain their input order; paths resolving to the same
source are included once. Choose static capability instructions, not previous
task reports, tool outputs or a competing task plan. Unselected skills remain
available through ordinary native skill loading.

The adapter validates nonempty UTF-8 text and supplies the full original text,
source paths and content hashes through Claude's native
[`--append-system-prompt-file`](https://code.claude.com/docs/en/cli-reference).
The complete rendered background, including labels, must fit within 64 KiB;
invalid, missing or oversized sources fail instead of being skipped or
truncated. A temporary derived file is removed after confirmed shutdown;
the originals are never modified and there is no adapter memory store.

At each `fresh_invocation`, the adapter rereads source fingerprints. Unchanged
sources permit ordinary `/clear` reuse. A changed or unreadable source requires
confirmed old-host exit; a new host captures the current originals. If sources
remain invalid, no next invocation starts. Edits do not alter an invocation
already in progress or cause the adapter to invent a round boundary.

Native acceptance checks both modes: the first model request after a fresh
boundary already contains the selected full text, while previous prompt,
dynamic LoopForge metadata and dynamic tool results are absent. The controlled fixture needs
no Skill/Read call to recover those references. A real model may still choose
to read them. Preloading a `SKILL.md` is reference access, not native skill
activation: permissions, hooks, supporting files and explicit invocations
still follow Claude's live interfaces. Relative references inside a document
are not rewritten, and live MCP/tool schemas remain authoritative.

The reference still occupies model context on every fresh conversation. A
stable background does not prove a provider cache hit, retained understanding,
token savings or better task performance. These need separate measurements;
the adapter does not preserve previous dialogue or learn implicit habits.

## Ordinary MCP servers

Pass an explicit Claude MCP file with `--mcp-config`. For example, replace
the server path below with a real MCP entrypoint:

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "node",
      "args": ["C:/tools/my-mcp-server/dist/index.js"]
    }
  }
}
```

```powershell
loopforge-adapter start --workspace "C:\work\my-project" --task "Implement the requested change" --mcp-config "C:\work\mcp.json" --claude-runtime reuse
```

The adapter adds its private LoopForge bridge to a temporary copy. It does
not edit the original or require separate LoopForge registration in Claude.
The name `loopforge-adapter` is reserved. Existing user/project/plugin MCP
registrations are not imported automatically. Relative script paths are not
rebased; use absolute paths where needed.

## Skills, settings and scope

Immediate skill directories under the user Claude config and workspace
`.claude/skills` roots are linked as `loopforge-static:<skill-name>`.
Workspace names take precedence. Enabled plugin skills in the conventional
local cache retain `<plugin>:<skill-name>` names. The original plugin's
top-level hooks, MCP servers, custom agents and runtime code are not activated.
The agent still chooses which skills to invoke.

Plugin discovery uses the conventional cache layout and reverse string order
of cached version directories, not the installed-plugin registry. It does
not reproduce ancestor/nested skill discovery, arbitrary plugin locations or
custom agents. Original skill frontmatter and supporting files remain
available; explicit skill behavior is not sanitized.

Only operational environment, model, permission, sandbox and credential-helper
settings are imported. Source settings hooks, auto-memory and output styles
are excluded. Background tasks, cron and workflows are disabled. Foreground
tools and subagents must finish before submission; child Agents cannot call
LoopForge governance tools.

Clean context is a new conversation, not an empty workspace or OS sandbox.
Static `CLAUDE.md`, skills and files can remain available. Deliberate reads of
old files, external services' own memories, detached processes and remote
jobs fall outside this guarantee. Detected managed settings are rejected;
other enterprise policies are not certified. See the complete
[host integration boundary](./HOST-INTEGRATION.md).

## CLI reference

Use `loopforge-adapter help` or root `--help`. `start --help` is not supported.

| Flag | Purpose |
| --- | --- |
| `--workspace DIR` | Target workspace; defaults to cwd |
| `--claude-runtime restart\|reuse` | Host mode; defaults to restart |
| `--mcp-config FILE` | Explicit ordinary MCP configuration |
| `--capability-file FILE` | Repeatable original UTF-8 capability references; 64 KiB total rendered limit |
| `--loopforge-cli FILE` | Built LoopForge `dist/cli.js` entrypoint |
| `--loopforge-command COMMAND`, `--loopforge-arg ARG` | Custom command and repeatable prefix arguments; use instead of the CLI entrypoint option |
| `--input-json JSON`, `--input-file FILE` | Exact start/resume object; choose one |
| `--task TEXT` | Convenience start input |
| `--loop-id ID` | Convenience start/resume input |
| `--max-rounds N`, `--plan-source FILE` | Convenience start input |
| `--constraint TEXT`, `--criterion TEXT` | Repeatable convenience start inputs |
| `--invocation-lost`, `--current-user-instruction TEXT` | Convenience resume inputs |

Exact JSON input cannot be combined with convenience inputs. Host, workspace,
MCP and LoopForge process options remain available. For complex input, create
a JSON file such as `{"task":"Implement the requested change","maxRounds":5}`:

```powershell
loopforge-adapter start --workspace "C:\work\my-project" --input-file "C:\work\start.json"
```

## Verification and troubleshooting

Follow [contribution and release checks](./RELEASE-CHECKLIST.md) for unit,
real LoopForge MCP and opt-in native Claude acceptance tests. Native tests use
a local scripted API without live provider keys. They test the integration
boundary rather than the model's ability to complete a task.

`Automatic boundary mode is unavailable` means a required host capability is
missing. Check Claude version, complete installation, native PTY availability
and compiled adapter files. Use `--loopforge-cli` for `LoopForge was not found`.
Managed or bare/safe-mode errors require a supported environment, not ignored
diagnostics.

A session confirmation timeout or unconfirmed exit is a failure even if the
terminal looks cleared. Inspect host diagnostics, then recover through
LoopForge. On Windows, `node-pty` may print `AttachConsole failed` during
teardown; it has occurred with confirmed host exits and passing tests.
Missing exit confirmation still blocks continuation.

`Claude submitted prompt does not match` or a prompt delivery confirmation
timeout means the pending LoopForge input was not confirmed. Do not continue
in that session or manually trim the prompt to bypass it; use the supported
restart/recovery path. The same-round retry delivery remains ordinary MCP
tool-result forwarding and is not covered by the startup prompt receipt.
