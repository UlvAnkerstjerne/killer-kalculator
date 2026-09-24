# Planday payroll audit

Updated 2026-09-24 for draft PR #6, branch `fix/planday-payroll-accuracy`. This follow-up starts from `3845b3e` and preserves the parser, shared cutoff, aggregate privacy boundary, caching and regression checks from the earlier commits. Baseline main is `29ed320`. No merge, deployment, production configuration change or employee-level export was performed.

## Result and review gate

**Keep PR #6 draft.** The confirmed business rules are implemented. Live reconciliation cannot certify completed actual salary allocations while attendance is missing.

- September's three store-manager salary agreements total **100,600.00 DKK**. The full-month scheduled allocation conserves exactly **100,600.00 DKK**, with **92,499.52 DKK** assigned to dashboard stores and **8,100.48 DKK** retained outside. These are full-month allocation checks, not the current KPI; the KPI stops at its cutoff.
- The three central/overhead agreements total **97,500.00 DKK/month**, all excluded. Their store contributions require actual attendance at the authorized shared rate; scheduled store hours never substitute for actual hours.
- One central-worker store shift lacks attendance in September. Nørrebro and the chain remain unavailable for Last Week and September-to-cutoff.
- August requires 56 in-scope attendance matches: **48 matched, 8 missing**. Seven gaps belong to the three salaried-manager denominators; one belongs to central store work. All three August salary allocations remain incomplete. No scheduled August hours are labelled actual.
- September 22's Christianshavn schedule-only sick leave contributes **0.00 DKK** with `SICK_LEAVE_WITHOUT_MONETARY_PAY`. The unsupported **591.71 DKK is not added**. The supported store and chain totals remain available.

The remaining gate is authoritative attendance coverage, not another allocation decision. A Planday administrator must reconcile the missing attendance records; rerun the live checks afterward. Do not mark ready, merge or deploy based on supported subtotals alone.

## Confirmed rules and effective dates

| Deidentified policy | Effective scope | Cost attribution |
|---|---|---|
| Central C1 | From 2026-01-01 while its salaried agreement applies | Exclude monthly salary. Verified actual six-store work only at 225 DKK/hour; all outside departments excluded. |
| Central C2 | From 2026-02-01 while its salaried agreement applies | Same actual-work rule. |
| Third central policy | Every supported period with its salaried agreement | Same actual-work rule; prior explicit Indre By monthly allocation is superseded. |
| Christianshavn home policy | From 2025-11-01 | 100% of the monthly salary belongs to Christianshavn. Office hours participate in daily weights and retain the same home store. |
| Regional store policy | From 2025-11-01 | Hours across all verified departments form the denominator. Each department retains its own portion, including outside operations. |
| Indre By home policy | From 2026-04-01 | 100% of monthly salary belongs to Indre By, including cost weighted by Office hours. |

No worker names, raw employee identifiers or job titles are stored in source, fixtures, this document, application logs or API responses. Runtime salary amounts come from full calendar-month Payroll documents; they are not copied into the policy registry.

For the home and regional policies:

`period cost = monthly agreement amount × qualifying hours overlapping the requested period/cutoff ÷ qualifying calendar-month hours`

A completed **calendar month** requires approved actual punch timestamps, minus recorded clock breaks. An active calendar month uses the full scheduled month denominator and scheduled numerator, explicitly estimated. A completed day or week inside the active month still uses this estimated salary distribution. Zero-hour days accrue zero salary under the confirmed rules. At Copenhagen month close, cached estimates expire and the service automatically requires actual monthly attendance.

Central policies always require actual attendance. A live open punch contributes only elapsed work through the cutoff while the schedule confirms an in-progress shift. Stale open punches, missing punches, unapproved closed punches and unverifiable breaks remain incomplete. Outside central shifts require no allocation to the six stores. An unavailable attendance endpoint cannot establish a plausible zero.

### Rounding, overlap and conservation

All salary work intervals are split at Copenhagen midnight and clipped to the salary agreement's dates. Same-destination overlapping intervals are unioned. Home-store Office overlaps therefore count each minute once. Regional/central overlaps across conflicting departments fail closed; the older half-minute department-sharing estimate is not used for the confirmed rules.

Within each month, chronological cumulative hours determine rounded cumulative integer øre. Each interval/day receives the difference between successive rounded totals. The final interval receives the residual øre automatically, so all destinations together equal the provider amount exactly. This also makes adjacent periods/cutoff slices additive. Outside portions advance the cumulative allocation and are then excluded from dashboard totals, never redistributed.

