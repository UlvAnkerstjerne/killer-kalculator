# K-Intelligence statistics primitives (T1-S / T1-S2)

Pure, deterministic CommonJS functions. No database, network, clock, `Math.random` or npm dependency.
Every function validates its input and throws `StatsError` (`error.code`: `INVALID_INPUT`, `EMPTY_INPUT`,
`INSUFFICIENT_DATA`, `INVALID_OPTION`, `NUMERIC_FAILURE`) on NaN, Infinity, non-numbers, empty or too-short input.
Nothing is silently repaired; `null` is accepted only as an explicit "no value" in `sameWeekdayBaseline`.

## STATUS: no trend test or change-point calibration is approved for gating

The T1-S2 pre-registered comparison selected **no winner** in either family (tables below), so **no default is wired**:
`trendTest` and `detectMeanShift` require an explicit `method` / `phiFit` (`defaults.*` are `null`). Nothing in this
library may gate a finding until a new decision is made. Plain `mannKendall` and `hamedRaoReference` are labelled as
assuming independence / not for gating.

```js
const stats = require('./lib/k-intelligence/stats');
```

| Function | Purpose |
|---|---|
| `median`, `mad(values, {scaled})`, `MAD_SCALE` | Robust centre/scale. Scaled MAD = 1.4826 x MAD. |
| `sameWeekdayBaseline(series, targetDate, {lookbackWeeks=8, minObservations=4})` | Median/MAD of the same ISO weekday over the weeks before `targetDate`. `null` and `eligible:false` days are excluded and listed, never zero-filled. Returns `sufficient:false` with null statistics when too few remain. |
| `robustZ(value, baseline)` | `(value - median) / scaledMAD`; `null` (not Infinity) when the scale is 0 or the baseline is insufficient. |
| `theilSen(y, {x, confidence})`, `senSlope(y)` | Theil-Sen slope/intercept. Sen's interval is only `referenceIndependenceCi` (assumes independent observations). |
| `trendTest(x, {method, bootstrapReps, seed, rng})` | Autocorrelation-aware trend test. `method`: `'sieve-bootstrap'` (A) or `'prewhitened-mk'` (B). No default (see status). |
| `trendInterval(x, {confidence, bootstrapReps, seed, rng})` | User-facing slope interval: sieve-bootstrap percentile interval. Attaches `referenceIndependenceCi`. |
| `analyzeTrend(x, options)` | `{test, interval}` in one call. |
| `mannKendall(x)` | Tie-corrected Mann-Kendall. **Assumes independence** (`assumesIndependence:true`). |
| `hamedRaoReference(x)` | Hamed-Rao variance correction. **Reference implementation, `gating:false`, not for gating.** |
| `benjaminiHochberg(p, {familySize, alpha})` | BH q-values in input order; stable ties; optional larger family size. |
| `detectMeanShift(x, {minSegment, phiFit, bootstrapReps, seed, rng})` | Single mean shift in a weekly series. `minSegment` required; `phiFit`: `'global'` (C1) or `'segment'` (C2), no default. |
| `normalCdf`, `normalSf`, `twoSidedP`, `normalQuantile`, `erfc` | In-repo normal distribution, relative error <= 1e-10 (measured 2.3e-13 worst CDF case at z=-37, 1.9e-15 quantile). |
| `createRng(seed)` | xoshiro128** seeded via splitmix32: `uniform`, `int`, `normal`, `nextUint32`. |

## Methods

**AR(1) sieve (ar1.js).** phi from lag-1 Yule-Walker on the mean-removed input, Kendall's bias correction
`phi + (1 + 3 phi) / n`, clamped to [-0.9, 0.95]; innovations are the centred AR residuals; bootstrap paths are rebuilt
from resampled innovations through the AR(1) filter (50-step burn-in); `p = (1 + #{T* >= T}) / (B + 1)`.

**Candidate A, `sieve-bootstrap`.** Statistic: Mann-Kendall **S** (rank-based). Null model: AR(1) fitted to the
**Theil-Sen-detrended residuals** (a real trend cannot inflate phi); bootstrap null series are pure AR(1) with **no trend**.
Two-sided: `|S*| >= |S|`.

**Candidate B, `prewhitened-mk`.** Kulkarni-von Storch style: phi = lag-1 autocorrelation of the series (no bias correction,
equals `pymannkendall.pre_whitening_modification_test`, verified on the fixtures), `y_t = x_t - phi x_(t-1)`, then tie-corrected MK.
Known cost: a real trend inflates phi and removes power.

**Trend interval.** Bootstrap series = fitted Theil-Sen line + AR(1) noise from the **same AR fit as candidate A**; the interval
is the type-7 percentile interval of the Theil-Sen slope of the bootstrap series (default 999 replicates).

**Change point.** Standardised CUSUM scan (equivalently the maximally selected two-sample statistic), minimum segment length
required, location = argmax (smallest on ties), effect size = shift / pooled within-segment sd, significance by the AR(1) sieve bootstrap.
C1 (`phiFit:'global'`) fits phi on the series with only its overall mean removed; C2 (`phiFit:'segment'`) fits phi on the residuals after removing
the two segment means at the best split.

**Mann-Kendall, Theil-Sen, Benjamini-Hochberg.** As in T1-S: tie-corrected Var(S), continuity-corrected Z, scipy-identical Theil-Sen
(round-half-even Sen indices), BH with stable ranking and `familySize`.

