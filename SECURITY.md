# Security and Recovery

## Trust Boundary

This plugin is a local admission gate, not a billing system or a sandbox for
agents with filesystem/shell access. Protect its storage directory with OS
permissions. Any process that can modify the ledger or plugin configuration
can change the budget. Do not share the directory across untrusted users.

The DSH route registry does not authenticate HTTP requests. Version 0.3.0
therefore restricts all budget API routes to loopback connections and local
Host headers (`localhost`, IPv4 loopback, or `[::1]`). Browser Origin must
match the request origin. Cross-site Fetch Metadata is rejected.

POST requests require both `Content-Type: application/json` and
`X-Agent-Budget-Request: 1`. Bodies are limited to 16 KiB, including chunked
requests. No CORS permissions are granted. Errors omit internal paths and
responses are not cacheable. The bundled settings client supplies the header.

Use a local browser or an SSH tunnel that keeps the browser URL on localhost.
Do not expose this route through a public reverse proxy: a proxy connection
may appear local. There is no remote-user authentication or authorization.

## Upgrade and Recovery

1. Stop the DSH process and back up the entire `agent-budget` directory.
2. Upgrade to 0.3.0. Existing valid sidecar records remain readable. New
   `start`/`end` records must not be opened with older plugin versions.
3. The `writer.lock` file prevents simultaneous runtime/migration writers.
   Normal disposal releases it after active calls finish. After a crash,
   inspect its PID and confirm no writer is running before removing the lock.
   A stale lock is never deleted automatically.
4. Invalid JSON, invalid records, unsafe totals, and corrupt indexes stop
   startup. Restore a verified backup or repair the file offline; never delete
   unknown usage to make a budget appear available. A complete final JSON
   record missing only its newline is repaired automatically.
5. An unfinished call recovered after a crash appears as an unmetered call.
   With the default `missingUsage: exhaust`, this blocks further dispatch.
   Investigate provider usage before deliberately resetting the scope in the
   settings page. Reset clears all settled and unknown usage for that scope.
6. A runtime append failure blocks further admissions until repair/restart,
   even with `missingUsage: ignore`. Filesystem exceptions are logged locally.

Migration takes the same writer lock, validates legacy budget fields, creates
exclusive backups, flushes new ledger records and atomically saves the index
before replacing the session file. Interrupted migrations can be retried;
already appended identical records are not appended twice. Review any skipped
files; the CLI exits unsuccessfully if any files were skipped.

## Remaining Limits

- Concurrent admitted calls can exceed a limit; this is settled accounting,
  without a token reservation mechanism.
- Unknown tree ownership can still fall back to independent scopes.
- Synchronous append/flush and full ledger replay favor durability over
  throughput. Very large ledgers need offline archival planning.
- Atomic rename and file flush do not guarantee survival of every filesystem,
  hardware, or power failure. Keep backups.
- `missingUsage: ignore` explicitly accepts incomplete provider accounting.

## Reporting

Report reproducible security issues privately to the repository maintainer
using GitHub private vulnerability reporting when enabled. Include the
version, affected boundary, and a minimal reproduction without credentials
or private session data.
