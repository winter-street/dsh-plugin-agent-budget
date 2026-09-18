# Design: durable agent-tree token budget

## Problem

A DeepSeek Harness session tree can contain a root agent, one-shot subagents,
continuable subagents, and workflow descendants. Without a shared budget, each
subtree can spend independently, making total token consumption hard to control.

This plugin provides one shared, durable token budget for the whole agent tree.
It is not a billing system: it is a fail-closed admission gate plus a replayable
usage ledger.

## Scope

- `scope: tree` (default): a whole agent tree shares one budget.
- `scope: session`: every session is an independent budget account.
- Every `llm/stream` call with a `sessionId` is included: conversation,
  subagent, workflow, compaction, and title-generation calls.
- Calls without a `sessionId` are outside any agent tree and are not metered.

## Scope resolution

The plugin does not infer the tree root solely from live session headers.
Resolution order:

1. DSH runtime agent ownership (`ctx.agents`): walk the live creator-owner
   chain to the top-level agent.
2. A persisted `scope-index.json` entry for `sessionId`, if present.
3. Durable `parentSession` lineage when the parent is live in `ctx.sessions`.
4. Fallback: treat the session as its own budget scope and log a warning.

The fallback intentionally under-shares. A wrong shared root is much more
dangerous than a temporarily independent budget: it can lock unrelated chats
together.

## Ledger storage

The budget is stored in a plugin-owned sidecar, not in session logs:

```text
~/.dsh/agent-budget/
  ledger.jsonl         append-only ledger
  scope-index.json     sessionId -> scopeKey
```

Ledger lines:

- `open`
  - version, scopeKey, epochId, limitTokens
  - Created once per scope. The limit is fixed at this point; later plugin
    reloads cannot change it.
- `sample`
  - version, scopeKey, callId, sessionId, provider, model, purpose, and four
    usage buckets.
- `unmetered`
  - version, scopeKey, callId, sessionId, provider, model, purpose.
- `start` / `end`
  - version, scopeKey, callId. Persisted before dispatch and after settlement.
  - Unfinished calls recovered at startup count as unmetered. Live concurrent
    calls are excluded from this recovery rule.
- `adjust` / `reset`
  - Override a limit or clear settled and unknown usage. Reset is rejected
    while a call is active in that scope.

The ledger is folded deterministically from the append-only file, so in-memory
state can be rebuilt after a reload.

The runtime and migration share an exclusive `writer.lock`. Append failures
close admission until restart. Corrupt records and indexes fail startup rather
than dropping accounting. Replacement samples are validated against a copy of
the current totals before writing, including overflow across all buckets.
See [SECURITY.md](../SECURITY.md) for recovery and downgrade restrictions.

## Why not session-log events

DSH `0.1.0-rc.5` accepts merge-extended session events but does not expose the
event-envelope `ignorable` flag through `Session.append()`. Writing plugin
events into session logs makes sessions unreadable when the plugin is removed.
The sidecar avoids that trap entirely while preserving replayability.

Old logs that already contain `budget/*` events are migrated by
`scripts/migrate-session-log.mjs`.

## Accounting model

Usage is split into four disjoint buckets:

- `inputTokens` — uncached input
- `cacheReadTokens`
- `cacheWriteTokens`
- `outputTokens` — includes reasoning tokens; reasoning is not double-counted

The total is the sum of all buckets. A `sample` line replaces any previous
sample with the same `callId`; the state is always a fold of the ledger rather
than a mutable counter.

## Admission behavior

- Before provider dispatch, the plugin checks the settled budget.
- If the budget is already exhausted, the call fails with
  `TOKEN_BUDGET_EXHAUSTED` before any provider work starts.
- Calls that were admitted concurrently may finish above the limit. This is a
  deliberate trade-off: exact concurrency-safe reservation would require a
  different admission protocol and is outside the current scope.
- If `missingUsage` is `exhaust` (default), any unmetered call makes the budget
  fail closed. Set `missingUsage: 'ignore'` only when a provider intentionally
  omits usage and incomplete enforcement is acceptable.

## Tool surface

The plugin registers one read-only tool:

- `budget_status`
  - Returns limit, used, remaining, exhausted, usage buckets,
    `meteringComplete`, and `unmeteredCalls`.
  - Cannot change the budget.

The model can use this tool to self-regulate its remaining token budget.

## Settings panel and HTTP API

The plugin registers a `settings.section` web panel and an optional prefix HTTP route at
`/agent-budget/api`.

- `GET /scopes` returns every open budget scope with its current status.
- `POST /adjust-limit` appends an `adjust` line that overwrites the scope limit.
- `POST /reset` appends a `reset` line that clears usage but keeps the limit.

Both operations keep the ledger append-only. Replaying `ledger.jsonl` yields
the same state as incremental application.

The API admits loopback peers with a local Host only; checks Origin and Fetch
Metadata; and requires an explicit request header plus JSON content type for
mutations. It does not authenticate remote users. Bodies are bounded to 16 KiB.

The client keeps load errors separate from mutation errors, rejects invalid
numeric limits, synchronizes server updates, and ignores stale fetch results.

## Known limitations

- The `agent/request-error` handler requires both the budget error code and a
  recorded denial for the affected session. Producers should keep codes unique.
- `scope: tree` may fall back to independent budgets in extreme cold-start
  cases. This is intentional: under-sharing is safer than over-sharing.
- One `storageDir` supports one DSH process at a time. Concurrent `headless`
  and `web` processes must use distinct `storageDir` values or serialize access
  to the ledger.
- Concurrent admission can overshoot the limit by design.
- Metering is fail-closed by default.
- Verified against DSH `0.1.0-rc.6`; when upgrading DSH, re-check the
  `llm/stream` hook signature, the `agent/request-error` payload shape, and the
  `ctx.agents` runtime ownership API.
