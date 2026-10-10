# Weekly, monthly and lunch Records

Records supports best/top 1–10 days, weeks, months and individual-date lunches
for one named store or all six stores. Existing daily and weekday prompts remain
supported. Weekday filters apply to daily and lunch rankings; mixed requests such
as a Friday month or a weekly lunch are rejected instead of reinterpreted.

## Definitions and eligibility

- Weeks are Monday–Sunday and months are complete calendar months. Calendar labels
  use Europe/Copenhagen; DST does not shorten or extend the number of dates required.
- Lunch includes all recorded transactions before 16:00 Copenhagen time, as
  confirmed by the product owner. Transactions at or after 16:00 are excluded.
  There is no historical opening-hours schedule, so no opening-time cutoff is invented.
- Revenue uses the existing `revenue_excl` metric, including signed refunds.
  Exact decimal arithmetic determines sums and ranks; results retain the existing
  numeric JSON and currency-display conventions. Equal totals sort by earliest date.
- Every date in a period must have eligible published day-state evidence and a
  source observation after that Copenhagen day ended, without a future observation.
  Chain periods require every date for all six stores. Missing rows never imply zero.
- Reviewed `VERIFIED_CLOSED` dates contribute zero. Pending/retry closures and
  unverified coverage disqualify their entire period. The existing single-store
  full-day ranking continues to exclude days with no recorded transactions.
- The current day, current Monday–Sunday week, current month and future periods
  cannot rank. The first partial historical week/month is also excluded.

Lunch sums transaction lines in PostgreSQL. Before ranking a store-date, its
active fact count and both exact VAT-inclusive/exclusive totals must reconcile
with the published day state. Only unambiguous `payment` timestamps qualify.
Any missing, fallback or DST-ambiguous timestamp excludes the entire date, even
if the uncertain line has zero revenue. For chain lunch, it excludes that date
across the chain. The existing checked schema enforces local timestamp/date,
seconds-of-day and DST-quality consistency. No daily-total prorating is used.

## Coverage and interface

The existing Records form, cards and six-store breakdown remain. Suggested prompts
include all seven new examples. Results add inclusive `periodStart`/`periodEnd`
fields and retain the existing `date`, `weekdayIso`, revenue and stores fields.
`date` identifies the period start for weeks/months.

`meta.coverage` describes stored history, the completed period cutoff, eligible
span, counts checked/eligible/excluded, each store's history and eligible days,
timestamp-quality counts for lunch, and exclusion reasons. Reasons may overlap.
Up to 12 chronological exclusion examples identify affected stores; the response
states how many further excluded periods are summarized by the counts.

The UI displays this coverage even when no record qualifies. It distinguishes
stored history from eligible periods, explains the initial partial period and
other gaps, and states that records rank the available verified history. Per-store
eligible day counts describe that store's available dates within the ranking's
scope, including dates whose chain period another store disqualifies.

## Database and security boundaries

The query uses the existing dashboard column grants on `sales_day_state` and
`sales_line`; it does not join the restricted store lookup. Canonical store IDs
remain tied to the migration-checked mapping. Lunch reads return daily aggregates,
not transaction identities or raw fact history, to Node and the browser.

Session authentication, CSRF, sanitized public errors, migration/role readiness
checks and repeatable-read/read-only transactions remain enforced. No migrations,
grant changes, database writes, credentials, deployment configuration or importer
changes are needed. The parser loads database aggregation code only on a Records
read, preserving the web startup's existing separation from database writers.

## Validation on 2026-10-10

Production reconciliation used the existing restricted `kk_sales_dashboard` role
inside explicit read-only snapshots. The proposed modules ran in memory in a
separate short-lived Railway SSH process; no deployed files were replaced or
service restarted. The deployed HTTP endpoint has not received this expansion.

All 12 comparisons passed: the four existing suggested prompts, all seven new
prompts, and unfiltered chain lunch. An independent SQL calculation used
`date_trunc`, complete-period row counts, exact sums and local `sale_local::time`
for lunch, comparing every returned rank and store breakdown. The implementation
uses calendar-label arithmetic and `second_of_day` for the lunch cutoff.

Four leading week/month results (store and chain) were additionally reconciled
directly to raw active transaction-line counts and exact totals. Those matched
the published day states exactly, and their numeric JSON amounts matched the
ranked results. Protected store lookup/transaction identity columns and database
writes remained unavailable to the reader role.

The checked history spans 2025-01-01 through 2026-10-09 for all six stores.
There are 91 eligible complete weeks and 21 complete months. The initial partial
week is correctly excluded for missing pre-history dates. Lunch's quality report
found no uncertain timestamps within the covered dates checked. Observed reader
times were 15–79 ms for full periods, 181 ms for store lunch, 243 ms for Friday
chain lunch, and 471 ms for unfiltered chain lunch; these are individual checks,
not a load-test guarantee. Live revenue amounts are omitted from this public document.

Automated checks:

- Full regression: 1,365 tests passed, none failed or skipped; the repository's
  privacy-canary runner passed.
- Real PostgreSQL 16.14: all 19 dashboard/Records integration tests passed under
  the unchanged column-grant script. The new cases reconcile day/week/month/lunch
  results to synthetic transaction facts and verify unchanged row versions.
- Coverage includes missing store-days, partial periods, pending/retry and verified
  closures, observation timestamps, current/future periods, year and leap-day
  boundaries, spring DST, autumn ambiguity, missing/fallback timestamps, refunds,
  15:59:59 versus 16:00, fact mismatches, exact ranking and stable ties.
- HTTP tests preserve session/CSRF checks and private-error sanitization; UI tests
  cover prompts, period labels, six-store breakdowns, escaping and empty coverage.
- Browser smoke checks with synthetic data confirmed week, month and Friday lunch
  submission, period labels, all six store cards and expanded exclusion details.

Run `npm test`, and run `npm run test:dashboard:db` only with the guarded disposable
`KK_TEST_DATABASE_URL`. Database suites run serially because they reset their test
schema. The existing CI workflow includes these tests. Local HTTP tests use a
visible temporary checkout to avoid Express's intentional dot-directory protection
on managed `.codex` worktree paths; production static-file policy is unchanged.