**Hamed-Rao decision.** Kept, in `hamed-rao-reference.js`, because it reproduces pymannkendall exactly (a useful cross-check of the
tie-corrected statistics) and documents the failure. Every result carries `gating:false` and a warning.

## Pre-registered comparison (T1-S2)

Rule fixed before any result existed (committed in `7b06f3b`; code in `test/k-intelligence/stats/sim-harness.js`):
discard any candidate with FPR > 0.07 in **any** null cell; among survivors pick the higher mean power (trend: the four trend power
cells; change point: the four shift power cells); a difference <= 0.02 goes to B (trend) / C1 (change point); if nobody survives, report that and stop.
Setup: n in {52, 90}; null = AR(1) phi 0 / 0.3 / 0.6 with N(0,1) innovations plus one mismatched AR(2)(0.5, 0.2) with Student-t(df=4) innovations; power = AR(1) phi 0.3 with a
planted linear trend (total change 0.5 / 1.0 innovation SD) or a level shift (0.5 / 1.0 SD at 40% of the series); 2,000 replicates per null cell,
1,000 per power cell, 199 bootstrap replicates, alpha 0.05, minSegment 8, all methods on identical series per cell, fixed seeds. Run with `npm run sim:kintel` (about 150 s).

**False-positive rate (limit 0.07)**

| cell | A | B | C1 | C2 |
|---|---|---|---|---|
| null n=52 AR1 phi=0 | 0.0570 | 0.0520 | 0.0340 | 0.0750 |
| null n=52 AR1 phi=0.3 | 0.0585 | 0.0525 | 0.0225 | 0.0900 |
| null n=52 AR1 phi=0.6 | 0.0690 | 0.0490 | 0.0235 | 0.1285 |
| null n=52 AR2(.5,.2) t4 | 0.1565 | 0.1135 | 0.0850 | 0.2835 |
| null n=90 AR1 phi=0 | 0.0465 | 0.0455 | 0.0355 | 0.0590 |
| null n=90 AR1 phi=0.3 | 0.0445 | 0.0410 | 0.0305 | 0.0685 |
| null n=90 AR1 phi=0.6 | 0.0700 | 0.0600 | 0.0365 | 0.1185 |
| null n=90 AR2(.5,.2) t4 | 0.1305 | 0.1110 | 0.1170 | 0.2555 |
| **max** | **0.1565** | **0.1135** | **0.1170** | **0.2835** |

**Power, planted-trend cells**

| cell | A | B | C1 | C2 |
|---|---|---|---|---|
| trend n=52 0.5SD | 0.1180 | 0.0960 | 0.0610 | 0.1500 |
| trend n=52 1SD | 0.3000 | 0.2480 | 0.1490 | 0.3510 |
| trend n=90 0.5SD | 0.1670 | 0.1600 | 0.1030 | 0.1790 |
| trend n=90 1SD | 0.4610 | 0.4110 | 0.2750 | 0.4520 |
| **mean** | **0.2615** | **0.2288** | **0.1470** | **0.2830** |

**Power, planted-shift cells**

| cell | A | B | C1 | C2 |
|---|---|---|---|---|
| shift n=52 0.5SD | 0.1590 | 0.1270 | 0.0840 | 0.2170 |
| shift n=52 1SD | 0.4370 | 0.3150 | 0.2660 | 0.5710 |
| shift n=90 0.5SD | 0.2630 | 0.2260 | 0.1600 | 0.2910 |
| shift n=90 1SD | 0.6990 | 0.6100 | 0.5800 | 0.7750 |
| **mean** | **0.3895** | **0.3195** | **0.2725** | **0.4635** |

**Outcome: no winner.** Trend: A max FPR 0.1565, B 0.1135 — both fail. Change point: C1 max 0.1170, C2 0.2835 — both fail.
Every failure is in the mismatched AR(2)+t(4) null. In the six plain AR(1) null cells A (<= 0.0700, i.e. not above the limit), B (<= 0.0600) and C1 (<= 0.0365) stay within 0.07, C2 does not
(up to 0.1285). Mean power is low for small effects (trend 0.5 SD: 0.10-0.17), and the winners' power advantage was never evaluated because the rule stopped at the FPR gate.
The thresholds were not adjusted.

## Interval coverage (informational, not part of the selection)

`node test/k-intelligence/stats/interval-coverage.js` — nominal 95%, trend of total change 1.0 SD, 300 replicates per cell, 199 bootstrap replicates (standard error about 0.013):

| cell | bootstrap interval | Sen independence interval |
|---|---|---|
| n=52 phi=0.3 | 0.887 | 0.833 |
| n=52 phi=0.6 | 0.877 | 0.700 |
| n=90 phi=0.3 | 0.923 | 0.863 |
| n=90 phi=0.6 | 0.917 | 0.660 |

The bootstrap interval is clearly better than Sen's but still **undercovers** (0.88-0.92 against 0.95); intervals should be described as approximate.

## Limitations

* No trend test or change-point calibration passed the pre-registered gate; none may gate findings.
* The sieve methods model AR(1) persistence; heavier-tailed or higher-order dependence (AR(2)+t(4) null) inflates their false-positive rate.
* One shift only; no seasonality handling (use complete weeks / deseasonalise first).
* Simulation covers synthetic series (iid-driven AR), not real sales data; power was evaluated only at phi 0.3.
* PRNG output is pinned as a regression test, not against an external reference vector.
* Theil-Sen is O(n^2); trend inputs are capped at 1,000 points, Theil-Sen alone at 4,000.
