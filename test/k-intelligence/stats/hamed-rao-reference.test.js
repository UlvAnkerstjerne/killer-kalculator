'use strict';
// Hamed-Rao is a REFERENCE implementation only (gating:false). These tests pin that it still reproduces
// pymannkendall, and that it is labelled as not for gating.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hamedRaoReference, mannKendall } = require('../../../lib/k-intelligence/stats');
const { fixture, close, throwsCode } = require('./helpers');

const REL = { rel: 1e-9, abs: 1e-12 };
const cases = fixture('mk-theil-sen.json');

test('every result is labelled gating:false with a warning', () => {
  const r = hamedRaoReference(cases.mannKendall[0].x);
  assert.equal(r.gating, false);
  assert.match(r.warning, /not for gating/);
});

test('matches pymannkendall.hamed_rao_modification_test(lag=floor(n/3)) when deflation is allowed', () => {
  let compared = 0;
  for (const c of cases.mannKendall) {
    if (!(c.hamedRao.varS > 0)) continue; // NaN/negative reference variance: covered below
    const r = hamedRaoReference(c.x, { allowDeflation: true });
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

test('default clamps n/n* >= 1 so it is never more liberal than plain Mann-Kendall', () => {
  for (const c of cases.mannKendall) {
    const hr = hamedRaoReference(c.x), plain = mannKendall(c.x);
    assert.ok(hr.nsFactor >= 1, c.name);
    assert.ok(hr.p >= plain.p - 1e-15, c.name);
  }
  const neg = cases.mannKendall.find(c => c.name === 'ar1_phi_neg05_n40');
  const clamped = hamedRaoReference(neg.x);
  assert.equal(clamped.nsClamped, true);
  assert.equal(clamped.variance, 'hamed-rao-clamped');
  assert.ok(hamedRaoReference(neg.x, { allowDeflation: true }).p < 0.001, 'unclamped reference is anticonservative here');
});

test('inflates the variance for positively autocorrelated series and states its lag rule', () => {
  const ar = cases.mannKendall.find(c => c.name === 'ar1_phi06_trend_n90');
  const hr = hamedRaoReference(ar.x);
  assert.ok(hr.nsFactor > 4);
  assert.match(hr.lagRule, /floor\(n\/3\)=30/);
});

test('edge cases: constant series, monotone (0/0 autocorrelation), negative reference variance', () => {
  assert.equal(hamedRaoReference(Array(10).fill(5)).degenerate, true);
  const mono = hamedRaoReference(cases.mannKendall.find(c => c.name === 'monotone_decreasing_n15').x);
  assert.equal(mono.nsFactor, 1); assert.equal(mono.direction, 'decreasing');
  const n8 = cases.mannKendall.find(c => c.name === 'min_n8');
  throwsCode(() => hamedRaoReference(n8.x, { allowDeflation: true }), 'NUMERIC_FAILURE');
  assert.equal(hamedRaoReference(n8.x).nsClamped, true);
});

test('input validation', () => {
  throwsCode(() => hamedRaoReference([]), 'EMPTY_INPUT');
  throwsCode(() => hamedRaoReference([1, 2, 3, 4, 5, 6, 7, NaN]), 'INVALID_INPUT');
  throwsCode(() => hamedRaoReference(Array.from({ length: 12 }, (_, i) => i), { alpha: 2 }), 'INVALID_OPTION');
});
