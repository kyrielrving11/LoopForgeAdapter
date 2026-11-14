# Contribution and release checks

Keep host lifecycle and transport changes separate from LoopForge semantics.
Use TypeScript, preserve user changes and keep LoopForge's typed protocol and
live submission guidance authoritative. Add a focused invariant test when a
boundary changes. Do not add an adapter memory/history store or infer
progress from transcripts. The only current runtime dependency is `node-pty`.

## Local validation

From the adapter root, run these sequentially. Each build cleans `dist`, so
parallel build/test/pack commands can delete one another's output.

```powershell
npm ci
npm test
$env:LOOPFORGE_CLI = 'C:\path\to\LoopForge\loopforge\dist\cli.js'
$env:CLAUDE_RUNTIME_E2E = '1'
npm run test:e2e
npm pack --dry-run --json
```

`npm test` runs deterministic unit tests. The E2E suite combines real
LoopForge MCP lifecycle tests with opt-in real Claude CLI tests against a
local scripted API endpoint. It requires neither a live provider key nor
paid model calls. Missing LoopForge or an unset Claude opt-in skips relevant
tests; skips are not acceptance passes. `npm run test:claude` runs just the
native Claude tests.

Native CLI reliability tests also require text-only turn termination and final
HTTP 400/401 failures to pause exactly once, return nonzero, and submit no
round. Only those test children set `CLAUDE_CODE_MAX_RETRIES=0`; production
preserves the user's retry policy. See the
[reliability diagnosis](./CLAUDE-RELIABILITY.zh-CN.md) for the separate live
model tool-error recovery experiment and its evidence limits.

The native suite checks exact multiline prompt delivery and verifies that a
corrupted startup prompt produces zero model requests. Missing/stale receipts,
tool gating and confirmed-exit fallback are covered by unit tests. These
checks also cover fixed source text in the first provider request after both
clear and restart, with previous dynamic tool results absent. Units verify
source changes force confirmed restart, deleted sources fail without a new
host, and invalid/oversized text is never silently truncated. These checks
do not measure task continuity or provider costs; see the separate
[long-task comparison plan](./LONG-RUN-EVALUATION.zh-CN.md).

The model-visible `SessionStart` context is a fixed projection. Verify that it
contains only the host boundary and excludes LoopForge handles, IDs, guidance,
round facts and changing boundary labels. The supervisor must retain the full
structured metadata needed for routing and exact submission forwarding.

`npm pack` runs `prepack` to build from a clean `dist`. The package allowlist
includes `dist/src/`, README, public documentation and LICENSE; source and
tests stay in GitHub. Check that no test output, keys, `.env`, Claude settings,
temporary workspaces, dependencies or exploratory files enter the archive.

## Before a GitHub upload

1. Check the [user guide](./USER-GUIDE.md) commands against `node dist/src/cli.js help`.
2. Verify documentation links, package/lock version and license metadata.
3. Review the actual file list and staged diff, including secrets and whitespace.
   Keep `package-lock.json`, source and tests. Ignore `node_modules/`, `dist/`
   and generated `.tgz` files.
4. Use an independent repository rooted at this adapter directory. Do not
   stage from a parent directory containing LoopForge or unrelated work.
5. Keep repository URLs accurate. Record the host,
   Node and LoopForge versions actually used for acceptance. Rerun native
   acceptance after changing supported host versions.

A GitHub upload and an npm publication are separate actions. These checks do
not publish either one. Before npm publication, confirm the package name is
available and validate a real packed archive installation in a temporary
environment. Never replace the user's global installation merely to test it.
