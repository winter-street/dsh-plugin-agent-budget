# Changelog

## [Unreleased]

### Changed

- Ledger moved from session-log events to a plugin-owned sidecar
  (`~/.dsh/agent-budget/ledger.jsonl`). New writes never touch session logs, so
  uninstalling the plugin no longer makes sessions unreadable.
- Scope resolution now prefers DSH runtime agent ownership and falls back to a
  per-session budget when a tree root cannot be resolved safely.
- Added `scope: session | tree` configuration (default `tree`).

### Added

- `scripts/migrate-session-log.mjs` migrates legacy `budget/*` session events
  into the sidecar ledger and removes them from session logs.

## [0.1.0] - 2026-08-17

### Added

- Shared token budget for DSH agent trees (`origin: subagent` ancestry).
- Durable, replayable ledger via `budget/open`, `budget/sample`, and
  `budget/unmetered` session events.
- Four disjoint usage buckets: uncached input, cache read, cache write, output.
- Fail-closed admission with `TOKEN_BUDGET_EXHAUSTED` before provider dispatch.
- Read-only model tool `budget_status`.
- Deterministic mock-stream tests plus an optional real DeepSeek smoke test.
- MIT license, CI for Node.js 22 and 24, pack verification.
