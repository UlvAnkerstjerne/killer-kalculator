'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { theilSen, senSlope, mannKendall, limits } = require('../../../lib/k-intelligence/stats');
const { fixture, close, throwsCode } = require('./helpers');

const REL = { rel: 1e-9, abs: 1e-12 };
const cases = fixture('mk-theil-sen.json');

test('Theil-Sen slope and intercept match scipy.stats.theilslopes; Sen CI is only a labelled reference field', () => {
  for (const c of cases.mannKendall) {
    for (const [key, confidence] of [['theilSen95', 0.95], ['theilSen90', 0.9]]) {
      const r = theilSen(c.x, { confidence });
      const e = c[key];
      close(r.slope, e.slope, REL, `${c.name} slope`);
      close(r.intercept, e.intercept, REL, `${c.name} intercept`);
      assert.equal(r.ciLow, undefined, 'the independence CI is never a top-level/default field');
      const ref = r.referenceIndependenceCi;
      close(ref.low, e.low, REL, `${c.name} ${key} low`);
      close(ref.high, e.high, REL, `${c.name} ${key} high`);
      assert.match(ref.assumes, /independent/);
      assert.ok(ref.low <= r.slope && r.slope <= ref.high, `${c.name}: slope inside its CI`);
    }
    close(senSlope(c.x), c.theilSen95.slope, REL, `${c.name} senSlope`);
  }
});

test('Theil-Sen supports uneven and tied x exactly as scipy does', () => {
  const f = cases.theilSenExplicitX;
  const r = theilSen(f.y, { x: f.x });
  close(r.slope, f.slope, REL); close(r.intercept, f.intercept, REL);
  close(r.referenceIndependenceCi.low, f.low, REL); close(r.referenceIndependenceCi.high, f.high, REL);
});

test('Theil-Sen known answers: exact line, outlier resistance, wider CI at higher confidence', () => {
  const line = Array.from({ length: 10 }, (_, i) => 3 + 2 * i);
  const r = theilSen(line);
  assert.equal(r.slope, 2);
  close(r.intercept, 3, { abs: 1e-12 });
  assert.equal(r.nSlopes, 45);
  const withOutlier = line.slice(); withOutlier[9] = 1e6;
  assert.equal(theilSen(withOutlier).slope, 2);
  const y = [1, 5, 2, 8, 3, 9, 4, 12, 5, 11];
  const wide = theilSen(y, { confidence: 0.99 }).referenceIndependenceCi, narrow = theilSen(y, { confidence: 0.8 }).referenceIndependenceCi;
  assert.ok(wide.high - wide.low >= narrow.high - narrow.low);
});

test('Theil-Sen constant series: zero slope and no defined reference interval', () => {
  const r = theilSen([4, 4, 4, 4, 4]);
  assert.equal(r.slope, 0);
  assert.equal(r.referenceIndependenceCi.low, null); assert.equal(r.referenceIndependenceCi.high, null);
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
    const r = mannKendall(c.x);
    assert.equal(r.s, c.original.s, `${c.name} S`);
    close(r.varS, c.original.varS, REL, `${c.name} varS`);
    close(r.z, c.original.z, REL, `${c.name} z`);
    close(r.p, c.original.pSf, { rel: 1e-9, abs: 1e-300 }, `${c.name} p`);
    close(r.tau, c.original.tauA, REL, `${c.name} tau`);
    close(r.tauB, c.kendallTauB, REL, `${c.name} tau-b`);
    assert.equal(r.n, c.n);
    assert.equal(r.variance, 'tie-corrected');
    assert.equal(r.assumesIndependence, true);
  }
});

test('Mann-Kendall reports the decision and direction', () => {
  const up = Array.from({ length: 20 }, (_, i) => i + (i % 3) * 0.1);
  const r = mannKendall(up);
  assert.equal(r.direction, 'increasing'); assert.equal(r.reject, true);
  assert.equal(mannKendall(up.slice().reverse()).direction, 'decreasing');
  assert.equal(mannKendall(up, { alpha: 1e-300 }).reject, false);
});

test('Mann-Kendall degenerate/edge inputs: constant series, minimum n, huge values', () => {
  const k = mannKendall([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
  assert.equal(k.degenerate, true); assert.equal(k.p, 1); assert.equal(k.z, 0); assert.equal(k.s, 0);
  assert.ok(Number.isFinite(k.varS) && !Number.isNaN(k.tauB));
  const min = limits.mannKendall.minN;
  assert.equal(min, 8);
  assert.equal(mannKendall(Array.from({ length: min }, (_, i) => i)).n, min);
  throwsCode(() => mannKendall(Array.from({ length: min - 1 }, (_, i) => i)), 'INSUFFICIENT_DATA');
  assert.equal(mannKendall(Array.from({ length: 20 }, (_, i) => 1e12 * (i + 1))).s, 190);
});

test('Mann-Kendall input validation', () => {
  throwsCode(() => mannKendall([]), 'EMPTY_INPUT');
  for (const bad of [[1, 2, 3, 4, 5, 6, 7, NaN], [1, 2, 3, 4, 5, 6, 7, Infinity], [1, 2, 3, 4, 5, 6, 7, null], 'abcdefghij', 42]) {
    throwsCode(() => mannKendall(bad), 'INVALID_INPUT');
  }
  const ok = Array.from({ length: 12 }, (_, i) => i);
  throwsCode(() => mannKendall(ok, { alpha: 0 }), 'INVALID_OPTION');
  throwsCode(() => mannKendall(ok, { alpha: 1 }), 'INVALID_OPTION');
});
