# dsh-plugin-agent-budget

Shared token budgets for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
agent trees. A root agent, its one-shot and continuable subagents, and workflow
descendants can spend from one durable budget.

> **Status**: experimental, verified against DSH `0.1.0-rc.5`. The package is
> not published to npm yet; it is developed as an open-source contribution to
> the DSH plugin ecosystem.

## Highlights

- treats a whole **agent tree** as one budget account (`scope: tree`), or each
  session independently (`scope: session`);
- stores the ledger in a **plugin-owned sidecar** under `~/.dsh/agent-budget/`,
  never in session logs, so uninstalling the plugin cannot break sessions;
- keeps the ledger append-only, replayable, and recoverable;
- gives the model itself a read-only `budget_status` tool, not just a human
  command;
- ships a **settings page panel** to list scopes, adjust limits, and reset
  usage without touching ledger files by hand;
- has **no external service** dependency and can be installed as a plain
  bundle;
- keeps a narrow scope: durable, replayable, fail-closed token accounting for
  agent trees.

## Install

> The package is not published to npm yet. The commands below assume the
> package is available in your profile workspace (for example via a local
> checkout with `dsh plugin --profile <name> add -w .`, or from a GitHub
> bundle once this repository is public).

Install as a bundle into a profile (recommended after publishing):

```bash
dsh plugin --profile <name> add dsh-plugin-agent-budget
```

Or install directly with npm/pnpm:

```bash
pnpm add dsh-plugin-agent-budget
```

For git installs, the package builds during install via its `prepare` script.
pnpm ≥10 blocks build scripts for git dependencies by default, so the first
`add` fails; add the exact package key pnpm printed to the profile's
`pnpm-workspace.yaml` and re-run:

```yaml
allowBuilds:
  dsh-plugin-agent-budget: true
```

The package declares `dsh.bundle`, so `dsh plugin` adds it to the profile's
`dsh.profile.bundles` automatically and `--dump-config` shows the
`# == dsh-plugin-agent-budget` layer. The layer is provided by the root
`cordis.patch.yml`:

```yaml
- insert:
    - id: agent-budget
      name: dsh-plugin-agent-budget
      config:
        maxTokens: 200000
        missingUsage: exhaust
        scope: tree
```

`maxTokens` is required and must be a positive safe integer. `missingUsage`
defaults to `exhaust`; set it to `ignore` only when a provider intentionally
omits usage and you accept incomplete enforcement. `scope` defaults to `tree`;
set it to `session` for one independent budget per session. `storageDir` is
optional and defaults to `~/.dsh/agent-budget/`.

## Export shape

The plugin exports four named members and **no default export**:

- `name: 'agent-budget'`
- `inject: ['llm', 'sessions', 'tools']`
- `apply(ctx, config)` — the function-plugin entry point
- `Config` — the loader-facing config schema

## Model Experience

The model can call the read-only `budget_status` tool. It returns the limit,
used and remaining tokens, exhaustion state, all four usage buckets,
`meteringComplete`, and `unmeteredCalls`. It cannot change the limit.

## Settings panel and HTTP API

The web client registers a `Token 预算` section in Settings. It lists every
open budget scope, shows limit/used/remaining/exhausted state with a progress
bar, and polls every 30 seconds.

Host HTTP API under `/agent-budget/api`:

- `GET /scopes` → `{ ok, scopes: [{ scopeKey, limitTokens, usedTokens, ... }] }`
- `POST /adjust-limit` with `{ scopeKey, limitTokens }` → overwrites the scope's
  limit
- `POST /reset` with `{ scopeKey }` → clears usage but keeps the current limit

`adjust` and `reset` are appended to the sidecar ledger as new event lines.
Old `open`/`sample` lines are never modified, so replaying the ledger after a
reload produces the same result as incremental updates.

## Semantics

- With `scope: tree` (default), the plugin resolves the tree root using DSH's
  **runtime agent ownership** first, falls back to the durable `parentSession`
  chain, and finally falls back to an independent budget with a warning when
  neither is available. It never merges unrelated sessions into one account.
- With `scope: session`, every session has an independent budget, including
  subagents.
- Every `llm/stream` call with a `sessionId` is included: conversation,
  subagent, workflow, compaction, and title-generation calls.
- Uncached input, cache reads, cache writes, and output are disjoint buckets.
  Reasoning tokens are already part of output and are not added again.
- The limit is captured by a scope's first open ledger record. A later plugin
  reload does not mutate an existing budget.
- Calls admitted concurrently may finish above the limit. Once settled usage
  reaches the limit, later calls fail before provider dispatch with
  `TOKEN_BUDGET_EXHAUSTED`.
- Calls without a `sessionId` are outside any agent tree and are not metered.

## Storage and uninstall

The plugin stores its ledger in:

```text
~/.dsh/agent-budget/
  ledger.jsonl         append-only ledger (open/sample/unmetered)
  scope-index.json     sessionId -> scopeKey index
```

- New versions **never write `budget/*` events into session logs**.
- After uninstalling the plugin, DSH can open every session normally.
- To fully remove budget data, delete `~/.dsh/agent-budget/`.
- One `storageDir` is intended for one DSH process at a time. If `headless`
  and `web` run concurrently, give each profile a distinct `storageDir` or do
  not run them against the same ledger simultaneously.

## Migrating legacy session logs

Versions before this sidecar design wrote `budget/*` events into session logs.
Run the migration once before upgrading a profile that used those versions.
Migrate them with:

```bash
node scripts/migrate-session-log.mjs
```

The migration tool:

1. scans `~/.dsh/sessions/**/session.jsonl(.zstd)`;
2. converts `budget/*` events into `ledger.jsonl` and `scope-index.json`;
3. removes those events from each session log;
4. creates a `.bak` backup before writing.

Stop DSH processes that use the affected profile before running it.

## Known Limitations

- The `agent/request-error` handler matches `failure.code === 'TOKEN_BUDGET_EXHAUSTED'`
  globally and swallows any error carrying that code. Today only this plugin
  produces it; if another plugin ever reuses the code, this boundary needs to
  be tightened.
- `scope: tree` may fall back to an independent budget in extreme cold-start
  cases when no parent can be resolved. This prefers under-sharing over
  incorrectly locking unrelated chats together.
- Verified against DSH `0.1.0-rc.5`. When upgrading DSH, re-check: the
  `llm/stream` hook signature, the `agent/request-error` payload shape, and the
  `ctx.agents` runtime ownership API.
- Concurrent admission can overshoot the limit by design (see Semantics).
- Metering is fail-closed by default: providers that intentionally omit usage
  need `missingUsage: 'ignore'`.

## Repository layout

```text
src/index.ts                    plugin implementation
tests/                          unit + integration tests (deterministic mock streams)
cordis.patch.yml                default bundle layer for dsh plugin profiles
scripts/                        lint, test, pack verification, legacy migration
docs/design.md                  design decisions and compatibility notes
.github/workflows/ci.yml        CI on Node.js 22 and 24
```

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Development

```bash
pnpm install
pnpm check
```

The test suite uses a deterministic mock stream. `pnpm test:smoke` additionally
runs a small real DeepSeek request when `DEEPSEEK_API_KEY` is present and skips
otherwise. CI covers Node.js 22 and 24.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## License

MIT
