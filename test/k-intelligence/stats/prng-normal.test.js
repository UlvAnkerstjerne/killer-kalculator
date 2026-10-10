'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRng, erfc, normalCdf, normalSf, normalPdf, twoSidedP, normalQuantile } = require('../../../lib/k-intelligence/stats');
const { fixture, close, throwsCode } = require('./helpers');

test('PRNG is deterministic per seed and differs across seeds', () => {
  const a = createRng(42), b = createRng(42), c = createRng(43);
  const sa = Array.from({ length: 8 }, () => a.uniform()), sb = Array.from({ length: 8 }, () => b.uniform());
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, Array.from({ length: 8 }, () => c.uniform()));
});

test('PRNG output is pinned (regression pin of this implementation, not an external reference vector)', () => {
  const r = createRng(1);
  assert.deepEqual([r.nextUint32(), r.nextUint32(), r.nextUint32()], [393288148, 2174103013, 3814759091]);
  const q = createRng(42);
  assert.equal(q.uniform(), 0.15377165265745885);
  assert.equal(q.int(1000), 526);
  assert.equal(q.normal(), -0.2553193469077037);
});

test('PRNG uniform, int and normal have sane moments', () => {
  const r = createRng(7), n = 200000;
  let su = 0, sn = 0, sn2 = 0;
  const counts = new Array(6).fill(0);
  for (let i = 0; i < n; i++) {
    const u = r.uniform(); assert.ok(u >= 0 && u < 1); su += u;
    const z = r.normal(); sn += z; sn2 += z * z;
    counts[r.int(6)]++;
  }
  close(su / n, 0.5, { abs: 0.005 });
  close(sn / n, 0, { abs: 0.01 });
  close(sn2 / n, 1, { abs: 0.015 });
  for (const c of counts) close(c / n, 1 / 6, { abs: 0.005 });
});

test('PRNG rejects invalid seeds and ranges', () => {
  throwsCode(() => createRng(-1), 'INVALID_OPTION');
  throwsCode(() => createRng(1.5), 'INVALID_OPTION');
  throwsCode(() => createRng(2 ** 32), 'INVALID_OPTION');
  throwsCode(() => createRng(1).int(0), 'INVALID_OPTION');
});

test('normal CDF / survival / two-sided p match scipy to <= 1e-10 relative error', () => {
  for (const c of fixture('normal.json').cdf) {
    close(normalCdf(c.z), c.cdf, { rel: 1e-10, abs: 0 }, `cdf(${c.z})`);
    close(normalSf(c.z), c.sf, { rel: 1e-10, abs: 0 }, `sf(${c.z})`);
    close(twoSidedP(c.z), c.twoSided, { rel: 1e-10, abs: 0 }, `p(${c.z})`);
  }
});

test('normal quantile matches scipy ppf to <= 1e-10 relative error and round-trips', () => {
  for (const c of fixture('normal.json').quantile) {
    const z = normalQuantile(c.p);
    close(z, c.z, { rel: 1e-10, abs: 1e-14 }, `ppf(${c.p})`);
  }
  for (const z of [-6, -3.3, -1, 0.25, 2, 5]) close(normalQuantile(normalCdf(z)), z, { rel: 1e-9, abs: 1e-12 });
});

test('normal functions: symmetry, special values, pdf, erfc', () => {
  assert.equal(normalCdf(0), 0.5);
  assert.equal(normalQuantile(0.5), 0);
  assert.equal(erfc(0), 1);
  close(normalCdf(1.234) + normalCdf(-1.234), 1, { rel: 1e-15, abs: 0 });
  close(normalPdf(0), 0.3989422804014327, { rel: 1e-15, abs: 0 });
  close(erfc(-1) + erfc(1), 2, { rel: 1e-15, abs: 0 });
  close(twoSidedP(1.959963984540054), 0.05, { rel: 1e-12, abs: 0 });
  close(normalQuantile(0.975), 1.959963984540054, { rel: 1e-13, abs: 0 });
});

test('normal functions reject non-finite input and out-of-range probabilities', () => {
  for (const bad of [NaN, Infinity, -Infinity, '1', null, undefined]) {
    throwsCode(() => normalCdf(bad), 'INVALID_INPUT');
    throwsCode(() => twoSidedP(bad), 'INVALID_INPUT');
    throwsCode(() => normalQuantile(bad), 'INVALID_INPUT');
  }
  for (const bad of [0, 1, -0.1, 1.1]) throwsCode(() => normalQuantile(bad), 'INVALID_INPUT');
});
