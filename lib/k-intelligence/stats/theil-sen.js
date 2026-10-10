'use strict';
// Theil-Sen slope with the Sen (1968, eq. 2.6) distribution-free confidence interval.
// Mirrors scipy.stats.theilslopes (method='separate'): the interval endpoints are order
// statistics of the sorted pairwise slopes, with tie-corrected Kendall variance and
// round-half-to-even index rounding.
const { fail, numberArray, probability } = require('./validate');
const { normalQuantile } = require('./normal');
const { median } = require('./robust');

const MIN_N = 3;
const MAX_N = 4000; // O(n^2) slopes: 4000 points -> 8M slopes

function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// sum over tie groups of k(k-1)(2k+5)
function tieTerm(values) {
  const s = Float64Array.from(values).sort();
  let total = 0, run = 1;
  for (let i = 1; i <= s.length; i++) {
    if (i < s.length && s[i] === s[i - 1]) run++;
    else { total += run * (run - 1) * (2 * run + 5); run = 1; }
  }
  return total;
}

// y: values; options.x: abscissae (default 0..n-1); options.confidence: default 0.95.
function theilSen(y, { x, confidence = 0.95 } = {}) {
  numberArray(y, 'y', MIN_N);
  const n = y.length;
  if (n > MAX_N) fail('INVALID_INPUT', `y has more than ${MAX_N} values`);
  probability(confidence, 'confidence');
  let xs;
  if (x === undefined) { xs = new Float64Array(n); for (let i = 0; i < n; i++) xs[i] = i; }
  else { numberArray(x, 'x'); if (x.length !== n) fail('INVALID_INPUT', 'x and y must have equal length'); xs = Float64Array.from(x); }

  const slopes = new Float64Array(n * (n - 1) / 2);
  let count = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = xs[j] - xs[i];
      if (dx > 0) slopes[count++] = (y[j] - y[i]) / dx;
      else if (dx < 0) slopes[count++] = (y[i] - y[j]) / -dx;
    }
  }
  if (count === 0) fail('INVALID_INPUT', 'all x coordinates are identical');
  const sortedSlopes = slopes.subarray(0, count).sort();
  const mid = count >> 1;
  const slope = count % 2 ? sortedSlopes[mid] : (sortedSlopes[mid - 1] + sortedSlopes[mid]) / 2;
  const intercept = median(y) - slope * median(Array.from(xs));

  const z = -normalQuantile((1 - confidence) / 2); // positive critical value
  const sigmaSq = (n * (n - 1) * (2 * n + 5) - tieTerm(xs) - tieTerm(y)) / 18;
  let ciLow = null, ciHigh = null;
  if (sigmaSq > 0) {
    const sigma = Math.sqrt(sigmaSq);
    const upper = Math.min(roundHalfEven((count + z * sigma) / 2), count - 1);
    const lower = Math.max(roundHalfEven((count - z * sigma) / 2) - 1, 0);
    ciLow = sortedSlopes[lower];
    ciHigh = sortedSlopes[upper];
  }
  return { slope, intercept, ciLow, ciHigh, confidence, n, nSlopes: count, method: 'sen-1968-eq-2.6' };
}

module.exports = { theilSen, MIN_N, MAX_N, roundHalfEven };
