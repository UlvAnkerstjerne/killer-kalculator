# Planday payroll audit

Audit date: 2026-09-23. Baseline: `origin/main` at `29ed320` (includes the merged sales cache budget PR #5). No production deployment or merge was performed. All live provider access was read-only, apart from the existing OAuth token exchange. No credentials, employee identifiers, names, raw shifts, or raw responses were written to this repository.

## Outcome and deployment gate

The old amount is not a reliable wage total. Live Payroll uses a different envelope than the old parser expects, so the supposed salaried/hourly hybrid actually uses scheduled hours at a universal 160 DKK/hour. It also includes future work in active-period comparisons.

The replacement reads the real Payroll schema, aligns costs and the salary denominator to a shared cutoff, distinguishes approved actual/scheduled/estimated amounts, and returns null with `complete:false` on unresolved coverage. It removes the flat-rate fallback entirely.

**The live configuration does not currently support a complete six-store payroll total.** Unallocated salaries, departments outside the verified six-store mapping, and a scheduled shift missing from payroll were observed. The safest business decision is to retain these failures as unavailable totals. Do not present the allocatable subtotals below as a finished payroll calculation. The PR is reviewable, but production salary availability requires the manual mapping/allocation checks at the end of this report.

## Previous implementation, traced from fields and arithmetic

`getPlandayToken` exchanged `PLANDAY_APP_ID` and `PLANDAY_REFRESH_TOKEN`, cached the access token until 60 seconds before expiry, and did not coalesce refreshes or retry a rejected token. `plandayGetAll` used offset/limit=100 and stopped when `offset >= (paging.total ?? 0)`. A missing total therefore silently truncated the result after the first page. Empty intermediate pages also counted as success.

`fetchPayrollByStore` concurrently requested `/payroll/v1/payroll?departmentIds=…&from=…&to=…` and `/scheduling/v1/shifts?from=…&to=…`. It read `payrollRes.data.data || []`. The live response instead has top-level `shiftsPayroll`, `supplementsPayroll`, and `salariedPayroll`. Consequently no payroll rows reached its employee-cost map.

The intended but ineffective hybrid was:

```
employee cost = first matching guessed monetary field summed over payroll rows,
                otherwise sum(full scheduled shift duration) × 160 DKK/hour
store share = employee cost × that store's scheduled hours / all employee hours
store total = round(sum(store shares)) to whole DKK
```

The effective live formula is `round(sum(mapped assigned shift duration × 160))` per store. Only employees with shifts enter the primary loop. Employees without shifts disappear. There is no pay-rate endpoint, date-effective rate application, break deduction, supplement processing, approval check, paid-absence check, cancellation check, ID deduplication, or clipping to the requested instants. Open shifts normally lack an employee and are skipped in the primary path; the error fallback does not perform that employee check. Unknown departments disappear. Invalid/missing times become zero hours. Salaried employees with zero hourly wages are still priced at 160.

On any primary error, the route fetched shifts again and rounded each `hours × 160` before summing. The two branches had different rounding. Token acquisition was outside the route's try/catch. The final fallback returned `err.message` and `err.response.data` and logged a raw error message, creating a PII/credential exposure path. No diagnostic route was restored in this change.

The browser converted browser-local Unix period boundaries into Copenhagen dates, then discarded the time of day. Provider date endpoints use inclusive end dates, so today's entire schedule was returned. Current sales were partial-day snapshots. The browser cached failures as `{}` indefinitely, used `salary || null` for genuine zero, and summed missing stores as zero for the chain. The sidebar waited for Planday before rendering. Graphs fetched entire week/month buckets even when the selected range covered only part of a bucket. Salary columns, cards and sidebar each had their own formula.

## Sources inspected and live evidence

Official references, checked against live responses:

- [Payroll schema](https://openapi.planday.com/payroll/swagger/v1.0/swagger.json) and [Payroll integration guide](https://developer.planday.com/guides/payroll-guide/).
- [Scheduling schema](https://openapi.planday.com/scheduling/swagger/v1.0/swagger.json) and [Time & Cost guide](https://developer.planday.com/guides/timeandcost-guide/).
- [Pay schema](https://openapi.planday.com/pay/swagger/v1.0/swagger.json) and [salary allocation settings](https://help.planday.com/en/articles/30526-how-to-view-the-payroll-costs-of-salaried-staff-in-the-schedule).
- [Punch Clock guide](https://developer.planday.com/guides/timeclock-guide/).

| Source | Observation / use |
|---|---|
| POST `id.planday.com/connect/token` | Existing refresh-token integration works. Credentials remain in memory. |
| GET `/hr/v1/departments` | Paginated; 10 departments, six verified dashboard mappings. No name-based guessing. |
| GET `/scheduling/v1/shifts` | Paginated; local Copenhagen timestamps have **minute precision**, plus an explicit `timeZone`. Used for coverage, statuses, and documented shared allocation. |
| GET `/payroll/v1/payroll` | Unpaged top-level object. Inclusive `from`/`to`; `returnFullSalaryForMonthlyPaid:false` verified against day/week/month amounts. Main monetary source. |
| Same Payroll request with `shiftStatus=Approved` | Verified approved subset, including identical shift costs. Yesterday has unapproved records; all last-week payroll shifts were approved. Salaried records remain in approved responses, so their presence does not establish worked/approved store allocation. |
| GET `/scheduling/v1/timeandcost/{departmentId}` | All six succeed. Scheduled allocated cost, not proof of actual work. Excludes some supplement categories and can include configured extra payroll overhead. Diagnostic comparison only. |
| GET `/pay/v1/salaries/scheduling/timeandcost/allocations/{employeeId}/history` | Live envelope is `{data:[…]}`. Six salaried workers: BusinessDays=1, NoAllocation=2, ScheduledHours=2, MonthlySalary=1. Historical effective dates are used; no employee objects are returned publicly. |
| GET `/pay/v1/payrates/employeeGroups/{group}/employees/{employee}/history` | Read successfully for a representative hourly worker; two historical rate records. Main calculation uses the rate/amount already resolved by Payroll for the shift rather than today's rate. |
| GET `/punchclock/v1/punchclockshifts` | Read succeeded but returned no records for the completed-day probe. This does not mean nobody worked. Punch-clock naming alone is not used as evidence of actual pay. |

One completed day, Today, current/completed weeks, and August were inspected across all six stores. August Payroll contains 638 shift records, 483 non-shift adjustment records, and six salary records. The completed month reports 587,200.42 DKK shift payroll, 198,100.00 DKK salaries and −16,905.00 DKK adjustments before store reconciliation.

For September 1–23, 440 shift-payroll records had no nested breaks or shift supplements; sum of `salary − elapsed hours × wage.rate` was approximately 0.000000000014 DKK. No overnight payroll shifts appeared in that sample. Breaks, overnight work, DST ambiguity and mid-shift rate changes therefore have synthetic coverage, not a claimed live reconciliation. Nested upstream break/supplement records fail closed until their arithmetic is verified. Negative **period** adjustments were observed and are retained.

## Relevant fields

| Field | Meaning / handling |
|---|---|
| `shiftsPayroll[].id` | Stable shift identity, private deduplication and matching only. Conflicts invalidate totals. |
| `salary` on a shift | Provider-calculated monetary amount. Live normal hourly rows reconcile to their rate and duration. Never choose among guessed amount aliases. |
| `wage.rate`, `wage.type` | Resolved shift wage and Hourly/Shift type. An elapsed hourly reconstruction is allowed only when it reconciles to the full amount. Null pay data is unavailable; explicit authoritative zero is distinct. |
| `start`, `end` on payroll shifts | Copenhagen wall-clock datetimes, seconds present in live payloads. Offset-bearing times are supported. Ambiguous/nonexistent offset-free DST times fail closed. |
| `startDateTime`, `endDateTime`, `timeZone` | Scheduled interval (minute precision accepted) and zone. Do not parse in the host or browser timezone. |
| `departmentId` | Exact store mapping; not inferred from employee names, memberships or substrings. |
| `breaks`, nested `supplements` | Absent in inspected live rows. No assumed break duration or supplement double-counting. Nonempty upstream arrays currently make the affected source unavailable. The pure module supports verified normalized paid/unpaid break windows and rate segments. |
| `supplementsPayroll[].salary` | Signed non-shift amount. Live daily records span local midnight to the next midnight and lack a department. Never discard the negative sign. |
| `salariedPayroll[].salary`, `start`, `end` | Monetary amount for the inclusive calendar-date interval, not an hourly rate. A one-day query returns 6,603.33 DKK total salaries; a three-day query 19,810.00. Never multiply by contracted hours or by store count. |
| Allocation `validFrom`, `validTo` | Effective dates. Latest applicable history wins; conflicting same-date history is unavailable. |
| `departmentDistributions` | Explicit targets and weights. Live BusinessDays has a zero `departmentWeight` and positive weekday weights, so weekday weights supply relative sharing. |
| `paging.offset`, `paging.total` | Checked on every page. Missing/changing totals, repeated offsets, truncated pages, or bounds exhaustion are failures. |

## Final payroll model

Public API: `GET /api/planday/salaries/:start/:end?cutoff=<ISO instant>&store=<optional valid store>`.

**API end is now exclusive.** The updated browser sends Copenhagen ISO calendar dates. Start/end validity, ordering, 366-day maximum, cutoff validity/future bounds, store selectors and unexpected query parameters are validated before provider work. Existing session authentication remains required; GET is still exempt from CSRF and existing mutating routes retain their CSRF checks. `Cache-Control: no-store` protects browser HTTP storage.

The service fetches Payroll with and without approval filtering, all required schedule pages and departments. It includes the preceding start date to catch ordinary overnight shifts, converting the exclusive end/cutoff to Planday's inclusive final date. Salary allocation histories are fetched in batches of three. No pay data is fetched per hourly worker in normal dashboard use.

```
store cost = sum(hourly + allocated salaried + supplements + signed adjustments)
             for [Copenhagen start, min(exclusive end, effective cutoff))
store percentage = complete store cost / aligned store revenue excluding VAT × 100
chain percentage = sum(all six complete costs) / sum(their aligned revenue excluding VAT) × 100
```

There is no VAT adjustment to wages. Nonpositive revenue leaves the percentage unavailable. A complete zero cost produces 0% against positive revenue. Any required store failure leaves chain cost null and `complete:false`.

### Provenance

- **Actual / Approved actual:** provider-calculated shift cost also present, unchanged, in the approved Payroll response, wholly inside the interval. It means approved paid cost, including qualifying approved paid absence if the provider supplies it; it is not inferred from a scheduled timestamp.
- **Scheduled estimate:** unapproved provider payroll shift cost. It is never called actual.
- **Estimated allocation:** a clipped/reconstructed shift or allocated salary/period adjustment. A mixed store/chain takes the least authoritative applicable classification. Future shifts do not contribute.
- **Unavailable:** failed/missing source, mapping, unresolved salary, conflicting duplicate, unverified arithmetic, or unsupported cutoff. Cost/components are null, with allowlisted reason codes only.

### Hourly and cutoff rules

Completed verified ordinary shifts use Payroll's `salary` directly. For a clipped hourly interval, use its resolved rate only if the complete rate/duration calculation agrees with the provider amount within 0.011 DKK. Otherwise the cutoff fails closed. A per-shift lump amount is not automatically prorated. No 160 DKK/hour fallback exists. Date-effective hourly reconstruction is supported by normalized rate segments, while the live adapter relies on Payroll's already effective shift rate.

### Salaried allocation and explicit estimates

The provider's period salary is counted **once**. Salary identities are deduplicated by employee, salary code and interval internally; conflicting amounts invalidate totals. The period amount is spread across calendar days, conserving øre, and today's accrual stops at the elapsed fraction of the Copenhagen day (23/25-hour DST days included). This is an **estimate of accrual**, not approved worked wages.

For each day, use effective explicit department weights (or configured weekday weights when the general weight is zero). Otherwise preserve the old code's documented proportional-shift-hours allocation over the salary interval. This fallback is explicitly estimated. The NoAllocation setting does **not** mean a real salary is zero. A salary with neither a configured target nor a usable shift allocation makes the overall result incomplete. No invented 160.33-hour divisor, employee-name mapping, equal split among stores, or guessed head-office exclusion is used.

Using calendar accrual from Payroll with relative configured department weights is not the same as reproducing Planday's schedule-cost business-day/hour allocation. It preserves payroll's period amount and is labelled estimated. This business choice must be reviewed before deployment. Shift-based shares can depend on the requested period; users should not treat them as an immutable monthly accounting allocation.

### Period adjustments, breaks and absence

Observed daily signed adjustments are allocated proportionally to the same worker's overlapping paid/scheduled shifts that day and accrued only over elapsed portions of those shifts. The allocation and trigger timing are expressly estimated. Non-daily or unallocatable adjustments fail closed. Equal-valued period adjustments are retained: the unpaged API has no stable instance ID for these, and deleting by value could remove legitimate repeated deductions.

Nested break/supplement semantics were not verified in live data, so such records fail closed. Verified normalized break windows preserve paid breaks and deduct unpaid ones; normalized supplements/corrections keep their sign and are not collapsed into hourly rates. Paid absences rely on provider Payroll coverage. A scheduled assigned record absent from Payroll without salary coverage is not silently treated as unpaid; it produces `SOURCE_COVERAGE_INCOMPLETE`. Open/draft/cancelled/deleted schedule entries do not become flat-rate wages.

### Rounding and allocation

Shared amounts are represented as integer øre and allocated by largest remainder, including negative amounts. Salaried accrual is clipped before sharing to conserve the accrued employee total across stores. Hourly fractions are retained until store-component presentation boundaries. Each component rounds once to øre; store and chain totals sum those integer components. The UI's existing `kr()` display rounds currency visually, while percentage uses the unrounded-to-whole-DKK aggregate.

## Store mapping

| Dashboard store | Department ID | Verified live department label |
|---|---:|---|
| Indre By | 149668 | 2 Inner City (Borgergade) |
| Vesterbro | 148561 | 1 Vesterbro (Viktoriagade) |
| Christianshavn | 149748 | 8 Christianshavn |
| Fisketorvet | 149725 | 7 Kajen (Fisketorvet) |
| Frederiksberg | 149715 | 6 Frederiksberg |
| Nørrebro | 149700 | 5 Nørrebro |

The aliases Inner City/Kajen confirm why partial-name matching is inappropriate. IDs remain the mapping authority through renames. Four additional live departments exist; relevant unmapped scheduled work is flagged, not assigned to a dashboard store. Historical replacement IDs are not guessed. An unknown contribution that cannot be assigned safely makes all potentially affected stores incomplete.

## Frontend alignment and performance

Revenue, products, channels, sales cache size/TTL, cache admission and warming logic are unchanged. The salary client records a conservative timestamp for each existing sales snapshot from request start and server cache age. All six snapshots share the earliest effective cutoff. The salary numerator and its ex-VAT denominator use that same cutoff, and the card shows **Revenue basis ex VAT** explicitly. This basis can be slightly earlier than a fresher primary revenue card; it is not secretly divided by the newer value. Missing timestamps on the cutoff date, or a partial repeated autumn hour that naive POS times cannot disambiguate, leave salary unavailable. Active-day cache entries are invalidated when that day becomes historical.

The server and browser independently coalesce identical salary work, and cache only complete aggregate results. Server cache: 64 entries, 16 pending distinct requests, active TTL ≤10 minutes, historical TTL ≤6 hours, lazy LRU eviction, no recurring refresh. Browser: 64 complete results, session/period guards, server cache age deducted from TTL. Raw employee data is discarded after a request; caches contain only aggregate results. Failed/incomplete results are retriable and never cached as successful.

Salary updates only its card/column. The sidebar renders each store's revenue before awaiting salary. Chain/store/sidebar use the same salary helper/result. Graph salary buckets intersect the actual selected ISO range and display provenance; unavailable values are null rather than plotted as zero. Navigation, logout and changed graph selection invalidate pending callbacks. Retry leaves sales caches intact.

## Security verification

- No raw employee arrays or IDs, pay rates, salary codes, headers, tokens or upstream errors are included in the response. Public objects are explicitly constructed from allowlisted aggregate fields.
- The new provider modules do not log; errors are rethrown as fixed safe codes without axios `config`/`response` objects. Token refresh is coalesced and a 401 retries once.
- Synthetic fixtures use `fixture-*` worker identifiers. A transient live-data scan found **0 production employee-ID matches in the new fixture** and **0 configured credential matches in changed implementation files**.
- Existing auth, CSRF, removed-diagnostic-route and browser session tests still pass. No credentials or production configuration were changed.
- Temporary diagnostics and aggregate JSON remained outside the checkout. No raw response was saved. Only aggregate tables are retained below.

## Live reconciliation

Captured 2026-09-23 **23:03:14 Europe/Copenhagen**. Today and This Week use that exact shared cutoff; completed periods use the full interval. Provider records can be edited later, so this is a reproducible-rule audit, not a historical ledger snapshot. `Approved shifts` excludes monthly salaries and non-shift adjustments and is **not** an entire payroll total. `Time & Cost` is a full-day scheduled comparison, not an active-period numerator.

| Period | Old dashboard DKK | Shift payroll DKK | Contracted salaries DKK | Adjustments DKK | Revenue ex VAT DKK | Old salary % | Final result |
|---|---:|---:|---:|---:|---:|---:|---|
| Today | 19,888.00 | 14,366.92 | 6,603.33 | -595.00 | 77,479.20 | 25.67% | Unavailable / incomplete |
| Yesterday | 19,427.00 | 14,763.00 | 6,603.33 | -455.00 | 75,971.64 | 25.57% | Unavailable / incomplete |
| This Week | 58,899.00 | 42,602.92 | 19,810.00 | -1,610.00 | 221,764.12 | 26.56% | Unavailable / incomplete |
| Last Week | 159,697.00 | 120,652.58 | 46,223.33 | -3,675.00 | 581,817.76 | 27.45% | Unavailable / incomplete |

The three payroll component columns are an aggregate source comparison, not a reconciled store result. They cannot be substituted for the missing final result. All four periods fail `UNALLOCATED_SALARY`; Today and Last Week also include `UNKNOWN_DEPARTMENT`, and Yesterday includes `SOURCE_COVERAGE_INCOMPLETE`. Current Week combines those warnings. Unapproved shifts and estimated allocation warnings remain explicit.

### Today — store reconciliation

| Store | Old DKK | Shift payroll DKK | Approved shifts DKK | Time & Cost DKK | Revenue ex VAT DKK | Proposed DKK / source | Complete | Δ DKK / pp |
|---|---:|---:|---:|---:|---:|---|---|---|
| vesterbro | 2,720.00 | 2,307.50 | 0.00 | 2,307.50 | 8,755.36 | — / estimated, unavailable | false | — / — |
| indre-by | 3,664.00 | 2,544.42 | 2,544.42 | 4,431.20 | 15,575.20 | — / estimated, unavailable | false | — / — |
| norrebro | 2,704.00 | 1,232.50 | 0.00 | 2,451.74 | 12,178.24 | — / estimated, unavailable | false | — / — |
| frederiksberg | 3,040.00 | 2,625.00 | 0.00 | 2,625.00 | 12,820.00 | — / estimated, unavailable | false | — / — |
| fisketorvet | 3,840.00 | 3,175.00 | 0.00 | 3,175.00 | 14,708.48 | — / estimated, unavailable | false | — / — |
| christianshavn | 3,920.00 | 2,482.50 | 0.00 | 3,418.07 | 13,441.92 | — / estimated, unavailable | false | — / — |

Safe warning codes: `ADJUSTMENT_ALLOCATION_ESTIMATE`, `SALARY_ALLOCATION_ESTIMATE`, `UNALLOCATED_SALARY`, `UNAPPROVED_SHIFTS`, `UNKNOWN_DEPARTMENT`.

### Yesterday — store reconciliation

| Store | Old DKK | Shift payroll DKK | Approved shifts DKK | Time & Cost DKK | Revenue ex VAT DKK | Proposed DKK / source | Complete | Δ DKK / pp |
|---|---:|---:|---:|---:|---:|---|---|---|
| vesterbro | 2,867.00 | 2,363.75 | 2,363.75 | 2,363.75 | 7,719.04 | — / estimated, unavailable | false | — / — |
| indre-by | 3,355.00 | 2,883.17 | 2,883.17 | 3,883.17 | 15,523.20 | — / estimated, unavailable | false | — / — |
| norrebro | 2,819.00 | 2,556.42 | 2,556.42 | 2,556.42 | 12,425.08 | — / estimated, unavailable | false | — / — |
| frederiksberg | 2,720.00 | 1,542.50 | 0.00 | 2,448.69 | 11,982.64 | — / estimated, unavailable | false | — / — |
| fisketorvet | 3,669.00 | 3,385.33 | 3,385.33 | 3,385.33 | 14,052.40 | — / estimated, unavailable | false | — / — |
| christianshavn | 3,997.00 | 2,031.83 | 2,031.83 | 3,083.64 | 14,269.28 | — / estimated, unavailable | false | — / — |

Safe warning codes: `ADJUSTMENT_ALLOCATION_ESTIMATE`, `SALARY_ALLOCATION_ESTIMATE`, `SOURCE_COVERAGE_INCOMPLETE`, `UNALLOCATED_SALARY`, `UNAPPROVED_SHIFTS`.

### This Week — store reconciliation

| Store | Old DKK | Shift payroll DKK | Approved shifts DKK | Time & Cost DKK | Revenue ex VAT DKK | Proposed DKK / source | Complete | Δ DKK / pp |
|---|---:|---:|---:|---:|---:|---|---|---|
| vesterbro | 8,435.00 | 7,015.92 | 4,708.42 | 7,015.92 | 22,891.36 | — / estimated, unavailable | false | — / — |
| indre-by | 10,581.00 | 7,190.00 | 7,190.00 | 12,712.70 | 45,759.20 | — / estimated, unavailable | false | — / — |
| norrebro | 8,211.00 | 5,035.17 | 3,802.67 | 7,470.90 | 31,417.88 | — / estimated, unavailable | false | — / — |
| frederiksberg | 8,773.00 | 6,913.33 | 1,370.83 | 7,819.52 | 36,211.60 | — / estimated, unavailable | false | — / — |
| fisketorvet | 11,200.00 | 9,701.17 | 6,526.17 | 9,701.17 | 42,433.36 | — / estimated, unavailable | false | — / — |
| christianshavn | 11,699.00 | 6,747.33 | 4,264.83 | 9,846.04 | 43,050.72 | — / estimated, unavailable | false | — / — |

Safe warning codes: `ADJUSTMENT_ALLOCATION_ESTIMATE`, `SALARY_ALLOCATION_ESTIMATE`, `SOURCE_COVERAGE_INCOMPLETE`, `UNALLOCATED_SALARY`, `UNAPPROVED_SHIFTS`, `UNKNOWN_DEPARTMENT`.

### Last Week — store reconciliation

| Store | Old DKK | Shift payroll DKK | Approved shifts DKK | Time & Cost DKK | Revenue ex VAT DKK | Proposed DKK / source | Complete | Δ DKK / pp |
|---|---:|---:|---:|---:|---:|---|---|---|
| vesterbro | 20,947.00 | 18,085.42 | 18,085.42 | 18,085.42 | 69,793.68 | — / estimated, unavailable | false | — / — |
| indre-by | 31,203.00 | 21,894.17 | 21,894.17 | 36,331.01 | 118,747.12 | — / estimated, unavailable | false | — / — |
| norrebro | 21,907.00 | 16,664.00 | 16,664.00 | 18,929.48 | 71,621.68 | — / estimated, unavailable | false | — / — |
| frederiksberg | 24,117.00 | 20,389.17 | 20,389.17 | 21,460.12 | 93,466.64 | — / estimated, unavailable | false | — / — |
| fisketorvet | 33,179.00 | 28,310.42 | 28,310.42 | 28,310.42 | 118,969.52 | — / estimated, unavailable | false | — / — |
| christianshavn | 28,344.00 | 15,309.42 | 15,309.42 | 25,648.45 | 109,219.12 | — / estimated, unavailable | false | — / — |

Safe warning codes: `ADJUSTMENT_ALLOCATION_ESTIMATE`, `SALARY_ALLOCATION_ESTIMATE`, `UNALLOCATED_SALARY`, `UNKNOWN_DEPARTMENT`.

### Investigating 20,240 / 28,762 = 70.4%

The example has no exact date, request snapshot or cutoff, and Planday permits edits. The exact 20,240 DKK cannot be reconstructed from today's later records (which produce 19,888 DKK under the original formula). It would be incorrect to attribute that particular snapshot solely to future shifts.

A reproducible replay of the **same old rule** on September 23 at 14:32 Copenhagen gives:

| Method | Cost DKK | Revenue ex VAT DKK | Ratio |
|---|---:|---:|---:|
| Old full scheduled hours ×160 | 19,888.00 | 23,436.96 | 84.86% |
| Same flat-rate method clipped at 14:32, diagnostic only | 6,112.00 | 23,436.96 | 26.08% |
| Repaired model | Unavailable | 23,436.96 | Unavailable |

The timing mismatch alone adds **13,776 DKK / 58.78 percentage points** in this replay. The second row still has the wrong universal rate and salary treatment; it is not the proposed payroll result. The repaired result remains unavailable because store allocation/coverage is unresolved. Thus the future-hours diagnosis is confirmed for the calculation rule, but not proven for that exact historical 20,240 DKK example.

### Remaining uncertainties

1. Determine whether the two NoAllocation salaries are store labour, shared overhead, or intentionally excluded. No new exclusion is assumed. Some other salaries also lack a usable shift allocation in short requested periods.
2. Identify the intended dashboard scope of work in the four departments outside the six verified mappings. Unknown contributions must not silently disappear.
3. Reconcile assigned schedule rows absent from Payroll: explicit unpaid absence, payroll exclusion settings, missing pay configuration, or another reason. The public scheduling shift-type schema does not expose a sufficient payroll-exclusion guarantee.
4. Verify nested break/supplement total and timing semantics on actual examples before enabling those upstream record shapes. No such rows appeared in the inspected September sample. Approved absence and overnight/DST examples likewise need tenant checks; synthetic tests do not claim a live occurrence.
5. Review the documented calendar salary accrual and daily adjustment proration. They are estimates. Department sharing for MonthlySalary/ScheduledHours/NoAllocation falls back to the old proportional-hours rule only where there are supporting shifts; there is no invented divisor.
6. The preceding-day lookup covers ordinary overnight work; shifts starting before that lookback, or a future provider schema change, require further coverage validation. Offset-free ambiguous DST times fail closed.
7. Salary's explicitly displayed revenue basis uses the earliest cached sales snapshot. Primary revenue remains on its existing refresh policy. This avoids changing sales metrics/cache behavior but can show a slightly newer main revenue figure than the salary basis.

## Validation and benchmark

- Clean isolated `npm ci`: 95 locked packages, 0 audit vulnerabilities; no dependency changes.
- `npm test`: 884 tests passing (807 existing + 77 new); none removed or weakened.
- No lint/type-check command is configured. Node syntax checks and `git diff --check` cover changed JavaScript and inline browser code.
- Node child-process timezone tests and real browser checks use UTC, Europe/Copenhagen, and America/Los_Angeles as applicable.
- Existing real-browser security suite: all 7 checks passed (login/logout, restored sessions, expired sessions, delayed old 401/response isolation, local persistence).
- Real Chromium payroll check (synthetic local providers, America/Los_Angeles browser): progressive revenue, chain/sidebar/store agreement, failure/Retry recovery and genuine zero all passed; no page errors. Existing visual design was inspected at desktop width. Screenshot stays outside git.
- New browser-logic tests execute the actual inline frontend source, including progressive sidebar rendering, cutoff filtering, coalescing and stale salary callbacks.
- `npm run check:payroll-security`: passes fixture identity, response allowlist and credential/error logging scans. Live values also scanned transiently with zero matches.
- `npm run benchmark:payroll`: 4,464 deterministic normalized records across all six stores and a month, 15 runs. Final clean-run median **1.90 ms**, p95 **5.83 ms**. Twenty simultaneous identical requests produce one four-call provider sequence; delayed mock cold **27.33 ms**, warm **0.11 ms**, response **1,327 bytes**. Live four-period payroll-only probes took **0.83–1.02 seconds**; the larger reconciliation includes separate revenue and Time & Cost calls and is not dashboard latency.

Coverage includes active Today/Week/Month, completed dates, end exclusivity, midnight/DST/leap/month/week boundaries, actual/scheduled/estimated sources, zero/unavailable, chain weighting/completeness, rate changes, shared salary conservation, cancellations/deletions/open shifts, corrections, page truncation/duplicates, auth/CSRF, API PII allowlists, token retry/coalescing, cache bounds/TTLs/failure retry, progressive rendering and navigation guards. Existing sales, Wolt, products, refunds, warming/cache and security tests remain unchanged and pass.

## Exact production checks required

Before deployment:

1. In Planday, reconcile each monthly salary's effective cost-allocation setting with the intended six-store scope. Configure/approve a department distribution or documented shared allocation for currently unallocated salaries, or explicitly decide and document an exclusion rule. This PR does not modify Planday.
2. Review unmapped departments and assigned shifts missing from Payroll using the approved Payroll export. Add explicit mapping/history or verified exclusion semantics in a follow-up; never guess from similar department names.
3. Approve the estimated calendar accrual and daily adjustment-sharing policy, and inspect actual break/supplement/absence examples to establish their monetary semantics.
4. Re-run an aggregate-only reconciliation with the existing credentials: full Yesterday and Last Week, Today and This Week at a recorded Copenhagen cutoff, all six stores; require known allocations, complete pages, no unresolved conflicts, and matching signed components. Do not publish a numeric “after” percentage until complete.
5. Confirm the response has only aggregate allowlisted fields and that payroll logs contain no employee or credential values. Compare all six store cards, chain totals, sidebar and graph values using identical date/cutoff inputs. Test a deliberately failed provider call and a genuine empty payroll period.

After a separately authorized deployment:

- Confirm current revenue/products/channels render while payroll loads; check one current and one historical period and Retry. No merge/deploy was performed as part of this audit.
- Verify the displayed Copenhagen cutoff and revenue basis agree with the numerator; chain percentage uses summed costs and revenue. Record an aggregate screenshot/table only, with no employee details.
- Check cache hits within the 10-minute/current and 6-hour/historical limits, expiry/retry, and new-period navigation while a salary request is in flight.
