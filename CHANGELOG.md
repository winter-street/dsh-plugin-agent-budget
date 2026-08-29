# Changelog

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
