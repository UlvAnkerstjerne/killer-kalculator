# Dormant OnlinePOS incremental worker — Stage 4A

This is a separate, finite CLI process. It is not imported by `server.js`, does
not warm web caches, and has no timer, scheduler or Railway configuration. The
web stays database-disabled. This PR is implementation only: do not provision,
deploy, schedule or activate it as part of Stage 4A.

## Architecture and activation

`lib/sales-worker` validates configuration, reads durable coverage and selects a
bounded plan. `withImportBatch` holds the existing importer's dedicated PostgreSQL
session and publication advisory lock throughout planning, recovery and execution.
Each unit invokes the same importer implementation as `sales-backfill.js`. No
normalization, catalogue admission, decimal handling, identity protection,
pagination, staging, reconciliation, publication or verification logic is forked.

Applying requires **both** `--apply` and the exact string
`KK_SALES_SYNC_ENABLED=true`. Unset/`false` activation returns `disabled` before
reading database/provider configuration. Other activation values fail closed.
Default mode, `--plan` and `--dry-run` all mean plan-only. Plan-only intentionally
needs no activation, identity key or provider credentials; it connects to the
explicitly configured database using read-only transactions and acquires the
same lock, but creates no identity marker, audit record, staging or fact.

Required configuration for all modes:

- `KK_SALES_DB_ENABLED=true` and `KK_SALES_DB_URL` (direct PostgreSQL session,
  private networking for any future production operation).
- Explicit stores: `--store <slug>`, `--stores <comma-separated-slugs>` or
  `KK_SALES_SYNC_STORES`. Accepted stores are the existing six internal slugs.
- An inclusive `--from` / `KK_SALES_SYNC_FROM`, or existing complete coverage
  for **each** selected store from which a lower bound can be derived.

Apply additionally requires the existing matching `KK_SALES_IDENTITY_KEY_HEX`
(64 hex characters) and `KK_SALES_IDENTITY_KEY_VERSION`, plus a token and numeric
company ID for **every selected store**. The exact variable pairs are
`KK_SYNC_TOKEN_<SUFFIX>` / `KK_SYNC_COMPANY_ID_<SUFFIX>`, with suffixes `NORREBRO`,
`VESTERBRO`, `CHRISTIANSHAVN`, `INDRE_BY`, `FISKETORVET`, `FREDERIKSBERG`.
No `.env` or secret files are loaded. No credentials are inferred from web
configuration, repository examples or other stores. Validate the store/company
mapping separately before any future activation. All selected credentials are
validated before a database connection or provider request.

Only the selected credential object reaches each transport; the importer receives
neither the environment nor the credential collection. A process configured for
several stores necessarily holds their configured credentials in memory. For
stronger process-level isolation, use one explicitly selected store per invocation
with only its variable pair available. Unselected tokens and Planday variables
are never read. No production roles, grants, keys or variables are created here.

The catalogue path is fixed to the tracked `catalogues/onlinepos-reviewed.json`.
The production catalogue validator loads it after checking its committed provenance
checksum and 328-product/nine-payment counts. There is no CLI catalogue override,
automatic admission, label substitution or metric/channel classification change.
The exact reviewed empty Frederiksberg label and trailing group-label space remain
intact. The existing identity marker must already exist and match: the worker
cannot bootstrap or replace it. All four committed migration checksums must match;
missing/newer/modified migration ledgers fail before provider work. Migrations are
never applied automatically.

## Deterministic completed-date planning

Capture today's calendar date in `Europe/Copenhagen`. Default exclusive end is
today, so a normal run can include yesterday but never today. `--through` supplies
an earlier exclusive end; an end after today is rejected. Dates remain calendar
labels, including Copenhagen's 23-hour and 25-hour days. Provider boundaries still
use the existing Copenhagen-midnight conversion. No local instant is advanced by
a fixed 24 hours to calculate a business day.

For each selected store, use the explicit lower bound or its **earliest** covered
date before the end. An anchor claims nothing about earlier history. An unanchored
store with no explicit lower bound rejects the whole run. Within those bounds,
find missing dates, sort globally by date then fixed internal store ID, and select
the oldest gaps first. A caller-supplied later lower bound deliberately narrows the
scope; gaps inside that scope are never skipped. Quarantined/failed/interrupted
attempts are not complete coverage. Partial ranges retain their missing days.

