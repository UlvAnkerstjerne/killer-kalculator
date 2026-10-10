'use strict';
// Mann-Kendall trend test (Mann 1945, Kendall 1975) with the tie-corrected variance of S.
//   S = sum of signs of all later-minus-earlier differences
//   Var(S) = (n(n-1)(2n+5) - sum t(t-1)(2t+5)) / 18
//   Z uses the continuity correction ((S-1)/sd for S>0, (S+1)/sd for S<0); p is two-sided.
// THIS TEST ASSUMES INDEPENDENT OBSERVATIONS. On autocorrelated series its p-value is far too small
// (see the null simulation); use trend.js for decisions. All-tied input is `degenerate` (Z=0, p=1).
const { fail, numberArray, probability } = require('./validate');
const { twoSidedP } = require('./normal');

const MIN_N = 8;
const MAX_N = 4000;

function mkScore(x, n = x.length) {
  let s = 0;
  for (let i = 0; i < n - 1; i++) {
    const xi = x[i];
    for (let j = i + 1; j < n; j++) s += x[j] > xi ? 1 : x[j] < xi ? -1 : 0;
  }
  return s;
}

// sum over tie groups of f(t)
function tieSum(x, f) {
  const s = Float64Array.from(x).sort();
  let total = 0, run = 1;
  for (let i = 1; i <= s.length; i++) {
    if (i < s.length && s[i] === s[i - 1]) run++;
    else { total += f(run); run = 1; }
  }
  return total;
}

function basicStatistics(x) {
  const n = x.length;
  const s = mkScore(x, n);
  const n0 = n * (n - 1) / 2;
  const varSTie = (n * (n - 1) * (2 * n + 5) - tieSum(x, t => t * (t - 1) * (2 * t + 5))) / 18;
  const tauDenominator = Math.sqrt((n0 - tieSum(x, t => t * (t - 1) / 2)) * n0);
  return { n, s, varSTie, tau: s / n0, tauB: tauDenominator === 0 ? 0 : s / tauDenominator };
}

function zScore(s, variance) { return s > 0 ? (s - 1) / Math.sqrt(variance) : s < 0 ? (s + 1) / Math.sqrt(variance) : 0; }

function mannKendall(x, { alpha = 0.05 } = {}) {
  numberArray(x, 'x', MIN_N);
  if (x.length > MAX_N) fail('INVALID_INPUT', `x has more than ${MAX_N} values`);
  probability(alpha, 'alpha');
  const b = basicStatistics(x);
  const base = { n: b.n, s: b.s, tau: b.tau, tauB: b.tauB, varS: b.varSTie, variance: 'tie-corrected', alpha, assumesIndependence: true };
  if (!(b.varSTie > 0)) return { ...base, degenerate: true, z: 0, p: 1, reject: false, direction: 'none' };
  const z = zScore(b.s, b.varSTie), p = twoSidedP(z), reject = p < alpha;
  return { ...base, degenerate: false, z, p, reject, direction: reject ? (z > 0 ? 'increasing' : 'decreasing') : 'none' };
}

module.exports = { mannKendall, mkScore, basicStatistics, zScore, tieSum, MIN_N, MAX_N };
