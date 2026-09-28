# Daily completed-day sales import

The daily entry point reuses the existing importer, trusted catalogue, identity,
terminal-page checks, global ownership lock and atomic publication checkpoints.
It adds scheduling eligibility and safe durable status; it changes no source
normalization, catalogue admission, metric definitions or dashboard routing.
The original manual planner remains available for explicitly reviewed work.

## Production schedule

Six existing private `kk-sales-sync-<store>` Railway services run finite commands:

```
node scripts/sales-daily.js --apply
```

| Store | UTC cron | Copenhagen summer / winter |
| --- | --- | --- |
| norrebro | `0 3 * * *` | 05:00 / 04:00 |
| vesterbro | `10 3 * * *` | 05:10 / 04:10 |
| christianshavn | `20 3 * * *` | 05:20 / 04:20 |
| indre-by | `30 3 * * *` | 05:30 / 04:30 |
| fisketorvet | `40 3 * * *` | 05:40 / 04:40 |
| frederiksberg | `50 3 * * *` | 05:50 / 04:50 |

Railway schedules in UTC and may start a few minutes late. These slots are after
both summer and winter Copenhagen midnight. Calendar labels, including DST
changes, define the imported day. This is not a rolling 24-hour window. A run
that is still active prevents the next Railway cron invocation. Each process
therefore has an eight-minute abort and an eight-minute-thirty-second hard exit,
closes its dedicated connection, uses restart policy NEVER and zero restart
retries. The existing environment-wide advisory lock prevents overlap with any
other importer. A busy job exits without a source request and catches up later.
Railway cron documentation: https://docs.railway.com/cron-jobs

Each service retains only its selected store's provider credential pair and its
existing private database/identity configuration. Deployment uses exact committed
source with a verified source manifest. No public worker domain or database
proxy is required. Temporary operator SSH access is removed after validation.

Set `KK_SALES_SYNC_ENABLED=true`, `KK_SALES_SYNC_STORES=<single store>` and
`KK_SALES_DAILY_FROM=2026-09-28`. The explicit floor excludes the historical
Christianshavn September 27 protected-text task. Do not move the floor backwards
or use daily retries to bypass a catalogue review. The old `KK_SALES_SYNC_FROM`
and `KK_SALES_SYNC_MAX_DAYS` variables do not control this new entry point.

Before activation, run `node scripts/sales-daily.js --readiness` with the actual
worker environment. This validates store/date configuration, provider credential
shape, all migration checksums, the identity marker, ownership availability and
durable coverage/checkpoints. It makes no provider request and no audit or fact
write. A pending publication fails readiness. A successful check exits promptly.

## Bounds and retries

The job examines the seven most recent closed Copenhagen dates, never earlier
than the explicit floor and never Today. It attempts at most two eligible dates,
newest first, with at most twenty HTTP source requests in the whole invocation
and 100,000 received rows per date. Existing transport limits still apply,
including one request at a time, at most thirty starts per minute, response-size
and request-time limits. Genuine terminal pagination and declared-total validation
remain required. There is no chronological early exit or within-run retry.

Complete durable coverage is a no-op: no source fetch, replacement of facts or
new import audit. An eligible missing date begins a durable scan before HTTP.
Only `UPSTREAM_FAILED`, `UPSTREAM_RATE_LIMIT` and safely recovered `INTERRUPTED`
attempts retry automatically, after at least twenty hours, at most three attempts
per date. Attempt count and timestamps come from PostgreSQL, not process memory.
A later job can process a new day while an older date remains blocked.

A terminal empty candidate stays missing with `ZERO_FACT_DAY_REVIEW`; the existing
nonempty worker guard is preserved. Catalogue, invalid-source, conflicting-source,
limit and other nontransient failures require operator review and are not retried
by this entry point. Nothing is classified or admitted automatically. Dates older
than the rolling lookback or exhausted attempts remain missing until an explicit
operator task handles them. The live coverage notice continues to show such gaps.

Any `publication-pending` checkpoint blocks further source fetching for that store,
including on later invocations. Reconcile the existing run and bucket checkpoint
using the documented publication-resume procedure in
[the importer runbook](sales-db-foundation.md); never fetch again to determine
whether a write committed. Database disconnects report `unavailable` outcome,
not a claimed rollback. A complete durable checkpoint can confirm publication
following a post-commit error. Other stores have independent scheduled processes.

## Observable results and dashboard reads

Each attempt emits one `started` and one `finished` JSON record with store, date,
attempt/finish times, completion state, fixed error code and HTTP request count.
Final JSON contains the bounded date list, durable attempt counts, last-attempt
and completion timestamps, coverage evidence, line count, error code and action:
`complete`, `eligible`, `retry-not-due`, `operator-review` or `attempt-limit`.
Uncertain completion is `publication-pending` or `unavailable`, never silently
reported as missing/rolled back. `--readiness` reports the same durable date status
without importing. Missing dates produce `gaps` and exit 1; infrastructure and
pending-checkpoint failures produce `incomplete` and exit 1; `busy` performs no work.

Output never includes source rows, credentials, source IDs, catalogue labels,
encoded private review payloads, identity fingerprints or protected hashes. The
importer's detailed catalogue reporter is deliberately not connected to job logs.
Production PGOPTIONS suppress statement/row details from expected database errors.
Use Railway failed cron state and these safe error codes for operator triage.

Automatic imports produce `complete-single-pass` evidence, not independent proof.
`KK_SALES_READ_SOURCE=onlinepos` and `KK_SALES_READ_POLICY=covered-history` stay as
configured. The dashboard uses PostgreSQL only for a fully covered closed range;
Today or any uncovered date makes the entire range use OnlinePOS. Stored source
observation timestamps remain visible and are historical snapshots, not live data.

Daily request counts are a new ongoing operational budget bounded above per job;
they do not consume/reopen the completed Stage 4B historical allowance or authorize
its private protected-label task. Keep a separate actual request ledger for cron
runs. A deployment/readiness run is not evidence of a successful scheduled import.

## Validation

`npm test` covers selectors, forward floor, Today/DST boundaries, retry decisions,
configuration failures and disabled behavior. `npm run test:daily:db` exercises
real PostgreSQL publication, empty-day review, safe failure output, durable delayed
retry/exhaustion, no-op repeat, independent-date progress, bounded pagination,
declared totals, global ownership, pending publication and lost-connection outcome.
The existing foundation, importer, worker and dashboard database suites remain
required. All provider fixtures in tests are synthetic; network guard blocks
external source access.
