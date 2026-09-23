# Planday payroll audit and decision sheet

Updated 2026-09-23, following draft PR #6 at `ffd4297`. Baseline `origin/main`: `29ed320` (includes sales performance PR #5). No merge, deployment, Planday configuration change, credential change or employee-level export was performed. This report supersedes the initial audit's broad “unallocated / unknown department” findings.

## Outcome and deployment gate

**Not deployable yet; keep PR #6 draft.** All six stores remain incomplete because two salaries have no defensible six-store scope rule. Those are two explicit decisions, totalling **67,500 DKK/month**. Independently, one approved sick-leave shift on September 22 is missing from both monetary sources in Christianshavn; its configured replacement-rate calculation is **591.71 DKK**, not proof of entitlement or an amount silently added by this PR.

All other observed technical blockers have been reduced: four unrelated departments are explicitly excluded, outside-operation shares are retained outside the stores, complete month schedules support off-day salary accrual, Payroll queries no longer cross calendar-month boundaries, and zero-effect fields / pending approval do not invalidate a supported estimate. A one-minute schedule overlap has a bounded, labelled estimate. There are no missing pages or upstream errors in this reconciliation.

The latest live payroll capture finished **2026-09-23 23:49:11 Europe/Copenhagen**. Active figures below use the fixed cutoff **23:35:00 Copenhagen (21:35:00Z)**; the 14:32 row is an explicit replay. Completed dates use the entire interval. Provider data remains editable; this is a calculation audit, not a locked payroll ledger.

## Authoritative sources and scope

Official references checked against actual payloads:

