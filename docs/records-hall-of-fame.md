# Records Hall of Fame

This change is based on the unmerged Records week/month/lunch PR #58
(`98b4d2a`). The latest merged main inspected before implementation was
`2ebf896` (Records read-only grant fix), including the Kockpit store-summary
endpoint and existing dashboard navigation. The Hall of Fame has its own
`codex/records-hall-of-fame` branch and a PR targeting the Records calculation
branch, so reviewers can see its additions separately. It must follow that
dependency through review before being retargeted to main; neither PR is merged
or deployed by this task.

## Browsing and calculations

Opening Records automatically shows top-five days, complete Monday–Sunday weeks,
complete calendar months, lunches, complete Saturday/Sunday weekends, and each
individual weekday. The existing sidebar is the single scope selector: All Stores
Combined or one of the six stores. On small screens, Choose store opens that same
sidebar. Dashboard date controls are hidden while browsing these all-time boards.
Leaving Records restores the usual dashboard sidebar and date controls.

The question-first UI is removed; authenticated `POST /api/records/query` remains
compatible for existing callers and also understands weekends. Per-entry date or
period, rank and revenue excluding VAT are shown. Combined entries have expandable
per-store breakdowns. Each board shows its eligible span/count, missing/ineligible
period counts, and expandable coverage details even when no record qualifies.
Fewer than five results are explained rather than padded with empty/zero records.

All existing definitions and safeguards from [Records periods and lunch](records-periods-lunch.md)
are reused. A weekend has exactly two dates: Saturday and Sunday in Copenhagen.
It becomes eligible on Monday, once both dates have eligible coverage. A missing
store-date disqualifies the whole combined weekend; verified closures may provide
zero. Partial initial weekends, uncompleted weekends and future dates cannot rank.
Year/month boundaries and DST do not alter the calendar-date rule. Weekday history
starts at the following weekend; history beginning on a Sunday requires the
preceding Saturday and exposes its absence as incomplete coverage.

## Batching and freshness

`GET /api/records/leaderboards?store=all&group=standard` requires the existing
authenticated session and returns eleven boards from one day-state history read:
days, weeks, months, weekends and seven weekdays. `group=lunch` returns the lunch
board using one history read and one transaction-fact aggregation. `store` accepts
`all` or a canonical store slug; unknown/repeated scope/group values return 400.

Each batch uses the existing migration/role readiness checks and an explicit
repeatable-read/read-only snapshot under unchanged column grants. The fact scan
is not repeated for individual boards. No new grants, migrations, production
settings, authentication changes or provider fallbacks are introduced.

The browser loads standard boards first, then lunch. There are at most two Records
requests per uncached scope visit, not one request per leaderboard. A lunch failure
does not remove usable calendar boards. Loading, empty and failed categories are
distinct, and failed batches offer an explicit retry without automatic retry loops.

Identical in-flight requests coalesce. Successful batches are cached in browser
memory for five minutes, capped at fourteen scope/group entries. Cache keys include
the Copenhagen date and session generation; logout clears the cache and discards
late replies. Failed requests are not cached. Obsolete store/view requests cannot
repaint the current view. Refresh invalidates the cache and reloads both batches.
The API uses `Cache-Control: private, no-store`; no business data is persisted in
localStorage or served through a shared HTTP cache.

## Links for dashboard celebrations

Public, stable leaderboard IDs are shared by frontend and backend in
`lib/records-leaderboards.js`. The browser receives the same module as
`window.RecordsLeaderboards` through its explicit static asset route.

```js
// Whole Hall of Fame, preserving a store scope:
'/#records?store=frederiksberg'

// A relevant category, or one particular calendar period:
RecordsLeaderboards.href('all', 'weeks')
// #records?store=all&board=weeks
RecordsLeaderboards.href('norrebro', 'weekends', '2026-08-29')
// #records?store=norrebro&board=weekends&date=2026-08-29
```

Allowed board IDs: `days`, `weeks`, `months`, `lunches`, `weekends`, `monday`,
`tuesday`, `wednesday`, `thursday`, `friday`, `saturday`, `sunday`. Dates use the
inclusive period start (Monday for a week, first day for a month, Saturday for a
weekend). These are normal same-origin hash links; they survive login, reload,
and browser back/forward. Category links focus and scroll to the board after its
data loads. Date links highlight the matching top-five entry. A date outside the
current eligible top five is explained, without inventing a rank or changing the
leaderboard's limit. Invalid link values normalize to a safe scope/category.

## Validation

- Full local regression/privacy-canary suite: 1,381 tests passed, none failed or
  skipped. Tests include batching limits, cache TTL/Copenhagen midnight, concurrent
  requests, session/scope races, failure/retry, HTML escaping, navigation and links.
- PostgreSQL 16.14: 21 dashboard/Records integration tests passed. All twelve
  boards in every scope match the existing Records path; weekend totals reconcile
  with transaction facts and reads leave source row versions unchanged. Existing
  coverage, timestamp-quality, permissions, readiness and auth/CSRF tests remain.
- Production read-only check on 2026-10-10: all fourteen batches across seven
  scopes passed (84 boards, five results each). Independent SQL and raw transaction
  totals matched all 35 returned weekend winners and their store breakdowns.
  The role remained non-writable and unable to read protected identity/store
  lookup columns. Proposed modules ran in memory in a separate short-lived Railway
  process; deployed files, production data, credentials and permissions were unchanged.
- Observed database-reader times were 44–48 ms per store for standard boards and
  89–189 ms for lunch; the combined scope took 175 ms and 399 ms respectively.
  These are individual functional checks, not load-test guarantees.
- Browser checks with synthetic data verified automatic population of 60 entries,
  seven scope choices, per-store/combined switching, compact period labels, and
  dated deep links that retain scope, focus and highlighted entries after reload.

Live revenue values are omitted from this public document. The existing CI workflow
runs the expanded regression and PostgreSQL suites. No merge or deployment is
performed as part of validation.
