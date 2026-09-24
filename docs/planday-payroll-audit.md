# Planday payroll audit

Updated 2026-09-24 for PR #6, branch `fix/planday-payroll-accuracy`, following `b9face3`. Baseline main remains `29ed320`. This report includes the home-store calendar fallback and supersedes the former actual-attendance-only release gate. No merge, deployment, production data change or credential change was performed.

## Home-store calendar fallback

The two confirmed home-store policies allocate their complete authoritative monthly salaries to Christianshavn and Indre By. Approved punches and valid scheduled fallback remain proportional date weights when the monthly hour coverage is reliable; salary is never priced at an hourly rate. A sparse but complete usable schedule remains eligible for hour weighting.

With no usable monthly hours, or demonstrably incomplete/unreliable monthly coverage, salary instead uses equal calendar-date weights: **monthly salary ÷ calendar days in the Copenhagen month**. Weekends, leap days and DST dates are included equally. A failed/truncated monthly schedule fetch, known Payroll or punch shifts absent from the schedule, or invalid/conflicting hour evidence establishes unreliable coverage. Verified monetary salary and home-policy identity remain required; those cannot be invented by fallback.

For partial or active periods, only dates intersecting the requested interval before the exclusive Copenhagen cutoff contribute. An intraday cutoff includes the current date's full daily share; exact midnight excludes the new date. No future date contributes, and there is no hourly pricing within a calendar day. Cumulative monthly proportions round to integer øre at period boundaries, conserving complete months and adjacent period totals. Internal daily records put each requested slice's residual rounding øre on its final included date.

Store and chain responses expose only the aggregate **`calendarFallbackDays`**, alongside existing aggregate fields, with **`estimated: true`** and safe **`CALENDAR_SALARY_FALLBACK`** provenance. This count sums salary-allocation dates: the two home salaries over a complete 31-day month contribute 62 chain allocation days. It creates no worked hours, individual shifts or hourly costs. The UI retains the percentage and says **“Includes calendar-day salary estimates”**.

The regional location-based salary and all three excluded central monthly salaries are ineligible for calendar fallback. Absence schedules still cannot become worked hours or central 225/hour costs. When a home month contains only absence schedules, its independently owed monthly salary uses calendar weights without inventing absence pay.

Synthetic regression coverage includes 28/29/30/31-day months, weekends, both home assignments together and separately, intraday/exact-midnight cutoffs, 23/25-hour DST dates, adjacent periods, month boundaries, precise rounding, incomplete-source recovery, sparse usable hours, aggregate privacy and exclusion of the other policies. The period tables below retain their explicitly dated live capture; they are not synthetic calendar-fallback examples. A fresh read-only check at 2026-09-24T08:48:39.256Z confirms August and September-to-cutoff remain complete, conserve the 100,600 DKK monthly manager pool, and use zero calendar fallback days because their existing hour coverage is usable. August retains the same 658,877.78 DKK chain cost. No live missing-hour month was fabricated; calendar fallback is exercised with synthetic data.

## Result

**Reconciliation passes under the authorized punch-first / valid-schedule fallback rule.** All six stores and the chain are supported for Today, Yesterday, This Week, Last Week, September-to-cutoff and August. There are **zero remaining genuinely unavailable records** in these captures. Results containing fallback remain explicitly estimated.

The previous one September and eight August missing-punch records no longer block their periods. Valid schedules now supply the affected working hours. In August, all three salaried-manager allocations conserve their complete agreements: **100,600.00 DKK** across all destinations, **87,600.84 DKK** in the six stores and **12,999.16 DKK** outside. The corresponding September full-month model conserves **100,600.00 DKK**, with **92,551.56 DKK** in stores and **8,048.44 DKK** outside. These conservation amounts are monthly model checks, not the period KPI.

The three central salaries, together **97,500.00 DKK/month**, remain excluded. Approved punched store hours, or valid scheduled fallback hours, contribute at the authorized shared **225 DKK/hour**. All outside central work remains excluded.

September 22's schedule-only sick leave still contributes **0 DKK**, with a local `SICK_LEAVE_WITHOUT_MONETARY_PAY` warning. The unsupported **591.71 DKK is not added**. The known absence does not invalidate supported Christianshavn or chain costs.

