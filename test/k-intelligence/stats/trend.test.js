'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { theilSen, mannKendall, limits } = require('../../../lib/k-intelligence/stats');
const { fixture, close, throwsCode } = require('./helpers');

const REL = { rel: 1e-9, abs: 1e-12 };
const cases = fixture('mk-theil-sen.json');

test('Theil-Sen slope, intercept and Sen (1968) CI match scipy.stats.theilslopes (95% and 90%)', () => {
  for (const c of cases.mannKendall) {
    for (const [key, confidence] of [['theilSen95', 0.95], ['theilSen90', 0.9]]) {
      const r = theilSen(c.x, { confidence });
      const e = c[key];
      close(r.slope, e.slope, REL, `${c.name} slope`);
      close(r.intercept, e.intercept, REL, `${c.name} intercept`);
      close(r.ciLow, e.low, REL, `${c.name} ${key} low`);
      close(r.ciHigh, e.high, REL, `${c.name} ${key} high`);
      assert.ok(r.ciLow <= r.slope && r.slope <= r.ciHigh, `${c.name}: slope inside its CI`);
    }
  }
});

test('Theil-Sen supports uneven and tied x exactly as scipy does', () => {
  const f = cases.theilSenExplicitX;
  const r = theilSen(f.y, { x: f.x });
  close(r.slope, f.slope, REL); close(r.intercept, f.intercept, REL);
  close(r.ciLow, f.low, REL); close(r.ciHigh, f.high, REL);
});

test('Theil-Sen known answers: exact line, outlier resistance, ordering of CI', () => {
  const line = Array.from({ length: 10 }, (_, i) => 3 + 2 * i);
  const r = theilSen(line);
  assert.equal(r.slope, 2);
  close(r.intercept, 3, { abs: 1e-12 });
  assert.equal(r.nSlopes, 45);
  const withOutlier = line.slice(); withOutlier[9] = 1e6;
  assert.equal(theilSen(withOutlier).slope, 2);
  const wide = theilSen([1, 5, 2, 8, 3, 9, 4, 12, 5, 11], { confidence: 0.99 });
  const narrow = theilSen([1, 5, 2, 8, 3, 9, 4, 12, 5, 11], { confidence: 0.8 });
  assert.ok(wide.ciHigh - wide.ciLow >= narrow.ciHigh - narrow.ciLow);
});

test('Theil-Sen constant series: zero slope, no variance, CI collapses to the point', () => {
  const r = theilSen([4, 4, 4, 4, 4]);
  assert.equal(r.slope, 0);
  assert.equal(r.ciLow, null); assert.equal(r.ciHigh, null); // sigma^2 = 0: no interval is defined
});

test('Theil-Sen input validation', () => {
  throwsCode(() => theilSen([]), 'EMPTY_INPUT');
  throwsCode(() => theilSen([1, 2]), 'INSUFFICIENT_DATA');
  for (const bad of [[1, 2, NaN], [1, 2, Infinity], [1, '2', 3], [1, null, 3], 'abc']) throwsCode(() => theilSen(bad), 'INVALID_INPUT');
  throwsCode(() => theilSen([1, 2, 3], { x: [1, 2] }), 'INVALID_INPUT');
  throwsCode(() => theilSen([1, 2, 3], { x: [1, 1, 1] }), 'INVALID_INPUT');
  throwsCode(() => theilSen([1, 2, 3], { x: [1, 2, NaN] }), 'INVALID_INPUT');
  throwsCode(() => theilSen([1, 2, 3], { confidence: 1 }), 'INVALID_OPTION');
  throwsCode(() => theilSen([1, 2, 3], { confidence: 0 }), 'INVALID_OPTION');
});

// Reference p-values are 2*norm.sf(|z|) from the reference z: pymannkendall's own p (2*(1-cdf)) loses
// precision below ~1e-8, so it is not a valid reference in the far tail. z, S and variances are its own.
test('Mann-Kendall S, tau-a, tau-b, tie-corrected variance, Z and p match pymannkendall/scipy', () => {
  for (const c of cases.mannKendall) {
    const r = mannKendall(c.x, { correction: 'none' });
    assert.equal(r.s, c.original.s, `${c.name} S`);
    close(r.varSTie, c.original.varS, REL, `${c.name} varS`);
    close(r.z, c.original.z, REL, `${c.name} z`);
    close(r.p, c.original.pSf, { rel: 1e-9, abs: 1e-300 }, `${c.name} p`);
    close(r.tau, c.original.tauA, REL, `${c.name} tau`);
    close(r.tauB, c.kendallTauB, REL, `${c.name} tau-b`);
    assert.equal(r.n, c.n);
    assert.equal(r.variance, 'tie-corrected');
  }
});

test('Hamed-Rao variance, Z and p match pymannkendall (lag = floor(n/3)) when the factor is not clamped', () => {
  let compared = 0;
  for (const c of cases.mannKendall) {
    if (!(c.hamedRao.varS > 0)) continue; // NaN/negative reference variance: covered by the dedicated edge-case test
    const r = mannKendall(c.x, { allowDeflation: true });
    compared++;
    close(r.nsFactor, c.hamedRao.factor, REL, `${c.name} factor`);
    close(r.varSUsed, c.hamedRao.varS, REL, `${c.name} varS*`);
    close(r.z, c.hamedRao.z, REL, `${c.name} z`);
    close(r.p, c.hamedRao.pSf, { rel: 1e-9, abs: 1e-300 }, `${c.name} p`);
    assert.equal(r.s, c.hamedRao.s);
    assert.equal(r.nsClamped, false);
  }
  assert.ok(compared >= 10, `compared ${compared} cases`);
});

