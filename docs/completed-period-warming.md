# Completed-period warming: evidence and limits

Measured 2026-09-23 against baseline `f92fe8cf48ca1cb365a9f61cd9cf48a03958f836` and this change. **These are deterministic local measurements, not production results.** The reported ~15-second production first visit was not independently measured; no production credentials, deployment, or merge were used.

## Cold-path diagnosis

The initial baseline measurement used the actual dashboard in Chromium, a real local Express server, and delayed mocked providers. The first run used 80 lines/store/day before implementation. A second baseline comparison used the complete 466-line Nørrebro fixture for every store/day, matching the representative final run below. Every OnlinePOS export has a 250 ms delay and one page containing 32 days; Planday payroll/shifts have a 1,000 ms delay. Date is fixed at 2026-09-23 14:00 Copenhagen. Product/refund values come from the existing fixture; dates/order IDs are synthetic. Chart.js is rendered locally, with fonts blocked to remove external-network variability.

Each cold preset requests **six current full-line exports and six compact-LY exports**. Both OnlinePOS paths contribute to latency. Sidebar loading starts current and LY together; the main card consumes those shared requests. The browser's HTTP/1 connection limit also queues requests. Warming only LY would leave the current-line delay intact.

| Baseline cold preset, 466 lines/day | Current revenue | LY comparison | Budget | Salary card | Chromium task time | Exports / duplicates |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Yesterday | 663 ms | 663 ms | 663 ms | 1,649 ms | 207 ms | 12 / 0 |
| Last Week | 710 ms | 710 ms | 710 ms | 1,724 ms | 254 ms | 12 / 0 |
| Last Month | 1,008 ms | 1,008 ms | 1,008 ms | 2,108 ms | 422 ms | 12 / 0 |

Planday does **not** gate the main revenue, LY, or budget cards. It does gate sidebar completion. Existing sidebar/main salary calls can overlap; this change does not add salary warming or change salary behavior. Browser processing is material for the month (20.8 MB of public sales JSON), but OnlinePOS waits dominate the cold waterfall. Task time is Chromium's total main-thread task duration over the visit, not an isolated metric-function timing.

The baseline allowed up to six simultaneous OnlinePOS calls; its concurrency-two bound applied only to LY warming. This change enforces two across all sales/summary exports, including pagination, user requests, and warming. Consequently a completely cold final-code visit is slower than the baseline's unbounded export burst, while warmed visits eliminate exports.

## Ranges and order

All intervals below use **inclusive start / exclusive end**, Copenhagen calendar dates. Each applies to all six stores. LY retains the existing 364-day comparison shift.

| Stage | Current range | LY range | Work on the fixed benchmark date |
| --- | --- | --- | --- |
| This Week, then Today | `[2026-09-21, 2026-09-24)`; `[2026-09-23, 2026-09-24)` | — | Six weekly exports; derive Today |
| Existing LY Today | — | `[2025-09-24, 2025-09-25)` | Six summary exports |
| Existing LY This Week | — | `[2025-09-22, 2025-09-25)` | Six summary exports |
| Existing LY This Month | — | `[2025-09-02, 2025-09-25)` | Six summary exports |
| Last Week | `[2026-09-14, 2026-09-21)` | `[2025-09-15, 2025-09-22)` | Derive LY from cached LY month; six current exports |
| Yesterday | `[2026-09-22, 2026-09-23)` | `[2025-09-23, 2025-09-24)` | Derive current from This Week and LY from LY This Week |
| Last Month | `[2026-08-01, 2026-09-01)` | `[2025-08-02, 2025-09-02)` | Six compact LY exports, then six sequential current exports |

On Monday, Yesterday lies outside This Week. Last Week is deliberately warmed first, so its complete Sunday data supplies Yesterday. Parents must be complete, fresh, from the same store, and cover the whole requested interval. Otherwise a normal coalesced fetch occurs. DST, leap-day, month, and year boundaries use calendar arithmetic. Year/custom ranges are not scheduled.

Observed startup order/duration: **current 818 ms → existing LY 2,447 ms → completed 3,555 ms**, total **6,820 ms**. There were **42 exports, zero duplicates, maximum concurrency two**. Counts depend on the date, existing covering ranges, failures, and pagination; the mock uses one page/export. The health endpoint returned HTTP 200 in **19 ms while warming was still running**.

## Final rendered timings

The cold measurements clear both server and browser caches. Warm measurements clear browser caches after startup warming, exercising server responses and real rendering. Repeat visits retain browser caches. Timings end on an animation frame after the relevant card's populated DOM appears.

| Preset | Cold current / LY / budget | After startup current / LY / budget | Repeat current / LY / budget | Cold / warm / repeat exports | Duplicates |
| --- | --- | --- | --- | --- | --- |
| Yesterday | 1,624 / 1,624 / 1,624 ms | **70 / 70 / 70 ms** | 12 / 12 / 12 ms | 12 / 0 / 0 | 0 |
| Last Week | 1,642 / 1,671 / 1,671 ms | **130 / 130 / 130 ms** | 18 / 18 / 18 ms | 12 / 0 / 0 | 0 |
| Last Month | 1,677 / 1,737 / 1,737 ms | **458 / 458 / 458 ms** | 24 / 24 / 24 ms | 12 / 0 / 0 | 0 |