## Calculation hierarchy and provenance

For each ordinary working shift:

1. Use complete approved punch start/end timestamps and complete recorded break coverage, subtracting the recorded breaks.
2. If punches are absent, open, unapproved, malformed/incomplete, or cannot establish complete break coverage, use the corresponding trustworthy scheduled interval.
3. Without either source, working hours remain unverified. Central/regional policies retain their specific fail-closed reason; verified home-store salaries use the separate calendar fallback above when monthly hour weights are unreliable.

A fallback schedule must identify its employee and a verified department, have a valid Copenhagen date/start/end, positive duration, a valid working status, and consistent identity/duplicate/overlap evidence. Valid statuses include Assigned, Approved, ForSale, OnDuty, PendingSwapAcceptance, PendingApproval and the Punchclock working equivalents. Open/Draft/Cancelled/Deleted records do not supply fallback work. Unknown statuses and unknown shift-type classifications cannot silently become ordinary work.

Complete approved punches take precedence even when a scheduled timestamp is incomplete, and approved overtime can cross a scheduled end or month boundary. An open punch now uses the verified scheduled fallback; it is not described as approved actual work. Both selected sources are clipped at the requested Copenhagen cutoff, excluding all future numerator hours.

The same hierarchy now forms each manager's monthly denominator, including in an active month: approved completed punches replace the corresponding scheduled hours; remaining valid schedules, including future planned shifts, supply the rest of the denominator. The period numerator uses only overlapping selected hours through the cutoff. Future schedule hours never enter the numerator or reported period hours. Active months remain estimated; completed mixed months are supported estimates, not unavailable. A fully approved completed month can be actual, subject to other cost components' provenance.

### Aggregate fields

Each store and the chain expose only:

- `actualHours`: approved punched working hours overlapping the requested period.
- `scheduledFallbackHours`: substituted schedule hours overlapping the requested period.
- `scheduledFallbackShifts`: distinct fallback shifts contributing positive hours in that period.
- `calendarFallbackDays`: included salary-allocation dates under the home-store calendar fallback.
- `estimated`: true when fallback affects the result or another supported cost component is estimated.

These counts cover ordinary hourly work and the central/manager hour inputs. Home-manager Office hours are attributed to the home store; regional outside hours are omitted from chain period hours along with their cost. Hours are unioned per worker before aggregating. A shift crossing midnight can contribute to both days but is counted once in a multi-day period. No individual keys are exposed.

A fallback outside the requested period, or in an outside department, can affect a monthly denominator. Its affected store results are therefore estimated even when that store's period fallback-hour count is zero. The API's older `coverage.attendanceMissing/Unapproved/Invalid` counts describe source quality over the fetched denominator coverage; they are **not counts of unavailable contributions** after fallback. The tables below show period hours and genuinely unavailable contributions separately.

Ordinary hourly **money** remains the authoritative Payroll amount; the new hours metadata does not multiply that amount by hours or replace it with an invented hourly rate. The existing verified partial-shift monetary clipping is preserved. Central and salaried costs use the selected hour intervals directly under their explicit policies. Signed adjustments remain counted once under the documented elapsed-shift allocation estimate.

The UI displays supported percentages normally and adds **“Includes scheduled-hour estimates”** to affected results. It does not label fallback as approved actual. A complete cost with zero/nonpositive revenue has no percentage; an unavailable cost remains null with a safe reason.

## Confirmed salary scope and conservation

| Deidentified policy | Effective date/scope | Allocation |
|---|---|---|
| Central C1 | 2026-01-01 onward while salaried | Monthly salary excluded; selected six-store work at 225/hour; outside excluded |
| Central C2 | 2026-02-01 onward while salaried | Same rule |
| Third central policy | Every supported salaried-agreement period | Same rule; supersedes former explicit Indre By salary allocation |
| Christianshavn home policy | 2025-11-01 onward | Entire monthly salary stays in Christianshavn; Office hours affect daily weights |
| Regional store policy | 2025-11-01 onward | Full monthly denominator includes all verified departments; outside shares stay outside |
| Indre By home policy | 2026-04-01 onward | Entire monthly salary stays in Indre By; Office hours affect daily weights |