- [Payroll schema](https://openapi.planday.com/payroll/swagger/v1.0/swagger.json) and [Payroll integration guide](https://developer.planday.com/guides/payroll-guide/): provider amounts, salary intervals, signed adjustments and payroll-excluded shift types.
- [Scheduling schema](https://openapi.planday.com/scheduling/swagger/v1.0/swagger.json) and [Time & Cost guide](https://developer.planday.com/guides/timeandcost-guide/): scheduled cost coverage and exclusions.
- [Pay schema](https://openapi.planday.com/pay/swagger/v1.0/swagger.json) and [salary cost allocation settings](https://help.planday.com/en/articles/30526-how-to-view-the-payroll-costs-of-salaried-staff-in-the-schedule): effective allocation modes and weights.
- [HR schema](https://openapi.planday.com/hr/swagger/v1.0/swagger.json): department membership and change history.
- [Punch Clock schema](https://openapi.planday.com/punchclock/swagger/v1.0/swagger.json): datetime bounds and shift-filtered checks.

| Source endpoint | Verified use / limitations |
|---|---|
| `/hr/v1/departments` | Complete 10-department inventory; documented limit 50. No Airport/franchise, closed/historical, test/archive or unknown label occurs in this inventory or the inspected August/September records. This does not assert that no archived department exists outside the API's returned inventory. |
| `/hr/v1/employees/{employee}/history` and employee detail | All six salaried profiles belong to all ten departments; none has a primary department. September history returned successfully and showed no membership changes. Job titles do not establish safe operational roles. Current broad access is not an allocation. |
| `/payroll/v1/payroll` (all / `shiftStatus=Approved`) | `shiftsPayroll`, `supplementsPayroll`, `salariedPayroll` are top-level arrays. Signed DKK values, not `.data`. Absence from approved output alone means scheduled, not missing. |
| `/scheduling/v1/shifts` | Complete pages for coverage and full calendar-month salary shares. Copenhagen timestamps use minute precision. Open/draft/cancelled/deleted work is omitted. |
| `/pay/v1/salaries/scheduling/timeandcost/allocations/{employee}/history` | Six effective histories: BusinessDays 1, NoAllocation 2, ScheduledHours 2, MonthlySalary 1. Explicit targets win. |
| `/scheduling/v1/timeandcost/{department}` | All six successful. Diagnostic source only: can contain extra overhead and excludes daily/weekly supplements. It is not added on top of Payroll. |
| `/scheduling/v1/shifttypes` | Rechecked successfully at limit 50; the earlier limit-100 probe caused HTTP 400. Exposes replacement rate but not the payroll-inclusion switch needed to resolve the sick-leave gap. |
| `/pay/v1/payrates/employeeGroups/{group}/employees/{employee}/history` | Effective pay history exists for the missing-shift worker. Normal calculations already use Payroll's resolved rate; no invented standard rate. |
| `/punchclock/v1/punchclockshifts` | Corrected to a nonempty datetime interval (midnight to next midnight), filtered by the missing shift. Zero records. The earlier same-date query was not evidence of absent clock data. |

### Every unmapped department

| Department ID | Safe Planday label | Classification | Decision in code | Assigned shifts Aug / Sep 1–23 |
|---|---|---|---|---|
| 149683 | 4 Parken Section B | Parken operation | Exclude direct cost; retain its share of a mixed salary outside six stores | 30 / 23 |
| 149749 | 4 Parken Section C | Parken operation | Same explicit exclusion | 0 / 0 |
| 149787 | Festival | Festival/event | Same explicit exclusion | 16 / 2 |
| 149750 | Office | Administration | Exclude direct Office cost; do not invent store allocations for chain/admin salaries | 17 / 18 |

The six verified store mappings remain 148561→Vesterbro, 149668→Indre By, 149700→Nørrebro, 149715→Frederiksberg, 149725→Fisketorvet and 149748→Christianshavn. “Inner City” and “Kajen” are proven aliases on those exact IDs. No new name-based or historical replacement mapping was invented. A new unknown ID still fails closed. Explicit existing salary distributions can legitimately point from an Office worker to a store; the existing 30,000 DKK Indre By allocation is retained.

## Blocker catalogue: distinct causes, owners and remedies

The matrix below uses these IDs. C1 and C2 are shared pools: repeated store rows do **not** multiply the salary or claim it belongs in each store.

| ID / class | Endpoint / safe department | Reason code | Affected records and DKK | Prevents completeness / provenance | Exact remedy / owner |
|---|---|---|---|---|---|
| C1 — business scope | Payroll + allocation history; memberships all ten, observed work `4 Parken Section B` | `SALARY_SCOPE_UNDECIDED` | 1 salary, 32,500/month; period amounts below | Yes, all potentially affected stores; salary allocation would be estimated | Confirm outside-six-store scope or explicit store percentages and effective date. **Ulv**; Codex then implements the exact authorized rule. |
| C2 — business scope | Same endpoints; memberships all ten, only limited `5 Nørrebro` activity | `SALARY_SCOPE_UNDECIDED` | 1 salary, 35,000/month; period amounts below | Yes, all potentially affected stores; estimated | Same explicit scope decision. Two hours of work do not justify assigning an entire monthly salary. **Ulv**. |
| B1 — Planday configuration / data quality | `/scheduling/v1/shifts`, Payroll, Time & Cost, shift types; `8 Christianshavn` | `SOURCE_COVERAGE_INCOMPLETE` | 1 approved `Sygemelding` shift, September 22, 4.5 h; 4.5 × configured 131.49 = **591.71** potential DKK | Yes, Christianshavn only in Yesterday / This Week / September; actual missing, unsupported scheduled amount | Planday admin checks the shift type's payroll-inclusion setting and payroll report, establishes paid/unpaid treatment, and corrects the source if paid. If intentionally unpaid, provide an explicit dated exclusion fact for Codex. **Planday admin**, not an allocation question for Ulv. |
| D1 — zero unsupported effect | Payroll nested `breaks` / `supplements`; all six | `UNVERIFIED_BREAK_OR_SUPPLEMENT` only if encountered with unresolved nonzero effect | 0 nested records among 440 September and 638 August shift-payroll rows; **0 DKK** observed | **No current blocker**. Nonzero future unknown shapes still invalidate relevant store | No user decision. Codex retains fail-closed support and zero-effect tests. |
| D2 — immaterial timing ambiguity | Full-month schedule, September 9, `8 Christianshavn` ↔ `Office` | `MINUTE_OVERLAP_ESTIMATE` | 2 schedule rows / 1 salaried profile; 1 minute overlap; extreme allocation difference at most **3.83 DKK/month** | **No**, explicitly estimated; half-share uncertainty ≤1.92/month (rounding can add øre) | Codex splits the minute equally. Only ≤60 seconds total and conservative bound ≤5 DKK/month qualify; larger overlaps remain incomplete. Admin can tidy the schedule, but it is not a deployment gate. |
| B2 — pending approval, not missing money | Payroll all vs approved; stores/counts below | `UNAPPROVED_SHIFTS` | Complete unapproved monetary records, not failed/partial pages | **No**, scheduled estimates remain usable in active and historical periods | Planday admin approves records through normal payroll workflow. No request to Ulv and no code fallback needed. |

### Category A technical defects resolved in this follow-up

| Defect / previous code | Affected records / safe financial effect | Fix / owner / current gate |
|---|---|---|
| `UNKNOWN_DEPARTMENT` applied to unrelated operations | 43 assigned outside shifts September 1–23; 63 in August; direct six-store cost effect 0 | Exact four-ID exclusions. Mixed-operation salary/deduction shares stay outside. **Codex, resolved**. |
| Salary sharing omitted outside shifts, and preceding-day lookup biased shares | 3 salaries with configured shift-based modes, **100,600 DKK/month**; new store allocations below | Complete month schedule, all known destinations, per-month denominator, dated history. **Codex, resolved; estimated**. |
| Off-day salary appeared unallocatable in day/week requests | Same 3 salaries | Month sharing gives a day with no shifts a supported accrued share. **Codex, resolved**. |
| Payroll lookback crossed months and changed salary proration | 6 salaries, **198,100 DKK/month**. September-to-cutoff allocatable subtotal increased **1,460.42 DKK** when correcting this alone in the diagnostic before the overlap estimate; this is not a complete chain total | Request each calendar month separately; query prior-day Payroll only for verified crossing shifts, without importing prior-day salaries. **Codex, resolved**. |
| Sole verified store membership unsupported | 0 currently eligible profiles, **0 DKK current effect** | Dated sole assignment supported, with complete HR change history when needed. Broad/current membership never substitutes for history. **Codex, resolved**. |
| Shift-type diagnostic used unsupported page size; punch clock used empty date range | 1 gap investigated; possible **591.71 DKK**, still B1 | Honor 50-record endpoints; use next-midnight datetime bounds. Correct diagnosis, not invented wages. **Codex, resolved**. |
| Failure reasons copied into unrelated stores | B1 falsely appeared in all six store warning lists | Store failures now stay local; chain still reflects failed store. **Codex, resolved**. |
| Future/outside shifts omitted from adjustment-sharing denominator | Daily meal deductions; outside-store difference **7.50 DKK Today**, **58.29 DKK September-to-cutoff**, **81.53 DKK August** | Retain whole-day allocation evidence, then clip accrual and exclude outside shares. **Codex, resolved; estimated**. |

### Shared salary pools by period

Amounts are salary accrual before deciding store scope, never repeated costs per store. For a proposed store weight `w`, incremental store cost is its pool × `w`. Exclusion means +0 to every six-store row. The app currently returns null until this is decided.

| Period | C1: Parken-activity pool | C2: limited-Nørrebro pool | Combined unresolved salary |
|---|---:|---:|---:|
| Today | 1,064.52 | 1,146.42 | 2,210.94 |
| Yesterday | 1,083.33 | 1,166.67 | 2,250.00 |
| This Week | 3,231.19 | 3,479.75 | 6,710.94 |
| Last Week | 7,583.33 | 8,166.67 | 15,750.00 |
| September to cutoff | 24,897.86 | 26,813.08 | 51,710.94 |
| August | 32,500.00 | 35,000.00 | 67,500.00 |
| 14:32 replay | 656.02 | 706.48 | 1,362.50 |

### Exact remaining store / period matrix

All store labels are the verified Planday department names. `C1+C2` means two shared salary records (DKK in the immediately preceding table), possible effect **0 to that pool** for this store until weights are chosen; the chain uncertainty is the pool once. `B1` adds one missing sick-leave record and **0 or 591.71 DKK base pay** in Christianshavn; entitlement/additional items require the admin check. C1/C2 owner: Ulv; B1 owner: Planday admin. Every row is currently incomplete and would otherwise use explicitly estimated salary/adjustment allocations, not an actual-only label.

| Period | Store / safe department | Remaining cause IDs | Affected records | Complete now | Complete if C1+C2 are confirmed outside? |
|---|---|---|---:|---|---|
| Today | 1 Vesterbro (Viktoriagade) | C1 + C2 | 2 shared | No | Yes, estimated |
| Today | 2 Inner City (Borgergade) | C1 + C2 | 2 shared | No | Yes, estimated |
| Today | 5 Nørrebro | C1 + C2 | 2 shared | No | Yes, estimated |
| Today | 6 Frederiksberg | C1 + C2 | 2 shared | No | Yes, estimated |
| Today | 7 Kajen (Fisketorvet) | C1 + C2 | 2 shared | No | Yes, estimated |
| Today | 8 Christianshavn | C1 + C2 | 2 shared | No | Yes, estimated |
| Yesterday | 1 Vesterbro (Viktoriagade) | C1 + C2 | 2 shared | No | Yes, estimated |
| Yesterday | 2 Inner City (Borgergade) | C1 + C2 | 2 shared | No | Yes, estimated |
| Yesterday | 5 Nørrebro | C1 + C2 | 2 shared | No | Yes, estimated |
| Yesterday | 6 Frederiksberg | C1 + C2 | 2 shared | No | Yes, estimated |
| Yesterday | 7 Kajen (Fisketorvet) | C1 + C2 | 2 shared | No | Yes, estimated |
| Yesterday | 8 Christianshavn | C1 + C2 + B1 | 2 shared + 1 local | No | No: B1 |
| This Week | 1 Vesterbro (Viktoriagade) | C1 + C2 | 2 shared | No | Yes, estimated |
| This Week | 2 Inner City (Borgergade) | C1 + C2 | 2 shared | No | Yes, estimated |
| This Week | 5 Nørrebro | C1 + C2 | 2 shared | No | Yes, estimated |
| This Week | 6 Frederiksberg | C1 + C2 | 2 shared | No | Yes, estimated |
| This Week | 7 Kajen (Fisketorvet) | C1 + C2 | 2 shared | No | Yes, estimated |
| This Week | 8 Christianshavn | C1 + C2 + B1 | 2 shared + 1 local | No | No: B1 |
| Last Week | 1 Vesterbro (Viktoriagade) | C1 + C2 | 2 shared | No | Yes, estimated |
| Last Week | 2 Inner City (Borgergade) | C1 + C2 | 2 shared | No | Yes, estimated |
| Last Week | 5 Nørrebro | C1 + C2 | 2 shared | No | Yes, estimated |
| Last Week | 6 Frederiksberg | C1 + C2 | 2 shared | No | Yes, estimated |
| Last Week | 7 Kajen (Fisketorvet) | C1 + C2 | 2 shared | No | Yes, estimated |
| Last Week | 8 Christianshavn | C1 + C2 | 2 shared | No | Yes, estimated |
| September to cutoff | 1 Vesterbro (Viktoriagade) | C1 + C2 | 2 shared | No | Yes, estimated |
| September to cutoff | 2 Inner City (Borgergade) | C1 + C2 | 2 shared | No | Yes, estimated |
| September to cutoff | 5 Nørrebro | C1 + C2 | 2 shared | No | Yes, estimated |
| September to cutoff | 6 Frederiksberg | C1 + C2 | 2 shared | No | Yes, estimated |
| September to cutoff | 7 Kajen (Fisketorvet) | C1 + C2 | 2 shared | No | Yes, estimated |
| September to cutoff | 8 Christianshavn | C1 + C2 + B1 | 2 shared + 1 local | No | No: B1 |
| August | 1 Vesterbro (Viktoriagade) | C1 + C2 | 2 shared | No | Yes, estimated |
| August | 2 Inner City (Borgergade) | C1 + C2 | 2 shared | No | Yes, estimated |
| August | 5 Nørrebro | C1 + C2 | 2 shared | No | Yes, estimated |
| August | 6 Frederiksberg | C1 + C2 | 2 shared | No | Yes, estimated |
| August | 7 Kajen (Fisketorvet) | C1 + C2 | 2 shared | No | Yes, estimated |
| August | 8 Christianshavn | C1 + C2 | 2 shared | No | Yes, estimated |
| 14:32 replay | 1 Vesterbro (Viktoriagade) | C1 + C2 | 2 shared | No | Yes, estimated |
| 14:32 replay | 2 Inner City (Borgergade) | C1 + C2 | 2 shared | No | Yes, estimated |
| 14:32 replay | 5 Nørrebro | C1 + C2 | 2 shared | No | Yes, estimated |
| 14:32 replay | 6 Frederiksberg | C1 + C2 | 2 shared | No | Yes, estimated |
| 14:32 replay | 7 Kajen (Fisketorvet) | C1 + C2 | 2 shared | No | Yes, estimated |
| 14:32 replay | 8 Christianshavn | C1 + C2 | 2 shared | No | Yes, estimated |

## Salaried-worker decision sheet

Six salary records total **198,100 DKK/month**. No names, employee IDs, salary codes or personal job titles are retained here. Group labels describe observed operations, not verified job titles. All six memberships are broad and primary department is unset. Thus there are **0 unambiguously single-store HR assignments**. One existing explicit allocation is authoritative; three configured shift-based allocations are estimated; two scope decisions remain.

Complete September calendar-month schedules were fetched, including planned September 24–30 work. Future planned hours affect the estimated **distribution weights**, not the accrued cost. The displayed salary stops at the requested cutoff. Planned schedules can change, so these monthly projections are not locked future payroll.

| Safe group | Count | Monthly DKK | Existing effective rule | Complete-month shift evidence (hours) | Applied / proposed rule |
|---|---:|---:|---|---|---|
| Configured Indre By salary | 1 | 30,000.00 | BusinessDays from 2023-02-01 | 5 shifts; Office: 12.50 | Existing 100% Indre By (weekday weight 1, all seven days; departmentWeight 0) |
| Unassigned: Parken activity | 1 | 32,500.00 | NoAllocation from 2026-01-01 | 5 shifts; 4 Parken Section B: 18.00 | Unresolved; outside-six-store scope recommended for confirmation, otherwise explicit percentages |
| Unassigned: limited Nørrebro activity | 1 | 35,000.00 | NoAllocation from 2026-02-01 | 1 shifts; 5 Nørrebro: 2.00 | Unresolved; outside-six-store scope recommended for confirmation, otherwise explicit percentages |
| Christianshavn / Office scheduled salary | 1 | 33,000.00 | ScheduledHours from 2025-11-01 | 18 shifts; 8 Christianshavn: 141.12; Office: 2.50 | Complete-month location-hour shares, retaining outside share; estimated calendar accrual |
| Regional store / Parken scheduled salary | 1 | 34,600.00 | ScheduledHours from 2025-11-01 | 25 shifts; 5 Nørrebro: 101.68; 4 Parken Section B: 43.92; 6 Frederiksberg: 16.95; 8 Christianshavn: 25.03 | Complete-month location-hour shares, retaining outside share; estimated calendar accrual |
| Indre By / Office scheduled salary | 1 | 33,000.00 | MonthlySalary from 2026-04-01 | 22 shifts; Office: 4.50; 2 Inner City (Borgergade): 171.80 | Complete-month location-hour shares, retaining outside share; estimated calendar accrual |

The first group has Office shifts but an explicit 100% Indre By distribution; existing configuration wins. The two NoAllocation groups have no configured weights. Their few shifts are evidence of activity, not a reliable allocation of all their salary. No chain/admin salary is assigned to stores without an existing rule or Ulv's decision.

### Store effects of the supported salary rules

Projected full September salary allocation only, DKK; this is neither total labour cost nor accrued cost at today's cutoff. Vesterbro and Fisketorvet have zero *allocated salaried* share under these rules, not zero hourly labour. Day-level øre allocation is conserved before excluded shares are removed. C1/C2 zeros mean **no authorized allocation yet**, not that their costs are zero or safely excluded.

| Group | Vesterbro | Indre By | Nørrebro | Frederiksberg | Fisketorvet | Christianshavn | Outside six stores / unresolved |
|---|---:|---:|---:|---:|---:|---:|---:|
| Configured Indre By salary | 0.00 | 30,000.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| Unassigned: Parken activity | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | Unresolved 32,500.00 |
| Unassigned: limited Nørrebro activity | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | Unresolved 35,000.00 |
| Christianshavn / Office scheduled salary | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 32,427.30 | 572.70 |
| Regional store / Parken scheduled salary | 0.00 | 0.00 | 18,755.70 | 3,126.40 | 0.00 | 4,617.30 | 8,100.60 |
| Indre By / Office scheduled salary | 0.00 | 32,157.60 | 0.00 | 0.00 | 0.00 | 0.00 | 842.40 |

### Actual requested-period salary amounts by group

Each column groups only equivalent source modes; the individual operational split and weights are immediately above. This table includes the two unresolved salaries as a pool, not as included store cost.

| Period | Explicit Indre By | Two configured ScheduledHours salaries | Indre By/Office MonthlySalary | Unresolved C1+C2 |
|---|---:|---:|---:|---:|
| Today | 982.64 | 2,214.21 | 1,080.90 | 2,210.94 |
| Yesterday | 1,000.00 | 2,253.33 | 1,100.00 | 2,250.00 |
| This Week | 2,982.64 | 6,720.88 | 3,280.90 | 6,710.94 |
| Last Week | 7,000.00 | 15,773.33 | 7,700.00 | 15,750.00 |
| September to cutoff | 22,982.64 | 51,787.55 | 25,280.90 | 51,710.94 |
| August | 30,000.00 | 67,600.00 | 33,000.00 | 67,500.00 |
| 14:32 replay | 605.56 | 1,364.52 | 666.11 | 1,362.50 |

## Coverage gaps, approvals and unsupported fields

**B1 is the only observed schedule-to-monetary coverage gap** across August and September 1–23. It is one approved `Sygemelding` record on September 22 in Christianshavn. HR employee type is `Fast ansatte`; the worker is not present in `salariedPayroll` and is paid through hourly/shift payroll. The standard pay-rate history exists, the shift-type setting supplies MonetaryReplacement 131.49 DKK/hour, and no custom wage is present. The absence type disables breaks. Both successful Payroll responses and successful Time & Cost return no matching row; the corrected Punch Clock query returns no matching record. This is **no monetary record**, not API error, partial paging, pending approval, or proof of unpaid absence.

A hypothetical scheduled base calculation is 591.71 DKK. It is **not a supported complete estimate** until the admin establishes whether this shift type should count in payroll. Current public shift-type fields do not expose that switch. The dashboard cannot infer a legal/payroll entitlement from the type's name or current rate. The pending approvals below, by contrast, already have complete monetary records and do not block completeness.

| Period | Store / safe department | Unapproved shift count | Full-shift Payroll DKK | Treatment |
|---|---|---:|---:|---|
| Today | 1 Vesterbro (Viktoriagade) | 3 | 2,307.50 | Scheduled estimate; clipped when necessary |
| Today | 5 Nørrebro | 2 | 1,232.50 | Scheduled estimate; clipped when necessary |
| Today | 6 Frederiksberg | 3 | 2,625.00 | Scheduled estimate; clipped when necessary |
| Today | 7 Kajen (Fisketorvet) | 3 | 3,175.00 | Scheduled estimate; clipped when necessary |
| Today | 8 Christianshavn | 4 | 2,482.50 | Scheduled estimate; clipped when necessary |
| Yesterday | 6 Frederiksberg | 3 | 1,542.50 | Scheduled estimate; clipped when necessary |
| This Week | 1 Vesterbro (Viktoriagade) | 3 | 2,307.50 | Scheduled estimate; clipped when necessary |
| This Week | 5 Nørrebro | 2 | 1,232.50 | Scheduled estimate; clipped when necessary |
| This Week | 6 Frederiksberg | 8 | 5,542.50 | Scheduled estimate; clipped when necessary |
| This Week | 7 Kajen (Fisketorvet) | 3 | 3,175.00 | Scheduled estimate; clipped when necessary |
| This Week | 8 Christianshavn | 4 | 2,482.50 | Scheduled estimate; clipped when necessary |
| September to cutoff | 1 Vesterbro (Viktoriagade) | 3 | 2,307.50 | Scheduled estimate; clipped when necessary |
| September to cutoff | 5 Nørrebro | 2 | 1,232.50 | Scheduled estimate; clipped when necessary |
| September to cutoff | 6 Frederiksberg | 8 | 5,542.50 | Scheduled estimate; clipped when necessary |
| September to cutoff | 7 Kajen (Fisketorvet) | 3 | 3,175.00 | Scheduled estimate; clipped when necessary |
| September to cutoff | 8 Christianshavn | 4 | 2,482.50 | Scheduled estimate; clipped when necessary |
| 14:32 replay | 1 Vesterbro (Viktoriagade) | 1 | 980.00 | Scheduled estimate; clipped when necessary |
| 14:32 replay | 6 Frederiksberg | 2 | 1,812.50 | Scheduled estimate; clipped when necessary |
| 14:32 replay | 7 Kajen (Fisketorvet) | 2 | 2,525.00 | Scheduled estimate; clipped when necessary |
| 14:32 replay | 8 Christianshavn | 3 | 1,920.00 | Scheduled estimate; clipped when necessary |

Last Week and August have **0 unapproved Payroll shifts**. For the 14:32 replay the full-shift values in this table are coverage evidence only; future portions are excluded from the actual calculation. There are no failing or incomplete provider pages, unsupported employee-type mappings, or unverified replacement department IDs in the audited data.

### Breaks, supplements and corrections: inclusion and double-counting

- Payroll `salary` is the main shift amount. For the inspected September shifts it reconciles to duration × resolved rate; the residual sum is approximately 0.000000000014 DKK. August and September nested break/supplement counts are both zero. Their observed financial effect is **zero**, so no request to inspect hypothetical examples blocks this release.
- Official Payroll documentation treats shift supplements as payroll items alongside hours, while the schema calls shift `salary` a total. These statements are insufficient to establish every nonzero nested shape's additive/timing behavior without an example. The engine neither blindly adds nested values nor assumes unknown unpaid breaks are already deducted. A future unresolved nonzero nested shape fails only the affected store. Provably zero monetary details pass.
- Live non-shift adjustments are `Kostfradrag` (meal deductions), −35 DKK per row, midnight-to-next-midnight. September 1–23 has **346 rows / −12,110 DKK** before location sharing; August has **483 / −16,905 DKK**. They are separate from the hourly shift amounts in the payload and are included exactly once, signed. They are not added again from Time & Cost.
- Daily adjustment allocation uses the worker's complete same-day shifts, including later and outside-operation shifts, then clips elapsed accrual. It is explicitly estimated because the payload does not identify the precise deduction trigger instant. Identical-value entries are not deduplicated: the endpoint has no stable adjustment-instance ID.
- Time & Cost's daily/weekly supplement exclusions and optional payroll overhead make it unsuitable as an additive second payroll source. Full-shift Payroll is retained; missing actual approval is labelled scheduled. Unsupported missing pay never becomes 160 DKK/hour or zero.

## Reconciliation: useful aggregates without claiming completeness

**Allocated subtotal** is the sum of supported hourly, salary and signed-adjustment components, excluding unresolved C1/C2 and B1. It is diagnostic only: the actual public `cost` and salary percentage are null in every row until the remaining blockers are resolved. “If excluded” is a scenario requiring Ulv's decision, not an implemented business exclusion.

| Period | Allocated subtotal DKK | Unresolved C1+C2 DKK | B1 base DKK potential | Aligned revenue ex VAT | Public chain cost / % | Complete stores now / if C1+C2 excluded |
|---|---:|---:|---:|---:|---|---|
| Today | 17,745.49 | 2,210.94 | 0.00 | 77,479.20 | null / null | 0/6 → 6/6 |
| Yesterday | 18,344.14 | 2,250.00 | 591.71 | 75,971.64 | null / null | 0/6 → 5/6 |
| This Week | 53,038.78 | 6,710.94 | 591.71 | 221,764.12 | null / null | 0/6 → 5/6 |
| Last Week | 145,230.60 | 15,750.00 | 0.00 | 581,817.76 | null / null | 0/6 → 6/6 |
| September to cutoff | 477,913.86 | 51,710.94 | 591.71 | — | null / null | 0/6 → 5/6 |
| August | 687,491.01 | 67,500.00 | 0.00 | — | null / null | 0/6 → 6/6 |
| 14:32 replay | 6,305.19 | 1,362.50 | 0.00 | 23,436.96 | null / null | 0/6 → 6/6 |

Revenue is shown for the four required day/week periods and the replay. The extra August/September checks reconcile payroll coverage and allocations; no full-month revenue claim is made.

### Store-level supported components

All costs below are DKK and **incomplete diagnostic subtotals**, not deployed salary totals. All applicable sources are `estimated` because of salary or adjustment allocation. The completeness matrix above supplies the exact outstanding causes for each row.

| Period | Store | Hourly Payroll | Allocated salary | Signed adjustment | Supported subtotal | Public cost |
|---|---|---:|---:|---:|---:|---|
| Today | vesterbro | 2,307.50 | 0.00 | -105.00 | 2,202.50 | null |
| Today | indre-by | 2,544.42 | 2,035.95 | -105.00 | 4,475.37 | null |
| Today | norrebro | 1,232.50 | 614.33 | -105.00 | 1,741.83 | null |
| Today | frederiksberg | 2,625.00 | 102.41 | -70.00 | 2,657.41 | null |
| Today | fisketorvet | 3,175.00 | 0.00 | -70.00 | 3,105.00 | null |
| Today | christianshavn | 2,482.50 | 1,213.38 | -132.50 | 3,563.38 | null |
| Yesterday | vesterbro | 2,363.75 | 0.00 | -70.00 | 2,293.75 | null |
| Yesterday | indre-by | 2,883.17 | 2,071.92 | -70.00 | 4,885.09 | null |
| Yesterday | norrebro | 2,556.42 | 625.19 | -70.00 | 3,111.61 | null |
| Yesterday | frederiksberg | 1,542.50 | 104.21 | -70.00 | 1,576.71 | null |
| Yesterday | fisketorvet | 3,385.33 | 0.00 | -70.00 | 3,315.33 | null |
| Yesterday | christianshavn | 2,031.83 | 1,234.82 | -105.00 | 3,161.65 | null |
| This Week | vesterbro | 7,015.92 | 0.00 | -280.00 | 6,735.92 | null |
| This Week | indre-by | 7,190.00 | 6,179.79 | -210.00 | 13,159.79 | null |
| This Week | norrebro | 5,035.17 | 1,864.71 | -280.00 | 6,619.88 | null |
| This Week | frederiksberg | 6,913.33 | 310.84 | -210.00 | 7,014.17 | null |
| This Week | fisketorvet | 9,701.17 | 0.00 | -245.00 | 9,456.17 | null |
| This Week | christianshavn | 6,747.33 | 3,683.02 | -377.50 | 10,052.85 | null |
| Last Week | vesterbro | 18,085.42 | 0.00 | -560.00 | 17,525.42 | null |
| Last Week | indre-by | 21,894.17 | 14,503.44 | -595.00 | 35,802.61 | null |
| Last Week | norrebro | 16,664.00 | 4,376.33 | -470.96 | 20,569.37 | null |
| Last Week | frederiksberg | 20,389.17 | 729.49 | -509.04 | 20,609.62 | null |
| Last Week | fisketorvet | 28,310.42 | 0.00 | -770.00 | 27,540.42 | null |
| Last Week | christianshavn | 15,309.42 | 8,643.74 | -770.00 | 23,183.16 | null |
| September to cutoff | vesterbro | 58,327.42 | 0.00 | -1,953.48 | 56,373.94 | null |
| September to cutoff | indre-by | 70,744.92 | 47,618.19 | -1,785.00 | 116,578.11 | null |
| September to cutoff | norrebro | 50,836.92 | 14,368.51 | -1,660.96 | 63,544.47 | null |
| September to cutoff | frederiksberg | 66,459.08 | 2,395.11 | -1,489.04 | 67,365.15 | null |
| September to cutoff | fisketorvet | 92,259.50 | 0.00 | -2,590.00 | 89,669.50 | null |
| September to cutoff | christianshavn | 58,576.50 | 28,379.42 | -2,573.23 | 84,382.69 | null |
| August | vesterbro | 76,910.58 | 0.00 | -2,668.73 | 74,241.85 | null |
| August | indre-by | 103,501.33 | 67,885.29 | -2,437.86 | 168,948.76 | null |
| August | norrebro | 81,792.33 | 2,613.61 | -1,715.00 | 82,690.94 | null |
| August | frederiksberg | 89,008.75 | 13,873.40 | -2,485.00 | 100,397.15 | null |
| August | fisketorvet | 140,149.75 | 0.00 | -3,705.20 | 136,444.55 | null |
| August | christianshavn | 95,837.67 | 32,741.77 | -3,811.68 | 124,767.76 | null |
| 14:32 replay | vesterbro | 774.67 | 0.00 | -27.67 | 747.00 | null |
| 14:32 replay | indre-by | 1,314.33 | 1,254.67 | -45.55 | 2,523.45 | null |
| 14:32 replay | norrebro | 0.00 | 378.59 | -25.70 | 352.89 | null |
| 14:32 replay | frederiksberg | 941.67 | 63.11 | -2.49 | 1,002.29 | null |
| 14:32 replay | fisketorvet | 911.33 | 0.00 | -23.19 | 888.14 | null |
| 14:32 replay | christianshavn | 73.83 | 747.75 | -30.16 | 791.42 | null |

## Final implementation rules

1. Public API dates are Copenhagen calendar dates, start inclusive / end exclusive; validated cutoff cannot be future or outside the range. Maximum range 366 days. Payroll requests split by calendar month. The preceding day is used to discover crossing shifts, and prior-day Payroll is fetched only when needed for those shifts.
2. Approved matching Payroll shifts are actual; unapproved matching shifts are scheduled. Intraday clipping reconstructs only verified duration/rate arithmetic. A lump shift amount without verified timing is not blindly prorated. Salary and adjustment sharing are estimates, including historical periods; missing approval alone is not a failure.
3. Salaries use effective explicit distributions first (weekday-specific weights when configured), then a sole assignment proven for that date, otherwise complete-month shift shares for configured MonthlySalary/ScheduledHours modes. Unknown/broad NoAllocation requires C1/C2. Date-effective rules precede current membership; salary amounts are not multiplied by store count or contracted-hour guesses.
4. Payroll period salary is accrued by calendar day, clipped to elapsed Copenhagen day length, then allocated in integer øre. Current-month planned hours affect the share only. Outside targets participate in the denominator and keep their money outside. Largest-remainder allocation preserves signed øre; store components round once before chain sums.
5. The one-minute overlap estimate is limited by both time (≤60 seconds) and conservative monetary uncertainty (≤5 DKK/month). It divides shared time equally; larger conflicts, incomplete month coverage and unknown destinations remain unavailable.
6. A store failure stays local. The chain requires all six complete stores; missing wages never become zero. A complete genuine zero remains zero. Public results contain only allowlisted aggregate fields, source, cutoff, components and safe warning codes.
7. The salary numerator and displayed revenue basis use the same cutoff, including graph bucket intersections. Browser timezone does not redefine Copenhagen dates. Sales/product/channel calculations, cache budget, admission, warming and refresh behavior remain unchanged.
8. Server and browser coalesce identical salary requests. Aggregate-only caches: at most 64 entries; current TTL ≤10 minutes, historical ≤6 hours; at most 16 distinct server requests pending. Failures are not cached as successes. Profiles, shifts and tokens never enter the aggregate cache. Navigation/logout guards and progressive sidebar revenue are preserved.

## Original defects and historical comparison retained

The old reader used `payrollRes.data.data || []`, but live Payroll arrays are top-level. It consequently fell back to full scheduled durations ×160 DKK/hour, rather than the intended hybrid. It included future scheduled hours in an active-period percentage, ignored actual rates/salaries/adjustments, truncated pagination when total was absent, cached failures, converted real zero to null, summed missing stores as zero, used browser-local date conversion and could expose raw upstream errors. The PR removes that flat-rate fallback, adds bounded checked pagination, safe errors, exact periods and shared UI provenance.

The original 20,240 DKK / 28,762 DKK snapshot lacks an exact date/request and cannot be reproduced as a historical fact. At the explicit September 23 14:32 replay, the old full-day flat-rate rule gives **19,888 DKK**, while clipping that same wrong flat-rate rule gives **6,112 DKK**. Against 23,436.96 DKK ex VAT those are **84.86% vs 26.08%**. The timing-only difference is 13,776 DKK / 58.78 percentage points. Neither flat-rate result is the repaired payroll total. The repaired public result remains unavailable; its supported subtotal is in the new reconciliation above.

## Validation and privacy

- Clean isolated `npm ci`: 95 locked packages, no dependency changes, 0 audit vulnerabilities.
- Full `npm test`: **901 passing**, 129 suites, no failures. All 807 pre-existing tests remain; 17 additional follow-up tests bring payroll-specific additions to 94.
- New checks exercise exact independent-department exclusions, unknown-ID rejection, sole dated membership, no incidental-shift allocation of NoAllocation salaries, month coverage, off-day accrual, retained outside shares, effective weekdays, cross-month Payroll request splitting, overnight salary isolation, bounded overlapping hours, zero-effect fields, full-day adjustment denominator and localized failures.
- UTC, Europe/Copenhagen and America/Los_Angeles date/boundary tests pass. Existing seven Chromium session-security checks pass. Synthetic browser payroll checks pass progressive revenue, store/sidebar/chain agreement, failure/Retry and genuine zero, with no page errors in an America/Los_Angeles browser.
- API auth/CSRF, aggregate response allowlist, sanitized errors and no credential logging checks pass. Live values scanned only in memory: **0 production employee-ID matches and 0 configured credential matches** in changed JS/HTML/Markdown; no raw employee response was persisted. Final scan after document updates also found 0 full-name/email matches and no sensitive fields in the public response. All six primary departments were separately confirmed unset.
- Deterministic 4,464-record benchmark: median **1.92 ms**, p95 **6.89 ms**; 20 identical synthetic requests share one four-call sequence, warm **0.12 ms**, 1,327-byte response. This fixture has no salaried workers. Live salaried requests additionally retrieve complete month pages and bounded allocation/profile lookups; the synthetic four-call number is not a claim about that live request. The final August–September live source and privacy probe completed in 5.54 seconds.
- Node syntax checks and `git diff --check` pass. No separate lint/type-check command is configured. Browser screenshots, logs, temporary scripts and aggregate working JSON remain outside git.

## Remaining operational steps

Planday admin resolves B1 in the payroll report / shift-type configuration. Ulv supplies the two scope answers below. Codex can then encode the authorized effective rules and repeat the aggregate reconciliation, requiring six complete actual or explicitly estimated store values for all required periods before proposing readiness. Nothing here authorizes merging, deploying, changing Planday or changing production credentials/configuration.

## DECISIONS REQUIRED FROM ULV

1. **32,500 DKK/month salary with Parken activity:** Should it be outside the six-store salary percentage? Current data: NoAllocation, all-ten-department membership, five September shifts totalling 18 hours in Parken B, no six-store shifts. **Proposed default / recommendation:** classify it as outside-six-store overhead/Parken cost, provided that matches its actual role. **Alternative:** give explicit store percentages and the effective date. Exclusion adds **0 DKK** to every store; full allocation adds **32,500 DKK/month** to the chosen stores in total (1,083.33/day in September). Existing code continues to block until answered. **Answer:** `C1: outside; effective YYYY-MM-DD` or `C1: store percentages; effective YYYY-MM-DD`.
2. **35,000 DKK/month salary with only limited Nørrebro activity:** Is it chain overhead or store labour? Current data: NoAllocation, all-ten-department membership, one two-hour Nørrebro shift in September. **Proposed default / recommendation:** keep it outside store payroll as chain overhead if that is its role; do not infer a whole salary from that single shift. **Alternative:** allocate 100% to Nørrebro or supply actual store percentages. Outside adds **0 DKK** per store; 100% Nørrebro adds **35,000 DKK/month / 1,166.67 DKK per September day** to Nørrebro; any other split distributes that same pool. Existing code continues to block until answered. **Answer:** `C2: outside; effective YYYY-MM-DD` or `C2: Nørrebro 100% [or percentages]; effective YYYY-MM-DD`.

No decision is requested for proven store aliases, unrelated department exclusions, zero-effect nested fields, normal approval workflow, the bounded one-minute estimate, or the Planday-admin coverage investigation.
