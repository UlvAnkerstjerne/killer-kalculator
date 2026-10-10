# Reference fixtures (provenance)

All expected values in these JSON files were computed **outside the repo** with a throw-away Python virtualenv; no Python
exists in the repo. Generated 2026-10-10 on macOS (Python 3.9.6):

| Library | Exact version |
|---|---|
| numpy | 2.0.2 |
| scipy | 1.13.1 |
| statsmodels | 0.14.6 |
| pymannkendall | 1.4.3 |
| (transitive) pandas 2.3.3, patsy 1.0.3 | |

Synthetic inputs come from `numpy.random.default_rng(20261010)` (single stream, fixed draw order) and are stored inline in the
JSON, so the JavaScript tests never need numpy. Values are rounded to 10 decimals (2 for revenue-scale data, 4 for change-point inputs).
NaN results in the references are stored as `null`.

| File | Contents | Reference calls |
|---|---|---|
| `normal.json` | 36 z-values (to +-37) and 24 probabilities (1e-300 .. 1-1e-10) | `scipy.stats.norm.cdf`, `.sf`, `.ppf` |
| `mk-theil-sen.json` | 12 series (trend, AR(1) phi 0.6 / -0.5, ties, n = 8..90, monotone, sine, revenue scale) plus one uneven/tied-x Theil-Sen case | `pymannkendall.original_test(x)`; `pymannkendall.hamed_rao_modification_test(x, lag=n//3)` (lag = first `n//3` lags); `scipy.stats.kendalltau(arange(n), x, variant='b')`; `pymannkendall.pre_whitening_modification_test(x)` (recorded as `preWhitening`); `scipy.stats.theilslopes(x, alpha=0.95 and 0.90)` (`method='separate'`); `2*scipy.stats.norm.sf(abs(z))` recorded as `pSf` |
| `robust.json` | median/MAD cases and a 140-day same-weekday baseline (nulls and ineligible days on Thursdays, target 2026-05-14, 8 weeks, min 4) | `numpy.median`, `scipy.stats.median_abs_deviation(scale=1.0 / 'normal')` |
| `bh.json` | six p-value sets (mixed, ties, unsorted, single, extremes, all ones) and one family-size case | `statsmodels.stats.multitest.multipletests(method='fdr_bh')`, cross-asserted equal to `scipy.stats.false_discovery_control(method='bh')` at rtol 1e-12 |
| `change-point.json` | four series x minSegment 4 and 8: location, segment means, effect size, scan statistic | plain numpy loops (explicit two-sample formula); there is no library reference for the bootstrap p-value |

**Why `pSf`.** `pymannkendall` reports `p = 2*(1 - norm.cdf(|z|))`, which loses precision below ~1e-8 (observed 7e-9 relative
error at p = 1.4e-8). The tests therefore compare p against `2*norm.sf(|z|)` computed from the reference z; S, variances,
Z and tau are compared against the libraries' own values.

**Edge cases where the reference is undefined or deliberately not matched** (covered by dedicated tests, not fixtures of equality):
`min_n8` (Hamed-Rao factor is negative -> reference Z is NaN), `monotone_decreasing_n15` (0/0 autocorrelation of constant
ranks -> NaN; this library defines rho = 0), `ar1_phi_neg05_n40` (reference factor 0.2035 < 1; the default clamps it).

Not externally referenced: the PRNG (pinned as a regression test only) and the bootstrap p-value of the change-point test
(validated by the null simulation and planted-shift tests).
