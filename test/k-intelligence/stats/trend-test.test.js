'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { trendTest, trendInterval, analyzeTrend, createRng, theilSen, defaults } = require('../../../lib/k-intelligence/stats');
const { fixture, close, throwsCode } = require('./helpers');

const METHODS = ['sieve-bootstrap', 'prewhitened-mk'];
const cases = fixture('mk-theil-sen.json');

function ar1(n, phi, rng, trend = 0) {
  const x = new Array(n); let prev = 0;
  for (let i = -100; i < n; i++) { prev = phi * prev + rng.normal(); if (i >= 0) x[i] = prev + trend * i / (n - 1); }
  return x;
}

test('candidate B equals pymannkendall.pre_whitening_modification_test on the reference series', () => {
  for (const c of cases.mannKendall) {
    if (c.n < 12) { throwsCode(() => trendTest(c.x, { method: 'prewhitened-mk' }), 'INSUFFICIENT_DATA'); continue; }
    const r = trendTest(c.x, { method: 'prewhitened-mk' });
    if (r.degenerate) continue;
    assert.equal(r.n, c.n);
    // pymannkendall uses the raw lag-1 autocorrelation (no clamp needed for these series)
    close(r.z, c.preWhitening.z, { rel: 1e-9, abs: 1e-12 }, `${c.name} z`);
    close(r.p, c.preWhitening.pSf, { rel: 1e-9, abs: 1e-300 }, `${c.name} p`);
    assert.equal(r.sPrewhitened, c.preWhitening.s, c.name);
  }
});

for (const method of METHODS) {
  test(`${method}: finds a strong planted trend and reports the right direction and slope`, () => {
    const rng = createRng(21);
    const up = ar1(60, 0.3, rng, 6);
    const r = trendTest(up, { method, seed: 3, bootstrapReps: 199 });
    assert.equal(r.reject, true, `p=${r.p}`);
    assert.equal(r.direction, 'increasing');
    assert.ok(r.slope > 0.05 && r.slope < 0.2, `slope ${r.slope}`);
    const down = trendTest(up.map(v => -v), { method, seed: 3, bootstrapReps: 199 });
    assert.equal(down.direction, 'decreasing');
  });

  test(`${method}: a trend-free iid series is not flagged and p is a valid probability`, () => {
    const rng = createRng(22);
    let flagged = 0;
    for (let i = 0; i < 20; i++) {
      const r = trendTest(ar1(50, 0, rng), { method, seed: i, bootstrapReps: 99 });
      assert.ok(r.p > 0 && r.p <= 1);
      if (r.reject) flagged++;
    }
    assert.ok(flagged <= 4, `${flagged}/20 false positives`);
  });

  test(`${method}: constant series is degenerate (p = 1), never NaN`, () => {
    const r = trendTest(Array(20).fill(3), { method });
    assert.equal(r.degenerate, true); assert.equal(r.p, 1); assert.equal(r.reject, false); assert.equal(r.slope, 0);
  });

  test(`${method}: input validation and input immutability`, () => {
    const ok = ar1(30, 0.2, createRng(1));
    throwsCode(() => trendTest([], { method }), 'EMPTY_INPUT');
    throwsCode(() => trendTest(ok.slice(0, 11), { method }), 'INSUFFICIENT_DATA');
    for (const bad of [[...ok.slice(0, 29), NaN], [...ok.slice(0, 29), Infinity], [...ok.slice(0, 29), null], 'abc']) {
      throwsCode(() => trendTest(bad, { method }), 'INVALID_INPUT');
    }
    throwsCode(() => trendTest(ok, { method, alpha: 0 }), 'INVALID_OPTION');
    const copy = ok.slice();
    trendTest(ok, { method, bootstrapReps: 49 });
    assert.deepEqual(ok, copy);
  });
}