Warm salary cards finished at 1,076 / 1,149 / 1,417 ms respectively, after the target cards were ready. Warm Chromium task time was 163 / 187 / 382 ms. All browser page-error counts were zero. Today and This Week subsequently rendered all three target cards in **51 / 56 ms**, with zero exports and their original cache entries still present.

| Preset | Cold current response bytes | Warm current response bytes | Cold LY response bytes | Warm LY response bytes |
| --- | ---: | ---: | ---: | ---: |
| Yesterday | 671,805 | 671,775 | 2,169 | 2,181 |
| Last Week | 4,692,507 | 4,692,513 | 3,975 | 3,987 |
| Last Month | 20,775,285 | 20,775,291 | 11,181 | 11,187 |

Sizes total all six stores, uncompressed JSON, including metadata. Minor cold/warm differences are cache status and source metadata. Browser repeat visits transfer zero sales/LY bytes. Salary responses totaled four bytes per first visit (two `{}` responses). No extra raw OnlinePOS fields reach the browser; the existing allowlist is unchanged.

## Serialized memory and admission policy

Blindly retaining all original raw results is unsafe for the representative profile: raw lines alone would use **45,277,710 bytes (43.18 MiB)** across the proposed 30 sales entries. Last Month alone accounts for 32,642,070 bytes of raw lines, leaving insufficient room for current-week/day and other completed entries. This estimate uses the actual generated fixture fields, including synthetic private-field sentinels, and excludes envelope overhead.

After raw identity fields have served deduplication/conflict detection, the sales cache retains every public metric field and the CPH date/timestamps needed for derivation and the existing sanitizer. It discards unused order/customer/employee fields. This preserves product metrics, top items, signed refunds/counts, kombo/roll/lemonade values, channel percentages, and exact public responses.

Measured complete serialized results, including envelopes:

| Entries | Per-store bytes | All-six bytes |
| --- | ---: | ---: |
| Existing current Today + This Week (12 entries) | 469,593 combined | 2,817,558 |
| Current Yesterday | 117,543 | 705,258 |
| Current Last Week | 821,162 | 4,926,972 |
| Current Last Month | 3,635,833 | 21,814,998 |
| Existing LY Today / week / month (18 entries) | 28,500 combined | 171,000 |
| LY Yesterday | 1,356 | 8,136 |
| LY Last Week | 7,506 | 45,036 |
| LY Last Month | 32,049 | 192,294 |

Final caches after representative warming **and visits**: **30 sales entries / 30,264,786 bytes (28.86 MiB)**; **36 LY entries / 416,466 bytes (0.397 MiB)**. Both caches remain within their existing independent 120-entry and 32 MiB limits. No high-priority entry was evicted. Twelve refresh timers belong to existing Today/This Week keys; completed periods and LY have zero timers. Historical TTL remains six hours, inherited from the source fetch time for derived entries. No historical refresh timer or recurring warm loop is introduced.

All completed-period admission is non-evicting, and Last Month current stores are fetched one at a time. Every candidate's actual serialized result is measured, including rejected candidates. Today/This Week are additionally protected from subsequent ordinary LRU admissions while they are the current Copenhagen ranges. An entry that cannot fit is returned without caching; failures/incompleteness remain unavailable and are logged without provider error payloads.

Overflow validation at **600 lines/store/day** retained four of six Last Month current stores (4,680,967 bytes each), all six LY summaries, and every Today/This Week key. After warming: 28 sales entries / 29,601,064 bytes; 36 LY entries / 418,458 bytes. The first subsequent month API visit made two exports and needed **539 ms** for current/LY/budget readiness; its immediate repeat made zero exports. After those visits: 19 sales entries / 32,769,656 bytes, 36 LY entries / 418,458 bytes. Lower-priority history was evicted on demand; **Today/This Week remained cached throughout**. The <500 ms target is therefore conditional on retained data fitting and local response/render costs, not an unconditional production guarantee.

## Validation and reproduction

A fresh isolated checkout ran `npm ci`: 95 packages installed, zero reported vulnerabilities. The complete `npm test` suite passed **800 tests, 128 suites, zero failures/skips**. Coverage includes warming order/readiness, all three presets, shared concurrency/coalescing, six-hour TTL/no historical timers, Monday/Copenhagen/DST/month/year boundaries and snapshots crossing midnight, incomplete/failed-store handling, refunds and LY budget totals, actual 32 MiB and entry pressure, protected current entries, existing product rules, and response-field privacy. `git diff --check` passes.

The committed benchmark requires only the existing application dependencies:

```sh
npm ci
node scripts/benchmark-completed-periods.js 250 466
node scripts/benchmark-completed-periods.js 250 600
```

It exercises real authenticated Express routes with deterministic mocked providers and reports API current/LY/budget readiness, Planday timing, exports/duplicates, response sizes, every completed candidate's bytes/status, final cache stats, and current-entry preservation. It checks cold/warm value equality with a 0.000001 kr floating-point tolerance. Its timings are explicitly HTTP measurements, not browser render measurements. Chromium tooling and full local waterfall captures were kept outside the repository, as requested.

Remaining limits: startup is asynchronous, so visits before warming completes can still wait; caches expire and are process-local; larger/longer exports can bypass admission; large month JSON still costs network/parse/render time; live pagination/provider latency and production volume were not measured. Existing ≥15-day Top Items/Product Mix UI limits are unchanged even though all metric fields are cached. No merge or deployment was performed.