`--max-days` / `KK_SALES_SYNC_MAX_DAYS` defaults to **1**, accepts integers **1–7**,
and counts **store/date units**, not distinct date labels across stores. The plan
is deterministic for the same coverage/configuration/clock. `hasMore` explicitly
reports deferred gaps. The maximum is global across stores. Concurrency is fixed
at one; no concurrency override exists.

Every complete published day is a no-op, including complete-single-pass and
verified-empty days. The worker does not rescan, reverify, repair or replace them.
New days receive **complete-single-pass** coverage, not independent verification.
The existing separately authorized `sales-backfill --verify-run` mechanism remains
the only independent verification path; its exact-field comparisons and fact-write
prohibition are unchanged. A synthetic integration test verifies a worker-published
empty-label day through that existing mechanism and checks unchanged fact `xmin`.

## Singleton protection

The existing two-key PostgreSQL session advisory lock `(1935764581, 2)` is held
across the entire run, using the **same session** for importer SQL. This excludes
other workers, manual Stage 2 imports and Stage 1 publishers before provider work
or writes. Its identity is fixed and PostgreSQL scopes advisory locks to the
connected database, making it environment-specific when environments use separate
databases. Workers sharing a database intentionally share the lock regardless of
store selection, credentials or URL spelling. Do not add a configurable lock ID
that could let two processes evade each other. Use a direct/session-preserving
connection, not transaction-pooling middleware.

Acquisition is nonblocking. A competitor returns `busy` / `IMPORTER_BUSY`, exit 0,
with zero provider requests and audit writes; plan-only also refuses a busy owner.
Clean exits and exceptions close the dedicated connection. PostgreSQL releases
session locks when it detects a disconnected/terminated process; there is no
persistent lock row to repair. Network-partition detection can take time, during
which new workers safely remain excluded. Connection loss aborts the active
import and never borrows a replacement connection. No transaction stays open
while waiting on provider HTTP. See PostgreSQL's [advisory lock semantics](https://www.postgresql.org/docs/16/explicit-locking.html#ADVISORY-LOCKS).

## Operational command forms

These examples describe future, separately authorized operations. Supply secrets
through the selected worker's secret environment, never command arguments or logs.

```sh
# Read-only plan; no provider request. Default maximum is one store/day unit.
npm run sales:sync:plan -- --stores norrebro,vesterbro --from 2026-09-20

# One bounded apply invocation; still disabled unless the explicit activation
# flag and all required database, identity and selected-store variables exist.
npm run sales:sync -- --stores norrebro,vesterbro --from 2026-09-20 --max-days 2

# Exactly one selected day, with an exclusive end.
npm run sales:sync -- --store frederiksberg \
  --from 2026-09-20 --through 2026-09-21 --max-days 1
```

Missing, duplicate, incompatible or unknown CLI options fail closed. Dates and
credentials are validated before provider access. SIGINT/SIGTERM abort the run,
clean up through the importer and release ownership. No provider request occurs
merely by requiring a module or validating configuration.

## Failure, audit and crash recovery

The existing tables remain the sole durable audit trail. A new migration or worker
run-state table is unnecessary. Every unit has its existing source scan, sync run,
sanitized staging, day summaries and atomic publication bucket. A run publishes
only after a genuine terminal page, declared-total validation when supplied,
complete durable snapshot validation and fact reconciliation. No chronological
early exit or automatic provider retry exists. Existing per-day 100,000-line
publication limits remain in force. A day is one publication bucket, so no partial
day can commit. Failures never roll back previously completed independent days.

The worker stops the run at the first failed unit, preserving the oldest gap.
It does not continue to newer gaps or another store. A later explicit/scheduled
invocation (scheduling is outside Stage 4A) derives its plan afresh from the DB.

| Interruption/failure | Durable result and next action |
| --- | --- |
| Before fetch | No provider request or facts; the next invocation replans. |
| During pagination or before terminal validation | Existing failed/interrupted audit; no coverage. Recovery discards sanitized incomplete staging under the lock; a later run begins at page one. |
| Terminal traversal but before publication | Existing staged/validated scan is marked interrupted and its staging purged by existing recovery; a later run fetches a new complete traversal. |
| Staging transaction failure | Batch rollback, safe failed audit, no facts. A later run may retry. |
| Unknown catalogue / invalid mixed candidate | Existing quarantine and fixed safe code; zero partial facts. Catalogue remains unchanged. Human review may be necessary; another invocation does not authorize catalogue admission. |
| Publication transaction failure | Atomic bucket rollback. `publication-pending` retains the validated snapshot and blocks the worker before any new fetch. |
| Bucket committed but scan finalization lost | Facts/coverage may already exist, but pending scan still blocks the worker. No assumed rollback or duplicate fetch. |
| Published scan, interruption during staging purge | Complete day remains a no-op; existing recovery purges leftover staging without fetching or changing facts. |
| Successful publication then restart/duplicate invocation | Complete coverage is authoritative; no provider request, fact rewrite or new scan. |
| Database disconnect / SIGKILL | Session ownership is lost/released; no replacement connection. Inspect durable state on restart, using the rules above. |

