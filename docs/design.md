# Design: durable agent-tree token budget

## Problem

A DeepSeek Harness session tree can contain a root agent, one-shot subagents,
continuable subagents, and workflow descendants. Without a shared budget, each
subtree can spend independently, making total token consumption hard to control.

This plugin provides one shared, durable token budget for the whole agent tree.
It is not a billing system: it is a fail-closed admission gate plus a replayable
usage ledger.

## Scope

- Only `origin: subagent` ancestry shares a budget.
- Ordinary sessions and ordinary forks have independent ledgers.
- Every `llm/stream` call with a `sessionId` is included: conversation,
  subagent, workflow, compaction, and title-generation calls.
- Calls without a `sessionId` are outside any agent tree and are not metered.

## Ledger events

The budget is stored as three custom session events on the root session:

- `budget/open`
  - version, rootSessionId, epochId, limitTokens
  - Created once, by the first metered call in a root session. The limit is
    fixed at this point; later plugin reloads cannot change it.
- `budget/sample`
  - version, rootSessionId, epochId, callId, sessionId, provider, model,
    purpose, and four usage buckets.
  - Appended when a stream emits a provider `usage` chunk.
- `budget/unmetered`
  - version, rootSessionId, epochId, callId, sessionId, provider, model,
    purpose.
  - Appended when a stream completes with meaningful output but no provider
    usage, or when usage cannot be validated.

The root session is resolved by walking parent links until a session with
`origin !== 'subagent'` is found. The ledger is folded deterministically from
the root session's event log, so the in-memory state can be rebuilt after a
reload.

## Accounting model

Usage is split into four disjoint buckets:

- `inputTokens` — uncached input
- `cacheReadTokens`
- `cacheWriteTokens`
- `outputTokens` — includes reasoning tokens; reasoning is not double-counted

The total is the sum of all buckets. A `budget/sample` event replaces any
previous sample with the same `callId`; the state is always a fold of the
event log rather than a mutable counter.

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

## DSH compatibility bridge

DSH `0.1.0-rc.5` accepts merge-extended session events but does not expose the
event-envelope `ignorable` flag through `Session.append()`. This plugin registers
its three event types in the runtime's exported known-event set so resume works
when the plugin is loaded.

**Important**: load the plugin before opening sessions that contain budget
ledger events. A DSH reader without this plugin will reject those sessions
rather than silently discard budget state.

When DSH exposes first-class custom event registration or an ignorable append
option, this compatibility bridge can be removed.

## Known limitations

- The `agent/request-error` handler matches
  `failure.code === 'TOKEN_BUDGET_EXHAUSTED'` globally and swallows any error
  carrying that code. Today only this plugin produces it; if another plugin
  reuses the code, the boundary must be tightened.
- Concurrent admission can overshoot the limit by design.
- Metering is fail-closed by default.
- Verified against DSH `0.1.0-rc.5`; when upgrading DSH, re-check session event
  registration, the `llm/stream` hook signature, and the
  `agent/request-error` payload shape.