Payroll monetary shift amounts remain monetary amounts; they are not multiplied by hours. Distinct overlapping hourly records fail closed. Identical stable IDs are idempotent; conflicting duplicates fail. Signed daily adjustments such as Kostfradrag remain counted once, with the existing explicit elapsed-shift allocation estimate. Unverified nonzero nested break/supplement arithmetic still fails closed.

## Verified sources and authoritative fields

Official references were checked against live August/September payloads:

- [Payroll guide](https://developer.planday.com/guides/payroll-guide/) and [Payroll schema](https://openapi.planday.com/payroll/swagger/v1.0/swagger.json).
- [Time clock guide](https://developer.planday.com/guides/timeclock-guide/) and [Punch Clock schema](https://openapi.planday.com/punchclock/swagger/v1.0/swagger.json).
- [Scheduling schema](https://openapi.planday.com/scheduling/swagger/v1.0/swagger.json), [Time & Cost guide](https://developer.planday.com/guides/timeandcost-guide/) and [Pay schema](https://openapi.planday.com/pay/swagger/v1.0/swagger.json).
- [HR schema](https://openapi.planday.com/hr/swagger/v1.0/swagger.json) and [API rate limits](https://developer.planday.com/gettingstarted/rate-limiting/).

| Endpoint / field | Verified interpretation |
|---|---|
| Payroll `shiftsPayroll[].salary` | Authoritative monetary shift amount. Approved document membership establishes approved monetary provenance; otherwise explicitly scheduled. |
| Payroll `start`, `end`, `shiftDuration` | Payroll/approved shift timing and duration; these are not substituted for actual clocked hours in completed-month salary weights. |
| Payroll `salariedPayroll[].salary`, `start`, `end` | Full calendar-month agreement amount/date scope. Monetary documents remain segmented by month because cross-month provider proration can change results. |
| Payroll `supplementsPayroll[].salary` | Signed period amount, including deductions. Equal-valued distinct entries are retained once per document; values are not used as deduplication identities. |
| Scheduling `startDateTime`, `endDateTime`, `status`, `timeZone` | Scheduled/approved interval, not independent clock evidence. Open, Draft, Cancelled and Deleted records do not represent qualifying work. Assigned future work can form an active-month denominator but never its future numerator. |
| Shift detail `shiftTypeId` + shift-type catalogue | Classifies the verified `Sygemelding` type. Normal live detail responses omit nullable `shiftTypeId`; omission was checked against list/detail identity and timing. The catalogue also exposes Administration and Shift Manager; these are shift types, not personal job titles. |
| Punch Clock `startDateTime`, `endDateTime`, `isApproved` | Actual punched interval and approval. Required for completed salary months and central actual work. `shiftStartDateTime` / `shiftEndDateTime` are separately approved/scheduled timings and may differ from punched times. |
| Punch Clock `shiftId`, `employeeId`, `departmentId` | Server-only linkage checks; never emitted. Missing or conflicting linkage is incomplete. Direct by-shift checks of representative missing records also returned unavailable; no alternate actual duration was invented. |
| Punch Clock `/{id}/breaks` | Recorded break windows are excluded from worked hours. Requires complete `TotalPaging` metadata. Payroll manual/nonzero break semantics remain fail-closed rather than guessed. |
| Time & Cost `costs[].cost` | Monetary fallback only for an identified sickness shift absent from Payroll, with exact server-only shift/employee/type/date match and verified DKK currency. It is never added over an existing Payroll row. Missing money produces the safe exclusion warning. |

Punch Clock requires nonempty datetime ranges and the live endpoint rejects intervals over 31 days. The loader therefore requests each calendar month separately plus a separate preceding-day lookup for overnight work. Standard paginated APIs validate stable totals/offsets; unpaged break responses validate their total against returned count. Shift detail identity/timing must agree with the schedule snapshot. Failed detail/break reads cannot turn into empty successful data.

Raw Planday documents exist only during server-side computation. Secondary calls run in batches of five. The shared HTTP client paces requests at 100 ms per start and retries a 429 once only after a valid provider reset delay (at most 60 seconds). OAuth refresh remains coalesced and unauthorized calls retry once. No raw upstream error is retained or logged.

### Department boundaries

| Planday department | Dashboard classification |
|---|---|
| 148561 | Vesterbro |
| 149668 | Indre By (Inner City/Borgergade) |
| 149700 | Nørrebro |
| 149715 | Frederiksberg |
| 149725 | Fisketorvet (Kajen) |
| 149748 | Christianshavn |
| 149683 / 149749 | Parken B / C, outside |
| 149787 | Festival, outside |
| 149750 | Office, outside except salary attribution explicitly authorized by a home policy |

The live department inventory contains ten departments. Additional IDs are outside only when the complete provider inventory establishes they exist; unrecognized IDs fail closed. Current broad HR membership never overrides the confirmed policy. Unknown new salaried workers fail with `WORKER_RULE_UNAVAILABLE`.

## Live period reconciliation

Capture finished **2026-09-24T06:43:01.158Z**. Today / This Week / September-to-cutoff use **2026-09-24 08:29:00 Europe/Copenhagen (06:29:00Z)**. Yesterday is September 23; Last Week is September 14–20. The 14:32 replay is September 23. End dates are exclusive. Provider records remain editable; these captures are calculation evidence, not a locked payroll ledger.

All available nonzero results below remain **estimated**, because September is an active salary month and signed adjustment allocation is estimated. “Complete” means supported under those declared rules; it does not mean final monthly actual payroll. Today has genuine zero work and zero sales at this early cutoff, so no percentage is defined.

| Period | Chain salary DKK | Aligned revenue ex VAT DKK | Salary % | Complete | Missing attendance | Sick rows excluded |
|---|---:|---:|---:|---|---:|---:|
| Today | 0.00 | 0.00 | — | Yes | 0 | 0 |
| Yesterday | 17,897.91 | 77,479.20 | 23.10% | Yes | 0 | 0 |
| This Week | 52,233.95 | 221,764.12 | 23.55% | Yes | 0 | 1 |
| Last Week | Unavailable | 581,817.76 | — | No | 1 | 0 |
| September 22 | 16,965.60 | 75,971.64 | 22.33% | Yes | 0 | 1 |
| September to cutoff | Unavailable | Not fetched | — | No | 1 | 1 |
| August | Unavailable | Not fetched | — | No | 8 | 0 |
| 14:32 replay | 6,141.07 | 23,436.96 | 26.20% | Yes | 0 | 0 |

August and September-to-cutoff chain percentages are withheld because attendance is incomplete; no chain percentage was inferred from the supported store subset. Revenue was independently fetched for the four dashboard comparison periods, the September 22 case and the 14:32 replay, filtered to the same Copenhagen cutoff before computing each ratio.

### Store totals and percentages

Each cell is `salary DKK / salary %`; an em dash means no supported percentage. Incomplete stores have null salary and component values in the API; the app does not display a supported subtotal as a complete cost.

| Period | Vesterbro | Indre By | Nørrebro | Frederiksberg | Fisketorvet | Christianshavn |
|---|---:|---:|---:|---:|---:|---:|
| Today | 0.00 / — | 0.00 / — | 0.00 / — | 0.00 / — | 0.00 / — | 0.00 / — |
| Yesterday | 2,202.50 / 25.16% | 3,584.34 / 23.01% | 2,492.44 / 20.47% | 2,555.00 / 19.93% | 3,105.00 / 21.11% | 3,958.63 / 29.45% |
| This Week | 6,735.92 / 29.43% | 9,941.25 / 21.73% | 7,481.98 / 23.81% | 7,717.81 / 21.31% | 9,456.17 / 22.28% | 10,900.82 / 25.32% |
| Last Week | 17,525.42 / 25.11% | 28,733.37 / 24.20% | Unavailable / — | 21,079.06 / 22.55% | 27,540.42 / 23.15% | 28,180.48 / 25.80% |
| September 22 | 2,293.75 / 29.72% | 3,035.33 / 19.55% | 2,486.42 / 20.01% | 2,486.98 / 20.75% | 3,315.33 / 23.59% | 3,347.79 / 23.46% |
| September to cutoff | 56,373.94 / — | 94,694.84 / — | Unavailable / — | 68,096.48 / — | 89,669.50 / — | 87,301.06 / — |
| August | 74,241.85 / — | Unavailable / — | Unavailable / — | Unavailable / — | 136,444.55 / — | Unavailable / — |
| 14:32 replay | 747.00 / 45.13% | 1,275.02 / 26.65% | 976.48 / 23.05% | 939.18 / 22.75% | 888.14 / 17.86% | 1,315.25 / 35.91% |

### Exact remaining coverage gate

| Period / affected store(s) | Evidence | Result / owner |
|---|---|---|
| Last Week and September-to-cutoff: Nørrebro | 1 required central-worker store shift, 0 matched punches | Store and chain null with `ACTUAL_HOURS_MISSING`; Planday administrator resolves attendance. |
| August: Christianshavn | Home-manager denominator has 1 missing punch; central store work has another missing punch | Store and chain null; administrator resolves both sources. |
| August: Indre By | Home-manager denominator has 5 missing punches; regional denominator also incomplete | Store and chain null; administrator resolves monthly attendance. |
| August: Nørrebro, Frederiksberg and Indre By | Regional monthly denominator has 1 missing punch, including outside scope | Its full allocation stays incomplete; outside gaps cannot inflate supported store shares. |
| September 22: Christianshavn | 1 identified sick-leave schedule row, no monetary Payroll or Time & Cost amount | Nonblocking warning; zero unsupported contribution. No remaining allocation decision. |

Counts repeated across regional store rows are the same denominator gap, not additional missing records. August's distinct missing total is eight. Vesterbro and Fisketorvet retain supported August costs; they do not make the chain complete.

The full-month loader verified all required shift details and clock-break response counts. September fetched 48 relevant punch records and August 49 including the separate lookback day; the August in-month qualifying match count is 48. No recorded clock breaks were returned in either inspected salary-worker set, and their 76 September / 66 August monetary shift rows contained no manual breaks. Punched and approved/scheduled timestamps differed on 31 fetched records in September and 32 in August, confirming why approved schedule times cannot substitute for actual punches. Missing scheduled Office work is not silently assumed to have been clocked. The active scheduled month remains an estimate even when many earlier shifts are already approved.

## Privacy, configuration and API

`lib/planday-worker-rules.json` contains only domain-separated HMAC-SHA256 tokens, effective dates and generic policy types/target departments. The existing environment-backed server session secret keys the digest; no secret or raw identifier is copied into the registry. A keyed check tag detects secret rotation/mismatch and fails closed with `WORKER_RULE_CONFIGURATION`. Rotation would require a separately authorized private remapping; no credential/configuration change was made for this work.

The server maps identities only in memory. It constructs browser output from an allowlist: store/chain costs, components, provenance, safe reasons, six aggregate attendance/sickness coverage counts, period/cutoff and cache age. It never spreads upstream objects, policy tokens, personal fields, rates, individual salaries or shifts into responses. Error paths return only safe codes. Live privacy scanning covers changed/untracked PR files against inspected employee IDs, the six private profile names/emails and credential values, reporting only match counts.

Complete results cache for at most 10 minutes while the salary calendar month remains active, including completed day/week requests. Completed calendar months cache for at most six hours. Server/browser caches expire at month transition so scheduled weights cannot survive as final actuals. Incomplete values are never cached as successes. Cache capacity remains 64 results and 16 pending requests, with same-key coalescing.

## Validation and performance

- Full regression suite: **947 tests, 129 suites, all passing**; includes the previous 901 tests and focused confirmed-policy, attendance, absence, overlap, key-mismatch and month-transition cases. Fixtures use synthetic identities only.
- Conservation tests cover home-store Office hours, regional outside shares, separate months/rate changes, overnight splits and additive rounding. Central tests cover actual 225/hour, in-progress cutoffs, breaks, future/outside exclusion, stale/missing/unapproved punches and overtime past a scheduled end.
- Absence tests prove Payroll precedence, Time & Cost monetary fallback, authoritative zero amounts, nonblocking schedule-only exclusion, local warnings and fail-closed unclassified work.
- Seven browser security checks pass. Local Chromium in America/Los_Angeles confirms Copenhagen cutoff display, progressive revenue loading, card/sidebar/store agreement, failure/retry, genuine zero and no page errors. Screenshots contain synthetic data only and are not committed.
- Synthetic benchmark: 4,464 aggregate records, median **2.00 ms**, p95 **9.46 ms**; 20 same-key callers coalesce into four legacy-source calls, warm response **0.13 ms**. Full actual attendance normalization for a synthetic 31-shift salary month: median **20.98 ms**, p95 **35.89 ms**.
- Live audit cold salary/attendance source loading was about **21 seconds** for September and **18 seconds** for August; repeated period checks reused request-local diagnostic responses. These are measured remote costs, not the synthetic four-call benchmark. Raw diagnostic responses were not persisted.
- Security scanner, JavaScript syntax checks, inline-script parse and `git diff --check` pass. Live scan found **zero employee-ID, name/email or credential matches**, and no sensitive public response fields.

## Release checklist

Implementation, regression tests, privacy checks and supported active-period reconciliations are complete. Before a future ready-for-review/merge/deploy decision, obtain authoritative coverage for the September central shift and eight August gaps; verify each completed manager month conserves its actual agreement amount including outside shares; repeat store/chain and aligned-revenue checks. This PR intentionally remains draft until that gate passes.
