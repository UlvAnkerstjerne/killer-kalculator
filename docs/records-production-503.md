# Records production 503 investigation

## Root cause

The Records queries introduced in `3386704` joined
`sales_foundation.sales_store`. The production `kk_sales_dashboard` role has
deliberately limited column-level SELECT grants on migration history, day state
and public sales facts. It has no SELECT grant on `sales_store`.

Railway HTTP logs show `/api/records/query` returning 503 at
2026-10-09 20:30:41 and 20:31:51 UTC. PostgreSQL logs at those same times report
`permission denied for table sales_store`. Running all four suggested queries
in explicit read-only transactions using the deployed app's existing database
connection reproduced SQLSTATE `42501` for every query. Readiness passed: the
migration ledger and restricted role were valid. This was a query/grant mismatch,
not a missing environment variable or a readiness failure.

## Fix and preserved safeguards

Records now filters and returns the already-readable `sales_day_state.store_id`.
It resolves IDs with the existing canonical mapping in `lib/sales-db/values.js`,
as the dashboard already does. Migration 001 constrains the six IDs and slugs;
the unchanged readiness check verifies migration checksums before reading.
Chain breakdowns retain their alphabetical slug order.

No database grants, roles, authentication, environment variables, migrations,
deployment settings or production data were changed. Authentication and CSRF,
sanitized public errors, repeatable-read/read-only transactions, migration and
role checks, eligibility evidence, today/future exclusion, and the requirement
for all six stores on the same date remain intact. Pending/retry/missing store
days cannot become complete chain records; reviewed closures can contribute zero.

## Actual database validation

The corrected module was loaded into a separate, short-lived Node process in
memory over Railway SSH. It used the deployed app's existing `kk_sales_dashboard`
connection and the full reader/readiness path. No deployed files were replaced,
no service was restarted and no deployment was triggered.

Validation used Copenhagen cutoff `2026-10-09`. For each query, an independent
JavaScript calculation read all 3,876 day-state summaries in the same snapshot,
filtered eligible dates, summed exact decimals with BigInt, ranked candidates,
and compared every result and store breakdown with the fixed query.

| Suggested query | Results | Stores per result | Leading date |
| --- | ---: | ---: | --- |
| Best day ever in Frederiksberg | 1 | 1 | 2025-12-06 |
| Best Monday across the chain | 1 | 6 | 2025-12-22 |
| Top 5 Fridays across the chain | 5 | 6 | 2026-06-05 |
| Top 10 days in Nørrebro | 10 | 1 | 2025-06-05 |

All comparisons passed. Every transaction reported `transaction_read_only=on`;
the role still lacked permission to read the store lookup's slug column.
The tested Records source SHA-256 was
`7ab304eaabc4cf750cb0779137057120cfc246f4580173a6de24da096aa15829`.
This validates the proposed code against production data; the deployed HTTP
endpoint still requires an approved merge/deployment to receive the fix.

## Automated verification

- Full regression: 1,352 passed, zero failed/skipped; privacy canary passed.
- Real PostgreSQL 16.14: seven existing dashboard checks and six new Records
  checks passed, using the unchanged column-level dashboard grant script.
- Records tests cover all four prompts, ID mapping, six-store totals, missing
  coverage, pending/retry zeros, reviewed closures, verified empty days, refunds,
  weekday filters, ties, limits, current/future dates, privileged-role rejection,
  migration mismatch and unchanged day-state row versions.
- HTTP tests retain session/CSRF enforcement and verify private database errors
  do not appear in the response.
- Locked dependency installation reported zero vulnerabilities; syntax and
  whitespace checks passed.

The regression suite's old worker-isolation assertion rejected any `sales-db`
import, including the pure Records parser already imported by main. It now
checks actual default startup cannot load PostgreSQL, migration or writer modules.
Local HTTP regression tests were run from a visible temporary test copy because
Express's dot-directory protection rejects files under the managed `.codex`
worktree path. The production static-file policy was not changed.

`npm run test:dashboard:db` now runs both PostgreSQL files serially, since each
uses the same disposable schema. The existing CI job already invokes this command.
