'use strict';
// Mann-Kendall trend test (Mann 1945, Kendall 1975) with
//   * tie-corrected variance of S, and
//   * the Hamed & Rao (1998) autocorrelation-corrected variance.
//
// Hamed-Rao as implemented here:
//   1. detrend with the Theil-Sen slope b (x_t - b*t, t = 1..n) and rank the residuals (average ranks for ties);
//   2. rho_i = biased sample autocorrelation of those ranks (denominator n, as in Hamed & Rao and pymannkendall);
//   3. LAG RULE: only lags 1..L with L = floor(n / 3) are considered, and only those whose |rho_i| exceeds
//      the two-sided 95 % bound z_{0.975} / sqrt(n) enter the correction ("significant lags");
//   4. n/n* = 1 + 2 / (n(n-1)(n-2)) * sum_i (n-i)(n-i-1)(n-i-2) rho_i
//      and Var*(S) = Var(S) * n/n*;
//   5. CLAMP: unless allowDeflation is set, n/n* is floored at 1, so the corrected test is never more
//      liberal than the tie-corrected one (a negative-autocorrelation estimate on short series would
//      otherwise shrink the variance). The result reports nsClamped when the floor was applied.
// Z uses the standard continuity correction ((S -/+ 1) / sd); p is two-sided from the normal tail.
// n/n* is also known as the variance inflation factor.
const { fail, numberArray, probability } = require('./validate');
const { normalQuantile, twoSidedP } = require('./normal');
const { theilSen } = require('./theil-sen');

const MIN_N = 8;
const MAX_N = 4000;

function mkScore(x, n) {
  let s = 0;
  for (let i = 0; i < n - 1; i++) {
    const xi = x[i];
    for (let j = i + 1; j < n; j++) s += x[j] > xi ? 1 : x[j] < xi ? -1 : 0;
  }
  return s;
}

// Tie groups -> sum t(t-1)(2t+5)
function tieTerm(x) {
  const s = Float64Array.from(x).sort();
  let total = 0, run = 1;
  for (let i = 1; i <= s.length; i++) {
    if (i < s.length && s[i] === s[i - 1]) run++;
    else { total += run * (run - 1) * (2 * run + 5); run = 1; }
  }
  return total;
}

// Average ranks (1-based), ties share the mean rank.
function averageRanks(values) {
  const n = values.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b] || a - b);
  const ranks = new Float64Array(n);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]] = rank;
    i = j + 1;
  }
  return ranks;
}

function autocorrelations(values, maxLag) {
  const n = values.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += values[i];
  mean /= n;
  const centered = new Float64Array(n);
  for (let i = 0; i < n; i++) centered[i] = values[i] - mean;
  let c0 = 0;
  for (let i = 0; i < n; i++) c0 += centered[i] * centered[i];
  const rho = new Float64Array(maxLag + 1);
  rho[0] = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    let c = 0;
    for (let i = lag; i < n; i++) c += centered[i] * centered[i - lag];
    rho[lag] = c0 === 0 ? 0 : c / c0;
  }
  return rho;
}

// Variance inflation factor n/n* from the first-significant-lags rule.
function hamedRaoFactor(x, { slope, lagFraction = 1 / 3 }) {
  const n = x.length;
  const detrended = new Float64Array(n);
  for (let i = 0; i < n; i++) detrended[i] = x[i] - slope * (i + 1);
  const ranks = averageRanks(detrended);
  const maxLag = Math.max(1, Math.floor(n * lagFraction));
  const rho = autocorrelations(ranks, maxLag);
  const bound = normalQuantile(0.975) / Math.sqrt(n);
  let sum = 0;
  const lagsUsed = [];
  for (let i = 1; i <= maxLag; i++) {
    if (Math.abs(rho[i]) > bound) { sum += (n - i) * (n - i - 1) * (n - i - 2) * rho[i]; lagsUsed.push(i); }
  }
  return { factor: 1 + (2 / (n * (n - 1) * (n - 2))) * sum, maxLag, lagsUsed, bound };
}

// options.correction: 'hamed-rao' (default) | 'none' (tie-corrected variance only)
// options.alpha: decision level for `reject`/`direction` (default 0.05)
// options.allowDeflation: permit n/n* < 1 (reference-matching; default false)
function mannKendall(x, { correction = 'hamed-rao', alpha = 0.05, allowDeflation = false } = {}) {
  numberArray(x, 'x', MIN_N);
  const n = x.length;
  if (n > MAX_N) fail('INVALID_INPUT', `x has more than ${MAX_N} values`);
  if (correction !== 'hamed-rao' && correction !== 'none') fail('INVALID_OPTION', "correction must be 'hamed-rao' or 'none'");
  probability(alpha, 'alpha');

  const s = mkScore(x, n);
  const n0 = n * (n - 1) / 2;
  const varSTie = (n * (n - 1) * (2 * n + 5) - tieTerm(x)) / 18;
  const tau = s / n0; // Kendall tau-a, as pymannkendall reports
  const tauDenominator = Math.sqrt((n0 - tieTerm1(x)) * n0);
  const tauB = tauDenominator === 0 ? 0 : s / tauDenominator;

  const result = { n, s, tau, tauB, varSTie, varSUsed: varSTie, variance: 'tie-corrected', nsFactor: 1, nsClamped: false,
    lagRule: null, lagsUsed: [], degenerate: false, alpha };
  if (!(varSTie > 0)) {
    // Every value tied: no information, not an error and never NaN.
    return { ...result, degenerate: true, z: 0, p: 1, reject: false, direction: 'none' };
  }
  if (correction === 'hamed-rao') {
    const slope = theilSen(x).slope;
    const hr = hamedRaoFactor(x, { slope });
    let factor = hr.factor;
    if (!allowDeflation && factor < 1) { factor = 1; result.nsClamped = true; }
    if (!(factor > 0)) fail('NUMERIC_FAILURE', 'non-positive Hamed-Rao variance factor; use allowDeflation=false');
    result.nsFactor = factor;
    result.varSUsed = varSTie * factor;
    result.variance = result.nsClamped ? 'hamed-rao-clamped' : 'hamed-rao';
    result.lagRule = `first significant lags 1..floor(n/3)=${hr.maxLag} at |rho| > ${hr.bound.toFixed(6)}`;
    result.lagsUsed = hr.lagsUsed;
  }
  const sd = Math.sqrt(result.varSUsed);
  const z = s > 0 ? (s - 1) / sd : s < 0 ? (s + 1) / sd : 0;
  const p = twoSidedP(z);
  const reject = p < alpha;
  return { ...result, z, p, reject, direction: reject ? (z > 0 ? 'increasing' : 'decreasing') : 'none' };
}

// sum over tie groups of t(t-1)/2 (for tau-b)
function tieTerm1(x) {
  const s = Float64Array.from(x).sort();
  let total = 0, run = 1;
  for (let i = 1; i <= s.length; i++) {
    if (i < s.length && s[i] === s[i - 1]) run++;
    else { total += run * (run - 1) / 2; run = 1; }
  }
  return total;
}

module.exports = { mannKendall, MIN_N, MAX_N, averageRanks, autocorrelations };
