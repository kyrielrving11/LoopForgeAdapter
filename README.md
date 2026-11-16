# LoopForge Adapter

Run LoopForge through an existing coding agent with explicit clean-context
boundaries. **Claude Code is the currently implemented host.**

[中文用户说明书](./docs/USER-GUIDE.zh-CN.md) · [English user guide](./docs/USER-GUIDE.md)

LoopForge owns durable round facts, evidence, acceptance and recovery. The
agent owns semantic judgment and workspace actions. This independent adapter
owns host lifecycle and MCP transport; it does not learn a profile or create
a second history store.

## Quick start from source

Requirements: Node.js >=18, a working local Claude Code >=2.1.323 installation,
an interactive terminal and a separately installed/built LoopForge runtime.
The recorded native acceptance baseline is Windows with Node.js 24.16.0,
Claude Code 2.1.323 and a LoopForge 4.0.7 checkout. Other LoopForge releases
and platforms require their own validation.

Clone the repository, then install and build:

```powershell
git clone https://github.com/kyrielrving11/LoopForgeAdapter.git
cd LoopForgeAdapter
npm ci
npm run build
node dist/src/cli.js help
node dist/src/cli.js start --workspace "C:\path\to\project" --loopforge-cli "C:\path\to\LoopForge\loopforge\dist\cli.js" --task "Implement the requested change"
```

Run `claude` in the target workspace first to complete authentication, provider
setup and workspace trust. Provider environment variables are inherited. For
DeepSeek, use its [official Claude Code integration guide](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code).
The adapter does not automatically load `.env` files.

After building, `npm install -g .` makes `loopforge-adapter` available as a
command. This repository is prepared for source installation; it does not
assert that `loopforge-adapter` is published on npm.

## Context and runtime

| Mode | Fresh invocation | Host and ordinary MCP services |
| --- | --- | --- |
| `restart` (default) | New native Claude session | Restarted after confirmed host exit |
| `reuse` | Native `/clear` with confirmed old/new session events | Kept alive when clear succeeds |

Choose reuse with `--claude-runtime reuse`. A failed clear falls back to a
confirmed host restart. `same_round_retry` stays in the current invocation;
LoopForge alone decides when a fresh invocation is required.

Startup and replacement also wait for Claude's `UserPromptSubmit` hook to
confirm the exact prompt digest. Tools stay closed until confirmation; a
missing or mismatched receipt cannot silently complete delivery. The digest
is kept only in memory and does not enter LoopForge history.

The workspace and installed skill files remain available. Previous dialogue,
tool outputs and uncommitted reasoning are not replayed. Round facts come from
LoopForge's current prompt and live schemas. The adapter keeps structured
metadata for routing but exposes only a fixed host-boundary note to the model;
handles, IDs and dynamic round metadata are not replayed as memory. Host reuse
does not preserve implicit model habits or guarantee KV/prefix cache hits.

For selected static skill/tool documentation, repeat `--capability-file FILE`.
Claude receives the original text as fixed system background in each fresh
conversation. Sources stay authoritative; edited sources trigger a confirmed
host restart at the next fresh boundary, even in reuse mode. This optional
preload is limited to 64 KiB total, consumes context and does not activate a
skill or retain previous tool results. See the [capability guide](./docs/USER-GUIDE.md#fixed-capability-references).

Record the printed `LoopForge loop: <id>`. Press Ctrl+C to request a pause;
resume later with:

```powershell
loopforge-adapter resume --workspace "C:\path\to\project" --loop-id loop-... --claude-runtime reuse
```

Add `--loopforge-cli` again if LoopForge is not installed. Ordinary MCP servers
require an explicit `--mcp-config FILE`; the adapter supplies its own private
LoopForge bridge. User/project settings hooks, automatic memory and original
plugin runtime code are excluded. Static user, workspace and conventional
cached plugin skills are exposed through source links. Background execution
is restricted, and tools/subagents must finish before submission.

See the [user guide](./docs/USER-GUIDE.md) and
[host integration boundary](./docs/HOST-INTEGRATION.md) for exact settings,
skill discovery and containment limits. This is a local lifecycle boundary,
not an OS sandbox or a managed-enterprise integration.

## Development

```powershell
npm test
```

See [release checks](./docs/RELEASE-CHECKLIST.md) for the real LoopForge MCP
and opt-in native Claude acceptance tests. The native tests use a local
scripted API endpoint, without a live provider key.

- [Architecture and source map](./docs/ARCHITECTURE.md)
- [Host integration and support boundary](./docs/HOST-INTEGRATION.md)
- [Contribution and release checks](./docs/RELEASE-CHECKLIST.md)
- [Long-task comparison and results (Chinese)](./docs/LONG-RUN-EVALUATION.zh-CN.md)
- [Experimental evidence index (中文; historical runs, not current-version guarantees)](./docs/EXPERIMENTS.zh-CN.md)

MIT licensed; see [LICENSE](./LICENSE).
