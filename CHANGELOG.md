# Changelog

## [0.3.0] - 2026-09-18

### Security

- Restrict administration to loopback peers and local Host headers; reject
  cross-origin requests and require an explicit header for JSON mutations.
- Limit API bodies to 16 KiB and prevent internal error disclosure.
- Reject corrupt ledgers/indexes and invalid or overflowing token usage.
- Hold an exclusive writer lock shared by runtime and migration; persist
  call boundaries so interrupted processes cannot silently forget usage.
- Update Vitest and vulnerable transitive development dependencies.

### Fixed

- Meter cancelled and failed streams, including invalid usage after a sample.
- Reject reset while calls are active and recheck admission on delayed iteration.
- Keep the writer lock until active calls finish after plugin disposal.
- Persist migration output before removing legacy events, replace files
  atomically, validate legacy events, and deduplicate retries.
- Load in headless compositions through optional web-server injection.
- Preserve settings action errors, synchronize limits, validate inputs,
  guard stale refreshes, and confirm resets.
- Verify the client bundle in package checks and use a frozen lockfile in CI.

### Compatibility

- DSH peer requirements now match the tested `0.1.0-rc.6` runtime.
- New `start`/`end` ledger records require 0.3.0 or later. Back up the sidecar
  before upgrading; do not downgrade a ledger written by 0.3.0.
- The HTTP API is local-only. See SECURITY.md for access and recovery details.

## [0.2.0] - 2026-08-18

### Changed

- Ledger moved from session-log events to a plugin-owned sidecar
  (`~/.dsh/agent-budget/ledger.jsonl`). New writes never touch session logs, so
  uninstalling the plugin no longer makes sessions unreadable.
- Scope resolution now prefers DSH runtime agent ownership and falls back to a
  per-session budget when a tree root cannot be resolved safely.
- Added `scope: session | tree` configuration (default `tree`).
- Runtime ownership lookup is cached and invalidated on `agent/created` /
  `agent/disposed`, avoiding O(n²) rebuilds per `llm/stream` call.
- `inject` now includes `agents`, so a missing Agent Registry fails loudly at
  load instead of silently degrading scope resolution.
- Migration script writes zstd logs back as header-frame + event-frame and
  omits the event frame when no events remain, matching DSH startup
  requirements.

### Added

- `scripts/migrate-session-log.mjs` migrates legacy `budget/*` session events
  into the sidecar ledger and removes them from session logs.
- `tests/migrate-session-log.spec.ts` covers multi-frame zstd migration, empty
  event-frame handling, ledger/index output, and backup creation.
- README and design docs document the single-process `storageDir` limitation.
- Settings page panel (`settings.section`) with scope list, limit adjustment,
  and reset controls.
- Host HTTP API under `/agent-budget/api`: `GET /scopes`,
  `POST /adjust-limit`, and `POST /reset`.
- Ledger `adjust` and `reset` event lines with append-only replay semantics.
- `tests/budget-adjust.spec.ts` covers adjust/reset behavior, replay, and API
  error codes.

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
