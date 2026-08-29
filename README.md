# dsh-plugin-agent-budget

Shared token budgets for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
agent trees. A root agent, its one-shot and continuable subagents, and workflow
descendants spend from one durable budget.

> **Status**: experimental, verified against DSH `0.1.0-rc.5`. The package is
> not published to npm yet; it is developed as an open-source contribution to
> the DSH plugin ecosystem.

## Why another budget plugin?

When this plugin was designed, the DSH ecosystem did not have a small,
self-contained token-budget plugin that:

- treats a whole **agent tree** as one budget account;
- persists the budget ledger **inside the session log**, so it survives reloads
  and can be replayed;
- gives the model itself a read-only `budget_status` tool, not just a human
  command;
- has **no UI or external service** dependency and can be installed as a plain
  bundle.

The ecosystem now contains several other budget/cost plugins. This project
intentionally stays lightweight: it focuses on durable, replayable, fail-closed
token accounting for agent trees, leaving cost panels, carbon estimation, and
per-turn limits to more specialized plugins.

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
```

`maxTokens` is required and must be a positive safe integer. `missingUsage`
defaults to `exhaust`; set it to `ignore` only when a provider intentionally
omits usage and you accept incomplete enforcement.

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

## Semantics

- Only `origin: subagent` ancestry shares a budget. Ordinary sessions and
  ordinary forks have independent ledgers.
- Every `llm/stream` call with a `sessionId` is included: conversation,
  subagent, workflow, compaction, and title-generation calls.
- Uncached input, cache reads, cache writes, and output are disjoint buckets.
  Reasoning tokens are already part of output and are not added again.
- The limit is captured by the root session's first `budget/open` event. A
  later plugin reload does not mutate an existing budget.
- Calls admitted concurrently may finish above the limit. Once settled usage
  reaches the limit, later calls fail before provider dispatch with
  `TOKEN_BUDGET_EXHAUSTED`.
- Calls without a `sessionId` are outside any agent tree and are not metered.

## Persistence compatibility

DSH `0.1.0-rc.5` accepts merge-extended session events but does not yet expose
the event-envelope `ignorable` flag through `Session.append()`. This plugin
registers its three event types in the runtime's exported known-event set so
resume works when the plugin is loaded. Load the plugin before opening sessions
that contain its ledger. A DSH reader without this plugin will reject those
sessions rather than silently discard budget state. This compatibility bridge
can be removed when DSH exposes first-class custom event registration or an
ignorable append option.

## Known Limitations

- The `agent/request-error` handler matches `failure.code === 'TOKEN_BUDGET_EXHAUSTED'`
  globally and swallows any error carrying that code. Today only this plugin
  produces it; if another plugin ever reuses the code, this boundary needs to
  be tightened.
- Load the plugin before opening sessions that contain budget ledger events,
  otherwise a DSH reader without it will reject those sessions.
- Verified against DSH `0.1.0-rc.5`. When upgrading DSH, re-check: session
  event registration, the `llm/stream` hook signature, and the
  `agent/request-error` payload shape.
- Concurrent admission can overshoot the limit by design (see Semantics).
- Metering is fail-closed by default: providers that intentionally omit usage
  need `missingUsage: 'ignore'`.

## Related projects

- [vibeinging/dsh-agent-budget](https://github.com/vibeinging/dsh-agent-budget) —
  native agent-tree token budget with concurrency-safe reservations and
  `/budget` command.
- [PerryLink/dsh-budget](https://github.com/PerryLink/dsh-budget) — broader cost
  governance: USD/carbon/latency metering, budget caps, alerts, and a Settings
  panel.
- [dsh-token-budget](https://www.npmjs.com/package/dsh-token-budget) — cumulative
  token usage, cache-hit rate, and per-model/per-period cost estimates.
- [dsh-turn-budget](https://www.npmjs.com/package/dsh-turn-budget) — per-turn
  step/tool-call/provider-token budgets.

This project differentiates itself by keeping the scope narrow: **durable
agent-tree token budget with a model-visible status tool, no UI required.**

## Repository layout

```text
src/index.ts            plugin implementation
tests/                  unit + integration tests (deterministic mock streams)
cordis.patch.yml        default bundle layer for dsh plugin profiles
scripts/                lint, test, and pack verification helpers
docs/design.md          design decisions and compatibility notes
.github/workflows/ci.yml CI on Node.js 22 and 24
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
