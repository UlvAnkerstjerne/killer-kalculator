# K-Intelligence statistics primitives (T1-S)

Pure, deterministic CommonJS functions. No database, network, clock, `Math.random` or npm dependency.
Every function validates its input and throws `StatsError` (`error.code`: `INVALID_INPUT`, `EMPTY_INPUT`,
`INSUFFICIENT_DATA`, `INVALID_OPTION`, `NUMERIC_FAILURE`) on NaN, Infinity, non-numbers, empty or too-short input.
Nothing is silently repaired; `null` is accepted only as an explicit "no value" in `sameWeekdayBaseline`.

```js
const stats = require('./lib/k-intelligence/stats');
```

| Function | Purpose |
|---|---|
| `median`, `mad(values, {scaled})`, `MAD_SCALE` | Robust centre/scale. Scaled MAD = 1.4826 x MAD (consistent for sigma under normality). |
| `sameWeekdayBaseline(series, targetDate, {lookbackWeeks=8, minObservations=4})` | Median/MAD of the same ISO weekday over the weeks before `targetDate`. `null` values and `eligible:false` days are excluded and listed, never zero-filled. Returns `sufficient:false` with null statistics when too few days remain. |
| `robustZ(value, baseline)` | `(value - median) / scaledMAD`; `null` (not Infinity) when the scale is 0 or the baseline is insufficient. |
| `theilSen(y, {x, confidence=0.95})` | Theil-Sen slope/intercept with the Sen (1968, eq. 2.6) CI, identical to `scipy.stats.theilslopes`. |
| `mannKendall(x, {correction='hamed-rao'\|'none', alpha, allowDeflation})` | S, Z, p, n, tau (tau-a), tauB, the variance used. |
| `benjaminiHochberg(p, {familySize, alpha})` | BH q-values in input order; stable ties; optional larger family size. |
| `detectMeanShift(x, {minSegment, bootstrapReps, seed, rng})` | Single mean shift in a weekly series. `minSegment` is required. |
| `normalCdf`, `normalSf`, `twoSidedP`, `normalQuantile`, `erfc` | In-repo normal distribution, relative error <= 1e-10 (measured: 2.3e-13 CDF worst case at z=-37, 1.9e-15 quantile). |
| `createRng(seed)` | xoshiro128** seeded via splitmix32: `uniform`, `int`, `normal`, `nextUint32`. |

## Methods and decisions

**Mann-Kendall.** S = sum of signs of all pairwise later-minus-earlier differences. Tie-corrected
Var(S) = (n(n-1)(2n+5) - sum t(t-1)(2t+5)) / 18. Z uses the continuity correction ((S-1)/sd for S>0, (S+1)/sd for S<0).
p is two-sided from the in-repo normal tail (accurate far into the tail). All-tied input is reported as `degenerate`
(Z=0, p=1), never NaN. Minimum n = 8.

**Hamed-Rao autocorrelation correction (Hamed & Rao 1998).** Detrend with the Theil-Sen slope, rank the residuals,
take the biased sample autocorrelation of the ranks, and inflate Var(S) by n/n* = 1 + 2/(n(n-1)(n-2)) * sum (n-i)(n-i-1)(n-i-2) rho_i.

* *Lag rule:* only lags 1..floor(n/3) are considered, and only lags with |rho_i| > 1.96/sqrt(n) enter the sum. This rule
  was fixed before any simulation was run. With `allowDeflation: true` the result equals
  `pymannkendall.hamed_rao_modification_test(x, lag=floor(n/3))` to ~1e-13 relative (verified on the committed fixtures
  and on 797 simulated series).
* *Clamp (deviation from the reference):* by default n/n* is floored at 1 and the result says `variance:'hamed-rao-clamped'`.
  The unclamped reference factor can fall below 1 (0.20 on one fixture) or even go negative (NaN in the reference), which
  would make the corrected test more liberal than the uncorrected one.
* *Known limitation:* see "Null simulation" below; this correction does **not** meet a 0.07 false-positive bar for phi >= 0.3.

**Theil-Sen CI.** Order statistics of the sorted pairwise slopes at ranks round_half_even((N -/+ z*sigma)/2) with the
tie-corrected Kendall sigma, exactly as scipy. If sigma = 0 (constant series) the CI is `null`.

**Benjamini-Hochberg.** q_(i) = min over j >= i of p_(j) * m / j, capped at 1. Ranking is stable (p, then input position);
tied p-values get equal q. `familySize` m >= number of supplied p-values lets the caller count tests that produced no p-value.
Valid for independent or positively dependent tests; it does not make correlated tests independent.

**Mean-shift detection.** Standardised CUSUM scan: for each split k in [minSegment, n-minSegment] the statistic is
|mean_right - mean_left| / (sigma * sqrt(1/k + 1/(n-k))) with sigma the overall sd; T = max_k, location = argmax (smallest k on
ties). The effect size is (after - before) / pooled within-segment sd. Significance is an **AR(1) sieve bootstrap**
(phi from lag-1 Yule-Walker with Kendall's small-sample bias correction, clamped to [-0.9, 0.95]; resampled centred AR
residuals; 50-step burn-in; p = (1 + #{T* >= T}) / (B + 1), default B = 499, deterministic seed). A permutation test
was rejected because autocorrelation violates exchangeability. Only one shift is reported; the series should be
free of seasonality (use complete weeks / deseasonalise first). Constant series -> `degenerate`, p = 1.

## Null simulation (see `test/k-intelligence/stats/null-simulation.test.js`)

Empirical false-positive rate at alpha 0.05 on trend-free, shift-free weekly series (complete-week means of a daily series
with a strong weekday pattern, weekly AR(1) level with coefficient phi, daily noise), 2,000 replicates per cell, fixed seeds:

| n weeks | phi | plain MK | Hamed-Rao MK | change-point |
|---|---|---|---|---|
| 52 | 0.0 | 0.0610 | 0.0595 | 0.0310 |
| 52 | 0.3 | 0.1445 | 0.1225 | 0.0245 |
| 52 | 0.6 | 0.3000 | 0.1910 | 0.0240 |
| 90 | 0.0 | 0.0490 | 0.0475 | 0.0275 |
| 90 | 0.3 | 0.1315 | 0.0990 | 0.0370 |
| 90 | 0.6 | 0.3000 | 0.1600 | 0.0355 |

The change-point method meets the 0.07 bar in every cell. **The Hamed-Rao correction does not** (phi >= 0.3), so the
corresponding acceptance test is marked `todo` in the suite instead of being loosened. Treat the corrected MK p-value as
still anticonservative for autocorrelated weekly series until it is replaced or re-specified.