test('sieve bootstrap is deterministic per seed and differs in p only across seeds', () => {
  const x = ar1(40, 0.4, createRng(5), 2);
  const a = trendTest(x, { method: 'sieve-bootstrap', seed: 9, bootstrapReps: 199 });
  const b = trendTest(x, { method: 'sieve-bootstrap', seed: 9, bootstrapReps: 199 });
  const c = trendTest(x, { method: 'sieve-bootstrap', seed: 10, bootstrapReps: 199 });
  assert.deepEqual(a, b);
  assert.equal(a.s, c.s); assert.equal(a.phi, c.phi);
});

test('sieve bootstrap fits phi on Theil-Sen-detrended residuals: a pure trend does not inflate phi', () => {
  const line = Array.from({ length: 40 }, (_, i) => 5 + 0.7 * i + Math.sin(i * 1.7) * 0.01);
  const r = trendTest(line, { method: 'sieve-bootstrap', seed: 1, bootstrapReps: 99 });
  assert.ok(Math.abs(r.phi) < 0.6, `phi ${r.phi}`);          // raw series phi would be ~0.95
  const pre = trendTest(line, { method: 'prewhitened-mk' });
  assert.ok(pre.phi > 0.9, `prewhitening phi on the raw series ${pre.phi}`); // the documented cost of B
});

test('no default method is wired until the pre-registered selection; method must then be explicit', () => {
  if (defaults.trendMethod === null) throwsCode(() => trendTest(ar1(20, 0, createRng(1))), 'INVALID_OPTION');
  else assert.ok(METHODS.includes(defaults.trendMethod));
  throwsCode(() => trendTest(ar1(20, 0, createRng(1)), { method: 'hamed-rao' }), 'INVALID_OPTION');
});

test('trendInterval: autocorrelation-aware interval is wider than Sen independence interval under AR(1)', () => {
  const x = ar1(60, 0.6, createRng(8), 3);
  const i = trendInterval(x, { seed: 4, bootstrapReps: 299 });
  const sen = theilSen(x).referenceIndependenceCi;
  assert.equal(i.method, 'sieve-bootstrap-percentile');
  assert.ok(i.low < i.slope && i.slope < i.high, `${i.low} ${i.slope} ${i.high}`);
  assert.ok(i.high - i.low > sen.high - sen.low, `bootstrap width ${i.high - i.low} vs Sen ${sen.high - sen.low}`);
  assert.deepEqual(i.referenceIndependenceCi, sen);
  assert.match(i.referenceIndependenceCi.assumes, /independent/);
});

test('trendInterval: deterministic, ordered, confidence monotone, validated', () => {
  const x = ar1(40, 0.3, createRng(6), 2);
  const a = trendInterval(x, { seed: 2, bootstrapReps: 199 }), b = trendInterval(x, { seed: 2, bootstrapReps: 199 });
  assert.deepEqual(a, b);
  const w99 = trendInterval(x, { seed: 2, bootstrapReps: 199, confidence: 0.99 }), w80 = trendInterval(x, { seed: 2, bootstrapReps: 199, confidence: 0.8 });
  assert.ok(w99.high - w99.low >= w80.high - w80.low);
  throwsCode(() => trendInterval([1, 2, 3]), 'INSUFFICIENT_DATA');
  throwsCode(() => trendInterval(x, { confidence: 1 }), 'INVALID_OPTION');
  throwsCode(() => trendInterval(x, { bootstrapReps: 5 }), 'INVALID_OPTION');
  throwsCode(() => trendInterval([...x.slice(0, 39), NaN]), 'INVALID_INPUT');
});

test('trendInterval on an exact line collapses to the slope', () => {
  const i = trendInterval(Array.from({ length: 20 }, (_, k) => 1 + 0.5 * k), { seed: 1, bootstrapReps: 99 });
  close(i.slope, 0.5, { abs: 1e-12 }); close(i.low, 0.5, { abs: 1e-9 }); close(i.high, 0.5, { abs: 1e-9 });
});
