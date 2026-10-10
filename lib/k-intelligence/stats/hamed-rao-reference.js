'use strict';
// *** REFERENCE IMPLEMENTATION — NOT FOR GATING. ***
// Hamed & Rao (1998) autocorrelation-corrected Mann-Kendall, kept so the T1-S failure can be reproduced and
// compared with pymannkendall. In the null simulation it stays anticonservative for phi >= 0.3 (false-positive
// rate 0.10-0.19 at alpha 0.05) with every lag rule tried, so no finding may depend on its p-value.
// Use trend.js (`trendTest`) instead. Every result carries `gating:false`.
//
// Method: detrend with the Theil-Sen slope, rank the residuals, take the biased autocorrelation of the ranks,
// keep only lags 1..floor(n/3) with |rho| > 1.96/sqrt(n), and inflate Var(S) by
// n/n* = 1 + 2/(n(n-1)(n-2)) * sum (n-i)(n-i-1)(n-i-2) rho_i. By default n/n* is floored at 1 (reported as
// nsClamped); allowDeflation:true reproduces pymannkendall.hamed_rao_modification_test(x, lag=floor(n/3)).
const { fail, numberArray, probability } = require('./validate');
const { normalQuantile, twoSidedP } = require('./normal');
const { senSlope } = require('./theil-sen');
const { MIN_N, MAX_N, basicStatistics, zScore } = require('./mann-kendall');

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
  const c = new Float64Array(n);
  for (let i = 0; i < n; i++) c[i] = values[i] - mean;
  let c0 = 0;
  for (let i = 0; i < n; i++) c0 += c[i] * c[i];
  const rho = new Float64Array(maxLag + 1);
  rho[0] = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = lag; i < n; i++) acc += c[i] * c[i - lag];
    rho[lag] = c0 === 0 ? 0 : acc / c0;
  }
  return rho;
}

function hamedRaoReference(x, { alpha = 0.05, allowDeflation = false } = {}) {
  numberArray(x, 'x', MIN_N);
  const n = x.length;
  if (n > MAX_N) fail('INVALID_INPUT', `x has more than ${MAX_N} values`);
  probability(alpha, 'alpha');
  const b = basicStatistics(x);
  const result = { gating: false, warning: 'Hamed-Rao is anticonservative under autocorrelation; not for gating',
    n, s: b.s, tau: b.tau, tauB: b.tauB, varSTie: b.varSTie, varSUsed: b.varSTie, variance: 'tie-corrected',
    nsFactor: 1, nsClamped: false, lagRule: null, lagsUsed: [], degenerate: false, alpha };
  if (!(b.varSTie > 0)) return { ...result, degenerate: true, z: 0, p: 1, reject: false, direction: 'none' };

  const slope = senSlope(x);
  const detrended = new Float64Array(n);
  for (let i = 0; i < n; i++) detrended[i] = x[i] - slope * (i + 1);
  const maxLag = Math.max(1, Math.floor(n / 3));
  const rho = autocorrelations(averageRanks(detrended), maxLag);
  const bound = normalQuantile(0.975) / Math.sqrt(n);
  let sum = 0;
  for (let i = 1; i <= maxLag; i++) {
    if (Math.abs(rho[i]) > bound) { sum += (n - i) * (n - i - 1) * (n - i - 2) * rho[i]; result.lagsUsed.push(i); }
  }
  let factor = 1 + (2 / (n * (n - 1) * (n - 2))) * sum;
  if (!allowDeflation && factor < 1) { factor = 1; result.nsClamped = true; }
  if (!(factor > 0)) fail('NUMERIC_FAILURE', 'non-positive Hamed-Rao variance factor');
  result.nsFactor = factor;
  result.varSUsed = b.varSTie * factor;
  result.variance = result.nsClamped ? 'hamed-rao-clamped' : 'hamed-rao';
  result.lagRule = `first significant lags 1..floor(n/3)=${maxLag} at |rho| > ${bound.toFixed(6)}`;
  const z = zScore(b.s, result.varSUsed), p = twoSidedP(z), reject = p < alpha;
  return { ...result, z, p, reject, direction: reject ? (z > 0 ? 'increasing' : 'decreasing') : 'none' };
}

module.exports = { hamedRaoReference };
