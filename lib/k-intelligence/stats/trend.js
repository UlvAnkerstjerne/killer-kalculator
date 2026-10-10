'use strict';
// Trend test and trend interval that account for autocorrelation.
//
// Two candidate tests (compared in the pre-registered simulation; see README):
//   'sieve-bootstrap' (A)  Statistic: Mann-Kendall S (rank-based, invariant to monotone transforms).
//        Null model: AR(1) fitted to the THEIL-SEN-DETRENDED residuals (so a real trend cannot inflate phi),
//        same bias correction and clamp as the change-point test (ar1.js). Bootstrap series are pure AR(1)
//        paths with NO trend. p = (1 + #{|S*| >= |S|}) / (B + 1).
//   'prewhitened-mk'  (B)  Kulkarni-von Storch style: phi = lag-1 Yule-Walker autocorrelation of the series
//        (no bias correction), y_t = x_t - phi * x_{t-1} (t = 2..n), then the tie-corrected Mann-Kendall test
//        on y. Equals pymannkendall.pre_whitening_modification_test. Known cost: a real trend inflates phi and
//        removes power.
//
// `trendInterval` is the user-facing uncertainty for the slope: a sieve-bootstrap PERCENTILE interval of the
// Theil-Sen slope. Bootstrap series are the fitted Theil-Sen line plus AR(1) noise from the SAME AR fit as
// candidate A. Sen's independence interval is only attached as `referenceIndependenceCi`.
const { fail, numberArray, integer, probability } = require('./validate');
const { createRng } = require('./prng');
const { fitAr1, simulateAr1, PHI_MIN, PHI_MAX } = require('./ar1');
const { mannKendall, mkScore, basicStatistics } = require('./mann-kendall');
const { theilSen, senSlope } = require('./theil-sen');
const { median } = require('./robust');

const MIN_N = 12;
const MAX_N = 1000;
const DEFAULT_REPS = 499;
const DEFAULT_SEED = 20261010;
const METHODS = ['sieve-bootstrap', 'prewhitened-mk'];
// Wired from the pre-registered A-vs-B selection (see README / sim-run output).
const DEFAULT_TREND_METHOD = null;

function pickMethod(method) {
  const chosen = method === undefined ? DEFAULT_TREND_METHOD : method;
  if (!METHODS.includes(chosen)) fail('INVALID_OPTION', `method must be one of ${METHODS.join(', ')}`);
  return chosen;
}

function theilSenLine(x) {
  const n = x.length;
  const slope = senSlope(x);
  const intercept = median(Array.from(x)) - slope * ((n - 1) / 2);
  return { slope, intercept };
}

function sieveFromDetrended(x) {
  const n = x.length;
  const { slope, intercept } = theilSenLine(x);
  const residuals = new Float64Array(n);
  for (let i = 0; i < n; i++) residuals[i] = x[i] - (intercept + slope * i);
  return { slope, intercept, ar: fitAr1(residuals) };
}

function validateSeries(x) {
  numberArray(x, 'x', MIN_N);
  if (x.length > MAX_N) fail('INVALID_INPUT', `x has more than ${MAX_N} values`);
}

function resolveRng(options) { return options.rng || createRng(options.seed === undefined ? DEFAULT_SEED : options.seed); }

// options: method, bootstrapReps (sieve only, default 499), seed | rng, alpha (default 0.05)
function trendTest(x, options = {}) {
  validateSeries(x);
  const method = pickMethod(options.method);
  const alpha = options.alpha === undefined ? 0.05 : probability(options.alpha, 'alpha');
  const n = x.length;
  const stats = basicStatistics(x);
  const common = { method, n, alpha, s: stats.s, tau: stats.tau, tauB: stats.tauB };
  if (!(stats.varSTie > 0)) return { ...common, degenerate: true, p: 1, reject: false, direction: 'none', slope: 0 };

  if (method === 'prewhitened-mk') {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i];
    mean /= n;
    let c0 = 0, c1 = 0;
    for (let i = 0; i < n; i++) c0 += (x[i] - mean) * (x[i] - mean);
    for (let i = 1; i < n; i++) c1 += (x[i] - mean) * (x[i - 1] - mean);
    const phi = Math.min(PHI_MAX, Math.max(PHI_MIN, c0 > 0 ? c1 / c0 : 0));
    const y = new Float64Array(n - 1);
    for (let i = 1; i < n; i++) y[i - 1] = x[i] - phi * x[i - 1];
    const mk = mannKendall(y, { alpha });
    return { ...common, degenerate: mk.degenerate, phi, sPrewhitened: mk.s, z: mk.z, p: mk.p, reject: mk.reject,
      direction: mk.direction, slope: senSlope(x) };
  }

  const reps = options.bootstrapReps === undefined ? DEFAULT_REPS : integer(options.bootstrapReps, 'bootstrapReps', 19, 100000);
  const rng = resolveRng(options);
  const { slope, ar } = sieveFromDetrended(x);
  const observed = Math.abs(stats.s);
  const series = new Float64Array(n);
  let exceed = 0;
  for (let b = 0; b < reps; b++) {
    simulateAr1(ar.phi, ar.residuals, n, rng, series);
    if (Math.abs(mkScore(series, n)) >= observed) exceed++;
  }
  const p = (1 + exceed) / (reps + 1);
  const reject = p < alpha;
  return { ...common, degenerate: false, phi: ar.phi, bootstrapReps: reps, p, reject,
    direction: reject ? (stats.s > 0 ? 'increasing' : 'decreasing') : 'none', slope };
}

// Sieve-bootstrap percentile interval for the Theil-Sen slope (per observation step).
// options: confidence (default 0.95), bootstrapReps (default 999), seed | rng
function trendInterval(x, options = {}) {
  validateSeries(x);
  const confidence = options.confidence === undefined ? 0.95 : probability(options.confidence, 'confidence');
  const reps = options.bootstrapReps === undefined ? 999 : integer(options.bootstrapReps, 'bootstrapReps', 19, 100000);
  const rng = resolveRng(options);
  const n = x.length;
  const { slope, intercept, ar } = sieveFromDetrended(x);
  const noise = new Float64Array(n), path = new Float64Array(n), buffer = new Float64Array(n * (n - 1) / 2);
  const slopes = new Float64Array(reps);
  for (let b = 0; b < reps; b++) {
    simulateAr1(ar.phi, ar.residuals, n, rng, noise);
    for (let i = 0; i < n; i++) path[i] = intercept + slope * i + noise[i];
    slopes[b] = senSlope(path, buffer);
  }
  slopes.sort();
  const quantile = q => { // type-7 (linear interpolation), as numpy's default
    const h = (reps - 1) * q, lo = Math.floor(h), hi = Math.ceil(h);
    return slopes[lo] + (h - lo) * (slopes[hi] - slopes[lo]);
  };
  return { slope, low: quantile((1 - confidence) / 2), high: quantile(1 - (1 - confidence) / 2), confidence,
    bootstrapReps: reps, phi: ar.phi, method: 'sieve-bootstrap-percentile',
    referenceIndependenceCi: theilSen(x, { confidence }).referenceIndependenceCi };
}

// Test + interval in one call, with the (labelled) independence interval attached.
function analyzeTrend(x, options = {}) {
  return { test: trendTest(x, options), interval: trendInterval(x, options) };
}

module.exports = { trendTest, trendInterval, analyzeTrend, METHODS, DEFAULT_TREND_METHOD, MIN_N, MAX_N, DEFAULT_REPS };
