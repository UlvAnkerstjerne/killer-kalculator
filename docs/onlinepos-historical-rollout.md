# Historical rollout plan

Starting source: `849f10a349e3272a127e2fa434d1785112b8bf3a`.
This campaign is separate from Stage 4B and from daily completed-day scheduling.
It changes neither catalogue trust nor the published-fact correction policy.

The lower bound is **2025-01-01**. `index.html` computes the 2026 current-year
range from January 1 and shifts the equivalent comparison range by 364 calendar
days (`getCphDateRange` / `lyDateRange`). Thus the earliest 2026 comparison date
is 2025-01-02. `docs/metric-spec.md` defines budgets from the full equivalent LY
period, not the point-in-time LY cutoff. January 1, 2025 is the requested
conservative boundary and covers these current-year and comparison requirements.
The Last Year view itself reads 2025; its own comparison/budget can request 2024,
as can a custom older range. Those genuinely uncovered requests retain explicit
OnlinePOS fallback. This campaign does not silently expand its lower bound.

The September 28 preflight confirmed 25,958 facts on 47 September 20–27 store-days,
with only Christianshavn September 27 missing. The historical plan initially
excludes every published date and the isolated protected-label task. The daily
workers own September 28 onward and must run naturally.

## Deterministic ranges and budgets

The original plan used separate 2025 and 2026 units. The September 29
continuation instead uses `planHistorical` against durable PostgreSQL coverage:
one terminal traversal per eligible store from its earliest unresolved date to
September 20, 2026 (exclusive), within the existing row/page/time ceilings.
Already covered leading dates and operator-owned zero dates are skipped. Covered
interior dates are reconciled against the same complete snapshot; their facts
and coverage metadata remain unchanged. Known protected catalogue ranges stay
isolated, so Christianshavn's eligible 2025 range ends before its protected 2026
range. Never combine fragments from separate source traversals.

Global importer ownership
allows only one source unit at a time. No historical source unit starts between
02:30 and 04:10 UTC, preserving the first scheduled worker window; a unit has a
20-minute abort and 20-minute-30-second process deadline.

The new historical campaign ceiling, documented before any historical provider
access, is **96 source traversals / 9,600 HTTP requests**. The original allocation was 12 initial units, 12 reviewed catalogue retries and
72 refinements. The cumulative ceiling is unchanged; zero days no longer justify
refinement traversals. Only a proven importer limit can require partitioning.
Every traversal is additionally capped at 100 pages and 1,000,000 received rows.
The unchanged transport limits each page to 16 MiB, starts at most 30 requests per
minute, and times out each HTTP request. Requests are charged before sending;
a lost controller response reserves the unresolved allowance until safely
reconciled. Neither transport failures nor incomplete pagination retry blindly.
This is not a renewal or reinterpretation of Stage 4B's 90-request allowance.

All pages must reach the genuine terminal response and satisfy any declared
provider totals; date order is never an early-exit condition. In-range facts are
normalized with exact decimal arithmetic and the reviewed catalogue before bounded
database staging. No raw provider response is retained. Existing publication
buckets reconcile the staged snapshot, money, quantity, identities and checksum
before the coverage transaction commits. Existing facts are never overwritten.

## Empty days, review and resumption

Historical imports default to the persisted `review` zero-day policy. After a
terminal scan passes snapshot, catalogue, identity, decimal, checksum and prior
fact reconciliation, each monthly/day transaction publishes its nonzero days and
records zero days as `ZERO_OBSERVED_PENDING_REVIEW`. A committed bucket includes
its zero observations atomically. It does not add fake sales facts or confirm a
closure. Existing pending/retry/closed decisions survive repeated observations.
The daily scheduler keeps its existing nonempty guard.

The private `scripts/sales-zero-days.js --list` command emits a consolidated safe
store/date list. Only Ulv's explicit per-date decision permits `--decision
VERIFIED_CLOSED` or `--decision RETRY_REQUIRED`, with `--store`, `--date`,
`--observation-run` and `--reviewed-by ulv`. The exact observation is checked under
the importer lock. Repeated identical decisions are no-ops; stale or conflicting
decisions fail. A retry-required date needs a separately bounded operator retry.

Pending and retry-required states remain missing for whole-range routing, with
an explicit `zeroDayStatus` in coverage metadata. `VERIFIED_CLOSED` is covered
with zero facts and `verified-closed` evidence, **not** independent provider
verification. Today and incomplete/mixed ranges still use OnlinePOS wholly;
selected database failures remain visible. Existing reader column grants suffice.

`--retain-observation <run>` converts an explicitly selected old zero-guard failure
using its terminal durable day summaries, complete range/count reconciliation,
no catalogue reviews and no pending staging/buckets/discrepancies. It performs
no source request, does not recreate purged rows and cannot approve a closure.

Terminal `review` snapshots survive a crash after summary finalization and block
new source work until explicit publication resume. Resume revalidates the entire
snapshot and existing facts, skips committed buckets and uses no HTTP. Incomplete
source scans remain non-resumable. Never split/refetch a valid range because it
contains zeros.

Safe exact encoded catalogue envelopes may be retained from failed source units.
Only independently reviewed business-neutral product tuples may be admitted as
unclassified. Never automatically admit payments, conflicts with an existing ID,
protected text, or a product requiring a guessed metric classification. Batch
related reviewed additions, deploy their exact catalogue, then explicitly retry
only the blocked scope. A diagnostic is not repeated merely for better reporting.

A `publication-pending` checkpoint is a hard source-fetch barrier. Inspect the
existing run, staged summaries, bucket checkpoints and stored facts; resume only
unpublished buckets through the documented procedure. Database write uncertainty
never justifies a new provider traversal. The controller ledger and safe
checkpoint summaries permit interruption without repeating complete work.

The natural daily jobs remain separately bounded and observable. Their readiness
or deployment status is not proof of an actual scheduled publication. Phase 3
must report the six actual September 29 runs and compare durable September 28
coverage before the rollout is declared complete.

## Historical catalogue review capacity

The first terminal Vesterbro 2025 traversal received 232,712 rows in 24 pages,
including 134,886 in-range rows and 17,038 rows requiring catalogue review.
Publication remained blocked with no facts or coverage written. Its retained
review reported candidate overflow at the former 20-tuple limit, so it contained
no recoverable exact tuples. No raw source payload was retained.

The encoded review transport now permits at most **512 candidate tuples and
2 MiB**, sufficient for a bounded historical catalogue review while remaining
independent of source-row count. The same strict decoder, terminal/declared-total
validation, protected-text refusals, collisions, field allowlist and explicit
review requirement apply. Exceeding either bound still rejects the envelope;
there is no truncation, automatic admission, payment approval or classification.
One controlled repeat of the blocked scope after deploying this capacity repair
is necessary to obtain reviewable exact tuples, and must be charged to the
historical campaign. It is not permission for a blind transport retry.
