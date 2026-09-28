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

Initial source units, ordered by start date then canonical store ID, are:

- `[2025-01-01, 2026-01-01)` for each of the six stores;
- `[2026-01-01, 2026-09-20)` for each of the six stores.

Recompute against durable coverage before each unit. Never include an already
published day in an automatic publication unit. Split at any existing covered
island; a resumed controller skips complete coverage. Global importer ownership
allows only one source unit at a time. No historical source unit starts between
02:30 and 04:10 UTC, preserving the first scheduled worker window; a unit has a
20-minute abort and 20-minute-30-second process deadline.

The new historical campaign ceiling, documented before any historical provider
access, is **96 source traversals / 9,600 HTTP requests**. Allocation: 12 initial
year/partial-year units, up to 12 explicitly reviewed catalogue retries, and up
to 72 scoped refinements for proven empty-day splits or row-bound partitions.
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

The nonempty worker guard now applies to **every day** of a multi-day candidate.
One empty day stops publication of the entire candidate before any bucket commits.
The existing durable per-day summaries identify zero and nonzero dates without
retaining source rows. A controller can plan narrower nonempty ranges from those
summaries, charge their new traversals and leave zero days visibly missing for
operator review. It cannot label them complete from a zero response alone.
Manual historical imports and independent verification keep their existing
explicit behavior; this guard applies to bounded worker batches.

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
