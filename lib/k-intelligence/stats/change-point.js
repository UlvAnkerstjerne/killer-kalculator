'use strict';
// Single mean-shift detection for a (weekly) series.
//
// STATISTIC  Standardised CUSUM scan. For every admissible split k (left segment = x[0..k-1], right = x[k..n-1],
//   minSegment <= k <= n - minSegment) the CUSUM S_k = sum_{i<k}(x_i - xbar) is scaled by its null standard
//   deviation sigma * sqrt(k (n-k) / n), which equals the two-sample statistic
//   |mean_right - mean_left| / (sigma * sqrt(1/k + 1/(n-k))). T = max_k of that; the argmax is the location.
//   sigma is the overall standard deviation (ddof 1). Ties on T resolve to the smallest k.
//
// SIGNIFICANCE  A plain permutation test assumes exchangeability, which fails for autocorrelated weekly sales.
//   Instead the p-value comes from an AR(1) sieve bootstrap: fit phi (lag-1 Yule-Walker on the mean-removed
//   series, with Kendall's small-sample bias correction phi + (1 + 3 phi) / n, clamped to [-0.9, 0.95]),
//   resample the centred AR residuals with replacement, rebuild series of the same length through the fitted
//   AR(1) filter (50-step burn-in) and recompute T. p = (1 + #{T* >= T}) / (B + 1).
//   phi is estimated from the data as observed, so a real shift inflates phi (conservative for the null).
//   The bootstrap is seeded and deterministic.
//
// This is a model-based calibration: it targets AR(1)-type persistence. It does not model seasonality
// (deseasonalise or use complete weeks first) or multiple shifts (only the single best split is reported).
const { fail, numberArray, integer } = require('./validate');
const { createRng } = require('./prng');

const MIN_N = 12;
const MAX_N = 2000;
const DEFAULT_REPS = 499;
const BURN_IN = 50;
const DEFAULT_SEED = 20261010;

function scanStatistic(x, n, minSegment, prefix) {
  const total = prefix[n];
  const mean = total / n;
  let ss = 0;
  for (let i = 0; i < n; i++) { const d = x[i] - mean; ss += d * d; }
  const sigma = Math.sqrt(ss / (n - 1));
  if (!(sigma > 0)) return { t: 0, k: minSegment, sigma: 0 };
  let best = -1, bestK = minSegment;
  for (let k = minSegment; k <= n - minSegment; k++) {
    // S_k = prefix[k] - k * mean
    const s = Math.abs(prefix[k] - k * mean);
    const t = s / (sigma * Math.sqrt(k * (n - k) / n));
    if (t > best) { best = t; bestK = k; }
  }
  return { t: best, k: bestK, sigma };
}

function fitAr1(x, n) {
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  let c0 = 0, c1 = 0;
  for (let i = 0; i < n; i++) c0 += (x[i] - mean) * (x[i] - mean);
  for (let i = 1; i < n; i++) c1 += (x[i] - mean) * (x[i - 1] - mean);
  const raw = c0 > 0 ? c1 / c0 : 0;
  const phi = Math.min(0.95, Math.max(-0.9, raw + (1 + 3 * raw) / n));
  const residuals = new Float64Array(n - 1);
  let rMean = 0;
  for (let i = 1; i < n; i++) { residuals[i - 1] = (x[i] - mean) - phi * (x[i - 1] - mean); rMean += residuals[i - 1]; }
  rMean /= n - 1;
  for (let i = 0; i < n - 1; i++) residuals[i] -= rMean;
  return { phi, rawPhi: raw, residuals };
}

// x: weekly series of finite numbers.
// options.minSegment (REQUIRED, integer >= 3, and 2 * minSegment <= n)
// options.bootstrapReps (default 499), options.seed (uint32) or options.rng, options.alpha (default 0.05)
function detectMeanShift(x, options = {}) {
  numberArray(x, 'x', MIN_N);
  const n = x.length;
  if (n > MAX_N) fail('INVALID_INPUT', `x has more than ${MAX_N} values`);
  if (options.minSegment === undefined) fail('INVALID_OPTION', 'minSegment is required');
  const minSegment = integer(options.minSegment, 'minSegment', 3);
  if (2 * minSegment > n) fail('INSUFFICIENT_DATA', `n=${n} cannot hold two segments of at least ${minSegment}`);
  const reps = options.bootstrapReps === undefined ? DEFAULT_REPS : integer(options.bootstrapReps, 'bootstrapReps', 19, 100000);
  const alpha = options.alpha === undefined ? 0.05 : options.alpha;
  if (!(alpha > 0 && alpha < 1)) fail('INVALID_OPTION', 'alpha must be in (0, 1)');
  const rng = options.rng || createRng(options.seed === undefined ? DEFAULT_SEED : options.seed);

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i];
  const observed = scanStatistic(x, n, minSegment, prefix);
  const base = { n, minSegment, method: 'standardised-cusum-scan, AR(1) sieve bootstrap', bootstrapReps: reps, alpha };
  if (observed.sigma === 0) {
    // Constant series: there is nothing to detect and the statistic is undefined.
    const m = prefix[n] / n;
    return { ...base, degenerate: true, detected: false, location: null, beforeMean: m, afterMean: m, delta: 0,
      effectSize: 0, statistic: 0, pValue: 1, phi: 0 };
  }

  const k = observed.k;
  const beforeMean = prefix[k] / k, afterMean = (prefix[n] - prefix[k]) / (n - k);
  let within = 0;
  for (let i = 0; i < n; i++) { const d = x[i] - (i < k ? beforeMean : afterMean); within += d * d; }
  const pooledSd = Math.sqrt(within / (n - 2));
  const effectSize = pooledSd > 0 ? (afterMean - beforeMean) / pooledSd : (afterMean === beforeMean ? 0 : Infinity);

  const { phi, residuals } = fitAr1(x, n);
  const m = residuals.length;
  const series = new Float64Array(n), sim = new Float64Array(n + 1);
  let exceed = 0;
  for (let b = 0; b < reps; b++) {
    let prev = 0;
    for (let i = 0; i < BURN_IN; i++) prev = phi * prev + residuals[rng.int(m)];
    let sum = 0;
    sim[0] = 0;
    for (let i = 0; i < n; i++) {
      prev = phi * prev + residuals[rng.int(m)];
      series[i] = prev;
      sum += prev;
      sim[i + 1] = sum;
    }
    if (scanStatistic(series, n, minSegment, sim).t >= observed.t) exceed++;
  }
  const pValue = (1 + exceed) / (reps + 1);
  return { ...base, degenerate: false, detected: pValue < alpha, location: k, beforeMean, afterMean,
    delta: afterMean - beforeMean, effectSize, statistic: observed.t, pValue, phi };
}

module.exports = { detectMeanShift, MIN_N, MAX_N, DEFAULT_REPS, DEFAULT_SEED };