test('Hamed-Rao default clamps n/n* >= 1: never more liberal than the tie-corrected test', () => {
  for (const c of cases.mannKendall) {
    const plain = mannKendall(c.x, { correction: 'none' });
    const hr = mannKendall(c.x);
    assert.ok(hr.nsFactor >= 1, c.name);
    assert.ok(hr.p >= plain.p - 1e-15, `${c.name}: corrected p ${hr.p} < plain p ${plain.p}`);
  }
  // Negative autocorrelation: unclamped reference factor 0.2035 would make this null series "significant".
  const neg = cases.mannKendall.find(c => c.name === 'ar1_phi_neg05_n40');
  const clamped = mannKendall(neg.x);
  assert.equal(clamped.nsClamped, true);
  assert.equal(clamped.variance, 'hamed-rao-clamped');
  close(clamped.p, mannKendall(neg.x, { correction: 'none' }).p, { rel: 1e-12, abs: 0 });
  assert.ok(mannKendall(neg.x, { allowDeflation: true }).p < 0.001, 'unclamped reference result is anticonservative here');
});

test('Hamed-Rao inflates the variance for positively autocorrelated series', () => {
  const ar = cases.mannKendall.find(c => c.name === 'ar1_phi06_trend_n90');
  const hr = mannKendall(ar.x), plain = mannKendall(ar.x, { correction: 'none' });
  assert.equal(hr.variance, 'hamed-rao');
  assert.ok(hr.nsFactor > 4 && hr.p > plain.p);
  assert.ok(hr.lagsUsed.length > 0 && hr.lagsUsed.every(l => l >= 1 && l <= 30));
  assert.match(hr.lagRule, /floor\(n\/3\)=30/);
});

test('Mann-Kendall reports the variance actually used and the decision', () => {
  const up = Array.from({ length: 20 }, (_, i) => i + (i % 3) * 0.1);
  const r = mannKendall(up, { correction: 'none' });
  assert.equal(r.direction, 'increasing'); assert.equal(r.reject, true);
  assert.equal(mannKendall(up.slice().reverse(), { correction: 'none' }).direction, 'decreasing');
  assert.equal(r.varSUsed, r.varSTie);
  assert.equal(mannKendall(up, { correction: 'none', alpha: 1e-300 }).reject, false);
});

test('Mann-Kendall degenerate/edge inputs: constant series, minimum n, huge values, monotone', () => {
  const k = mannKendall([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
  assert.equal(k.degenerate, true); assert.equal(k.p, 1); assert.equal(k.z, 0); assert.equal(k.s, 0);
  assert.ok(Number.isFinite(k.varSUsed) && !Number.isNaN(k.tauB));
  const min = limits.mannKendall.minN;
  assert.equal(min, 8);
  assert.equal(mannKendall(Array.from({ length: min }, (_, i) => i)).n, min);
  throwsCode(() => mannKendall(Array.from({ length: min - 1 }, (_, i) => i)), 'INSUFFICIENT_DATA');
  // Monotone: reference gives NaN (0/0 autocorrelation of constant ranks); we define rho = 0.
  const mono = cases.mannKendall.find(c => c.name === 'monotone_decreasing_n15');
  const m = mannKendall(mono.x);
  assert.equal(m.nsFactor, 1); assert.equal(m.direction, 'decreasing'); assert.ok(m.p < 1e-5);
  const big = mannKendall(Array.from({ length: 20 }, (_, i) => 1e12 * (i + 1)), { correction: 'none' });
  assert.equal(big.s, 190);
});

test('Hamed-Rao with a non-positive reference factor fails loudly when deflation is allowed', () => {
  const n8 = cases.mannKendall.find(c => c.name === 'min_n8'); // reference variance is negative (NaN z)
  assert.equal(n8.hamedRao.z, null);
  throwsCode(() => mannKendall(n8.x, { allowDeflation: true }), 'NUMERIC_FAILURE');
  const safe = mannKendall(n8.x);
  assert.equal(safe.nsClamped, true);
  close(safe.p, mannKendall(n8.x, { correction: 'none' }).p, { rel: 1e-12, abs: 0 });
});

test('Mann-Kendall input validation', () => {
  throwsCode(() => mannKendall([]), 'EMPTY_INPUT');
  for (const bad of [[1, 2, 3, 4, 5, 6, 7, NaN], [1, 2, 3, 4, 5, 6, 7, Infinity], [1, 2, 3, 4, 5, 6, 7, null], 'abcdefghij', 42]) {
    throwsCode(() => mannKendall(bad), 'INVALID_INPUT');
  }
  const ok = Array.from({ length: 12 }, (_, i) => i);
  throwsCode(() => mannKendall(ok, { correction: 'yue-wang' }), 'INVALID_OPTION');
  throwsCode(() => mannKendall(ok, { alpha: 0 }), 'INVALID_OPTION');
  throwsCode(() => mannKendall(ok, { alpha: 1 }), 'INVALID_OPTION');
});