A pending publication in **any selected store**, including outside the requested
range, blocks the whole worker run. Use the existing, explicitly reviewed
`--resume-publication <run-uuid>` workflow after inspecting its original scope and
snapshot. That command performs no provider traversal, revalidates the durable
snapshot and respects committed bucket checkpoints. The worker never chooses a
pending UUID, bypasses reconciliation, clears a pending state, edits facts or
tries to repair a mismatch. That recovery may require operator action; automatic
closed-date correction and automatic publication-checkpoint resume are unsupported.

The CLI prints one bounded summary with planned, attempted, published, no-op,
quarantined and failed counts; completed-page/received-row counts, in-range logical
counts, elapsed milliseconds, deferred-gap indicator, bounded plan and final
coverage outcomes. `noOp` includes all already-complete dates in the bounded
calendar scope (it can exceed `max-days`). It does not materialize those dates in
memory. `published` counts confirmed durable publication even if later cleanup
failed; `failed` may therefore also count that unit. An unobservable outcome is
`unavailable`, never a claim that a commit did not occur. Failure telemetry marks
`countsComplete:false`: pages/rows reflect progress reported by the importer and
can be lower bounds if a page failed before progress committed. Logical rows are
reported only after successful terminal reconciliation; zero on failure does not
prove no in-range rows were received. Setup/config errors return only a fixed
safe status/code; no attempt started.

Validation/missing anchors/pending checkpoints fail before any new importer audit
or provider work. Pre-existing interrupted/staged audit and staging recovery is
performed only in activated apply mode, using the existing recovery function.
Ordinary logs omit run UUIDs, raw catalogue values, order/line IDs, protected keys,
fingerprints/hashes, provider rows, customer/card/clerk data and all credentials.
No second audit system, raw-payload file, database dump or log artifact is created.

## Resource bounds, tests and disable procedure

The worker holds one DB connection and one store/day at a time. The bounded planner
returns at most eight candidates per store (48 total), selects at most seven, and
holds no multi-day provider data. PostgreSQL enumerates calendar dates only within
the existing 2000–2099 schema range. The current importer bounds each response to
16 MiB and 10,000 rows, staging batches to 250 by default (500 hard limit), scan
pages to 10,000 and scan rows to 2,000,000 by default. Worker CLI does not raise
these limits. Existing ordered DB reads use pages of 500 rows. Finishing or
recovering a unit releases its staging before the next fetch. Long elapsed time
remains possible for a historical lower bound because OnlinePOS returns subsequent
dates; resource ceilings fail safely rather than skip terminal traversal.

Offline tests cover activation, dates/DST, scope validation, credential isolation
and import side effects. Disposable PostgreSQL 16.15 tests cover planning, locks,
atomic failures, exact decimals, empty labels, quarantine, SIGKILL/disconnect,
checkpoint recovery, no-op restarts, narrow writer/read-only roles and deterministic
resource bounds. The existing full foundation/importer/verification suites and
large synthetic importer heap simulation also remain required. CI has only
`contents: read`, pinned actions/PG16 image, public synthetic credentials, a public
network blocker inside tests, no repository secrets and no persistent artifacts.

A future least-privilege worker needs schema USAGE, table SELECT, importer table
INSERT, UPDATE only on sync runs/import scans/day state, and DELETE only on
sanitized staging. It needs **no fact UPDATE/DELETE, migration or schema-owner
privileges**. Plan-only works with USAGE and SELECT. A separate owner applies
migrations and installs the matching identity marker. Exact grants and network
access require a separate authorized production activation review.

Disable by unsetting/setting `KK_SALES_SYNC_ENABLED=false` and not invoking apply.
For a running future deployment, stop its process gracefully; inspect any pending
checkpoint rather than deleting audit rows. No data rollback is performed by
removing this dormant code. Existing facts and coverage remain authoritative.

Stage 4A intentionally does **not** provide current-day synchronization, automatic
correction of published closed dates, production scheduling, historical backfill
activation, database-backed dashboard reads, read cutover, or Planday/payroll
synchronization. It does not grant approval to run a future provider traversal.