Monthly money comes from complete per-calendar-month Payroll documents. Daily/interval cost is the monthly amount multiplied by the interval's qualifying hours divided by the full month's qualifying hours. Same-destination overlaps are unioned, with approved actual coverage taking precedence over overlapping fallback coverage. Cross-department ambiguity and conflicting duplicates fail closed.

Chronological cumulative integer øre differences conserve the salary exactly across days and all destinations; the final interval absorbs only the residual rounding øre. Splitting at Copenhagen midnight and at a requested cutoff preserves adjacent-period additivity. Outside intervals advance the denominator/allocation and are then excluded from dashboard totals, never redistributed.

Known sickness/absence is excluded before working-hour selection. Sickness may contribute only an authoritative Payroll amount or a matching Time & Cost amount when Payroll is absent. There is no sickness × 225 calculation, no fallback hourly sickness wage and no sickness-hour salaried allocation. Unknown types remain unclassified instead of being presumed ordinary work.

## Sources, privacy and operating limits

Authoritative reference documentation checked alongside live payloads:

- [Payroll guide](https://developer.planday.com/guides/payroll-guide/) and [Payroll schema](https://openapi.planday.com/payroll/swagger/v1.0/swagger.json): top-level monetary shift/salary/adjustment arrays and signed DKK amounts.
- [Time clock guide](https://developer.planday.com/guides/timeclock-guide/) and [Punch Clock schema](https://openapi.planday.com/punchclock/swagger/v1.0/swagger.json): actual `startDateTime`, `endDateTime`, `isApproved` and recorded breaks; separately approved/scheduled `shiftStartDateTime/shiftEndDateTime` are not punch substitutes.
- [Scheduling schema](https://openapi.planday.com/scheduling/swagger/v1.0/swagger.json): list and detail both use `GetShiftOutputModel`, including nullable `shiftTypeId`, date, status, department and Copenhagen interval. Live September 22 list inspection confirmed its sickness type is present; normal rows omit the nullable field. The loader can therefore project classification from complete list pages without a separate request per shift.
- [Time & Cost guide](https://developer.planday.com/guides/timeandcost-guide/): exact server-only shift/employee/type/date matching for monetary sickness fallback; no addition over Payroll.
- [Pay schema](https://openapi.planday.com/pay/swagger/v1.0/swagger.json), [HR schema](https://openapi.planday.com/hr/swagger/v1.0/swagger.json) and [rate limits](https://developer.planday.com/gettingstarted/rate-limiting/).

The six mappings remain 148561→Vesterbro, 149668→Indre By, 149700→Nørrebro, 149715→Frederiksberg, 149725→Fisketorvet and 149748→Christianshavn. Verified outside departments are Parken B/C, Festival and Office. Additional outside destinations must exist in the complete provider inventory; unknown department IDs fail closed. Broad current HR membership is never a salary scope rule.

Punch Clock ranges are limited to calendar-month requests plus a separate preceding-day lookup for overnight work, respecting the live 31-day bound. Complete pagination totals/offsets and break totals are validated. Working-hour provenance now covers ordinary hourly workers as well as the six salary policies, so it requires more break reads. Secondary calls remain bounded, API starts are paced at 100 ms, and a 429 retry respects a bounded provider reset delay. No raw provider error is returned or logged.

Raw provider data remains request-local. The policy registry contains only domain-separated keyed irreversible tokens, generic policy types, dates and target departments. No identity or credential configuration changed in this follow-up. A secret mismatch still fails closed. Source/tests/audit/PR/API contain no worker names, raw employee identifiers, personal job titles or contact information. Success/error output is constructed from an aggregate allowlist; individual rates, salaries, shifts and policy tokens are excluded.

Cache limits remain 64 results / 16 pending requests with same-key coalescing. Active salary months, including completed days/weeks inside them, use at most a 10-minute TTL; completed calendar months use at most six hours. Month transition invalidates cached estimates. Incomplete results are not cached as success. New approved punches replace schedule fallback on the next successful refresh; no background production mutation is performed.

## Live reconciliation

Capture: **2026-09-24T08:08:33.425Z**. Active cutoff: **2026-09-24 09:51:00 Europe/Copenhagen (07:51:00Z)**. Yesterday is September 23; This Week starts September 21; Last Week is September 14–20. September-to-cutoff starts September 1; August is the complete August calendar month. End dates are exclusive. The extra 14:32 replay is September 23. Provider records are editable, so these are calculation captures rather than a frozen payroll ledger.

All requested store/chain results are complete and estimated. Today has labour cost but zero recorded sales at the cutoff, so its percentage is correctly undefined. Revenue ex VAT was fetched for **all** reported periods/stores and filtered to the identical Copenhagen cutoff. Percentages use chain cost divided by summed aligned revenue, never an average of store percentages.

Hours below are rounded to two decimals for display; the engine retains interval precision. “Unavailable” counts refer to failed contributions, not resolved missing punches.

| Period | Chain cost DKK | Revenue ex VAT DKK | Salary % | Approved punch h | Fallback h | Fallback shifts | Status | Unavailable |
|---|---:|---:|---:|---:|---:|---:|---|---:|
| Today | 991.69 | 0.00 | — | 0.00 | 6.10 | 6 | Estimated | 0 |
| Yesterday | 18,035.73 | 77,479.20 | 23.28% | 50.87 | 78.00 | 14 | Estimated | 0 |
| This Week | 53,664.03 | 221,764.12 | 24.20% | 286.28 | 92.83 | 21 | Estimated | 0 |
| Last Week | 142,350.66 | 581,817.76 | 24.47% | 1,034.07 | 11.08 | 4 | Estimated | 0 |
| September 22 | 17,101.91 | 75,971.64 | 22.51% | 110.83 | 8.73 | 1 | Estimated | 0 |
| September to cutoff | 459,518.20 | 1,923,295.44 | 23.89% | 3,135.33 | 144.88 | 35 | Estimated | 0 |
| August | 658,877.78 | 2,820,339.66 | 23.36% | 4,471.97 | 180.47 | 32 | Estimated | 0 |
| 14:32 replay | 6,123.51 | 23,436.96 | 26.13% | 20.50 | 18.23 | 8 | Estimated | 0 |

### Today: store reconciliation

| Store | Cost DKK | Revenue ex VAT DKK | Salary % | Approved punch h | Fallback h | Fallback shifts | Status | Unavailable |
|---|---:|---:|---:|---:|---:|---:|---|---:|
| Vesterbro | 110.50 | 0.00 | — | 0.00 | 0.85 | 1 | Estimated | 0 |
| Indre By | 161.85 | 0.00 | — | 0.00 | 0.85 | 1 | Estimated | 0 |
| Nørrebro | 153.75 | 0.00 | — | 0.00 | 0.85 | 1 | Estimated | 0 |
| Frederiksberg | 148.75 | 0.00 | — | 0.00 | 0.85 | 1 | Estimated | 0 |
| Fisketorvet | 225.20 | 0.00 | — | 0.00 | 1.35 | 1 | Estimated | 0 |
| Christianshavn | 191.64 | 0.00 | — | 0.00 | 1.35 | 1 | Estimated | 0 |

### Yesterday: store reconciliation

| Store | Cost DKK | Revenue ex VAT DKK | Salary % | Approved punch h | Fallback h | Fallback shifts | Status | Unavailable |
|---|---:|---:|---:|---:|---:|---:|---|---:|
| Vesterbro | 2,202.50 | 8,755.36 | 25.16% | 0.00 | 17.00 | 3 | Estimated | 0 |
| Indre By | 3,664.34 | 15,575.20 | 23.53% | 23.47 | 1.50 | 1 | Estimated | 0 |
| Nørrebro | 2,486.76 | 12,178.24 | 20.42% | 7.40 | 9.50 | 2 | Estimated | 0 |
| Frederiksberg | 2,628.33 | 12,820.00 | 20.50% | 20.00 | 0.00 | 0 | Estimated | 0 |
| Fisketorvet | 3,105.00 | 14,708.48 | 21.11% | 0.00 | 24.00 | 3 | Estimated | 0 |
| Christianshavn | 3,948.80 | 13,441.92 | 29.38% | 0.00 | 26.00 | 5 | Estimated | 0 |

### This Week: store reconciliation

| Store | Cost DKK | Revenue ex VAT DKK | Salary % | Approved punch h | Fallback h | Fallback shifts | Status | Unavailable |
|---|---:|---:|---:|---:|---:|---:|---|---:|
| Vesterbro | 6,846.42 | 22,891.36 | 29.91% | 35.97 | 17.85 | 4 | Estimated | 0 |
| Indre By | 10,216.89 | 45,759.20 | 22.33% | 59.62 | 11.08 | 3 | Estimated | 0 |
| Nørrebro | 7,648.87 | 31,417.88 | 24.35% | 42.20 | 10.35 | 3 | Estimated | 0 |
| Frederiksberg | 8,152.43 | 36,211.60 | 22.51% | 57.70 | 0.85 | 1 | Estimated | 0 |
| Fisketorvet | 9,681.37 | 42,433.36 | 22.82% | 46.30 | 25.35 | 4 | Estimated | 0 |
| Christianshavn | 11,118.05 | 43,050.72 | 25.83% | 44.50 | 27.35 | 6 | Estimated | 0 |

### Last Week: store reconciliation

| Store | Cost DKK | Revenue ex VAT DKK | Salary % | Approved punch h | Fallback h | Fallback shifts | Status | Unavailable |
|---|---:|---:|---:|---:|---:|---:|---|---:|
| Vesterbro | 17,525.42 | 69,793.68 | 25.11% | 131.72 | 0.00 | 0 | Estimated | 0 |
| Indre By | 28,870.86 | 118,747.12 | 24.31% | 197.82 | 1.00 | 1 | Estimated | 0 |
| Nørrebro | 19,211.56 | 71,621.68 | 26.82% | 161.17 | 2.00 | 1 | Estimated | 0 |
| Frederiksberg | 21,064.89 | 93,466.64 | 22.54% | 159.28 | 6.08 | 1 | Estimated | 0 |
| Fisketorvet | 27,540.42 | 118,969.52 | 23.15% | 207.85 | 0.00 | 0 | Estimated | 0 |
| Christianshavn | 28,137.51 | 109,219.12 | 25.76% | 176.23 | 2.00 | 1 | Estimated | 0 |

### September 22: store reconciliation

| Store | Cost DKK | Revenue ex VAT DKK | Salary % | Approved punch h | Fallback h | Fallback shifts | Status | Unavailable |
|---|---:|---:|---:|---:|---:|---:|---|---:|
| Vesterbro | 2,293.75 | 7,719.04 | 29.72% | 17.95 | 0.00 | 0 | Estimated | 0 |
| Indre By | 3,035.33 | 15,523.20 | 19.55% | 13.85 | 8.73 | 1 | Estimated | 0 |
| Nørrebro | 2,486.42 | 12,425.08 | 20.01% | 17.63 | 0.00 | 0 | Estimated | 0 |
| Frederiksberg | 2,578.68 | 11,982.64 | 21.52% | 17.70 | 0.00 | 0 | Estimated | 0 |
| Fisketorvet | 3,315.33 | 14,052.40 | 23.59% | 22.97 | 0.00 | 0 | Estimated | 0 |
| Christianshavn | 3,392.40 | 14,269.28 | 23.77% | 20.73 | 0.00 | 0 | Estimated | 0 |

### September to cutoff: store reconciliation

| Store | Cost DKK | Revenue ex VAT DKK | Salary % | Approved punch h | Fallback h | Fallback shifts | Status | Unavailable |
|---|---:|---:|---:|---:|---:|---:|---|---:|
| Vesterbro | 56,484.44 | 226,077.76 | 24.98% | 412.35 | 17.85 | 4 | Estimated | 0 |
| Indre By | 95,489.42 | 401,455.28 | 23.79% | 613.70 | 26.75 | 8 | Estimated | 0 |
| Nørrebro | 61,636.51 | 241,575.36 | 25.51% | 436.48 | 12.35 | 4 | Estimated | 0 |
| Frederiksberg | 68,497.93 | 301,252.64 | 22.74% | 479.18 | 21.30 | 4 | Estimated | 0 |
| Fisketorvet | 89,894.70 | 397,074.64 | 22.64% | 651.15 | 29.35 | 5 | Estimated | 0 |
| Christianshavn | 87,515.20 | 355,859.76 | 24.59% | 542.47 | 37.28 | 10 | Estimated | 0 |

### August: store reconciliation

| Store | Cost DKK | Revenue ex VAT DKK | Salary % | Approved punch h | Fallback h | Fallback shifts | Status | Unavailable |
|---|---:|---:|---:|---:|---:|---:|---|---:|
| Vesterbro | 74,241.85 | 297,706.72 | 24.94% | 567.70 | 1.50 | 1 | Estimated | 0 |
| Indre By | 139,170.84 | 626,924.40 | 22.20% | 861.38 | 23.40 | 8 | Estimated | 0 |
| Nørrebro | 82,676.38 | 331,155.12 | 24.97% | 598.07 | 4.50 | 1 | Estimated | 0 |
| Frederiksberg | 100,418.17 | 425,491.68 | 23.60% | 603.07 | 97.55 | 12 | Estimated | 0 |
| Fisketorvet | 136,444.55 | 626,039.52 | 21.79% | 1,007.10 | 32.62 | 5 | Estimated | 0 |
| Christianshavn | 125,925.99 | 513,022.22 | 24.55% | 834.65 | 20.90 | 5 | Estimated | 0 |

### 14:32 replay: store reconciliation

| Store | Cost DKK | Revenue ex VAT DKK | Salary % | Approved punch h | Fallback h | Fallback shifts | Status | Unavailable |
|---|---:|---:|---:|---:|---:|---:|---|---:|
| Vesterbro | 747.00 | 1,655.20 | 45.13% | 0.00 | 5.53 | 1 | Estimated | 0 |
| Indre By | 1,275.13 | 4,784.00 | 26.65% | 9.20 | 0.03 | 1 | Estimated | 0 |
| Nørrebro | 972.32 | 4,235.52 | 22.96% | 5.43 | 0.00 | 0 | Estimated | 0 |
| Frederiksberg | 933.44 | 4,128.16 | 22.61% | 5.87 | 0.00 | 0 | Estimated | 0 |
| Fisketorvet | 888.14 | 4,971.68 | 17.86% | 0.00 | 6.57 | 2 | Estimated | 0 |
| Christianshavn | 1,307.48 | 3,662.40 | 35.70% | 0.00 | 6.10 | 4 | Estimated | 0 |

The nine previously blocking missing-punch cases are resolved by this rule. The wider aggregate fallback counts also include ordinary hourly shifts and unapproved/incomplete punches; they are not additional release blockers. The September 22 unsupported sickness row remains a nonblocking excluded contribution and is not included in working-hour fallback totals.

## Validation and review gate

- Clean isolated `npm ci`: 95 packages installed, 96 audited, zero vulnerabilities. No dependency or credential changes.
- Full regression suite: **1,003 tests / 129 suites pass**, including approved-punch precedence, missing/unapproved/open/malformed-punch fallback, complete monthly conservation, valid status/identity/date checks, future/cutoff clipping, central 225/hour, outside exclusion, denominator-only estimation, duplicate/overlap handling, month-crossing overtime, sickness/other absence exclusion and aggregate privacy.
- Seven browser security checks pass. Local Chromium in America/Los_Angeles confirms Copenhagen cutoff labels, progressive revenue loading, consistent card/sidebar/store percentages, fallback estimate wording, retry and genuine zero; no page errors. Only synthetic screenshot data was used.
- Aggregate-only privacy scanning finds zero raw employee identifiers, private names/emails or credentials in changed files. API allowlist tests include the new hours/count/estimated fields. Syntax/inline-script parsing and whitespace checks pass.
- Synthetic benchmark: 4,464 aggregate records at about **2.15 ms median / 8.10 ms p95**; a 31-shift approved-clock month normalizes in about **20.88 ms median / 23.14 ms p95**. Same-key coalescing and warm-cache behavior remain verified.
- Live diagnostic source timings: about **16 seconds** for the first September day, **29 seconds** of additional reads for September-to-cutoff and **72 seconds** for August. The audit reused raw responses in memory across its period checks; these timings are not independent cold-request guarantees. More ordinary-hourly break coverage is the main additional remote cost. Raw responses were not persisted.

All six requested periods and the supplemental sick-leave/cutoff replays reconcile with **zero remaining unavailable contributions**. The former attendance-only gate is removed by the authorized fallback policy. PR #6 remains ready for review after the verified follow-up is pushed. This is not authorization to merge or deploy; neither action is performed.
