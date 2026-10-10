'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { benjaminiHochberg } = require('../../../lib/k-intelligence/stats');
const { fixture, close, throwsCode } = require('./helpers');

test('BH q-values match statsmodels multipletests(fdr_bh) and scipy false_discovery_control', () => {
  for (const c of fixture('bh.json').cases) {
    const { qValues } = benjaminiHochberg(c.p);
    assert.equal(qValues.length, c.q.length);
    c.q.forEach((q, i) => close(qValues[i], q, { rel: 1e-12, abs: 1e-300 }, `${c.name}[${i}]`));
  }
});

test('BH with a larger family size equals padding the family with p = 1 tests', () => {
  const f = fixture('bh.json').familySize;
  const { qValues, familySize } = benjaminiHochberg(f.p, { familySize: f.familySize });
  assert.equal(familySize, 10);
  f.q.forEach((q, i) => close(qValues[i], q, { rel: 1e-12, abs: 1e-300 }));
});

test('BH handles ties: tied p-values share one q, original order preserved, stable ranking', () => {
  const { qValues } = benjaminiHochberg([0.04, 0.01, 0.04, 0.01, 0.5]);
  assert.equal(qValues[1], qValues[3]);
  assert.equal(qValues[0], qValues[2]);
  assert.deepEqual(qValues.map(q => +q.toFixed(12)), [0.05, 0.025, 0.05, 0.025, 0.5]);
});

test('BH known answers: q >= p, q <= 1, monotone in p, input not mutated', () => {
  const p = [0.5, 0.001, 0.2, 0.04, 0.03];
  const copy = p.slice();
  const { qValues } = benjaminiHochberg(p);
  assert.deepEqual(p, copy);
  qValues.forEach((q, i) => { assert.ok(q >= p[i] - 1e-15 && q <= 1); });
  const order = p.map((_, i) => i).sort((a, b) => p[a] - p[b]);
  for (let i = 1; i < order.length; i++) assert.ok(qValues[order[i]] >= qValues[order[i - 1]]);
  close(qValues[1], 0.005, { rel: 1e-12, abs: 0 });
  close(qValues[4], 2 / 30, { rel: 1e-12, abs: 0 }); // rank 3 of 5: 0.04 * 5 / 3 = 0.0667, < 0.075 so min-propagated down
});

test('BH alpha option marks rejections at q <= alpha', () => {
  const r = benjaminiHochberg([0.001, 0.2, 0.012, 0.9], { alpha: 0.05 });
  assert.deepEqual(r.rejected, [true, false, true, false]);
});

test('BH rejects empty input, invalid p-values and bad options', () => {
  throwsCode(() => benjaminiHochberg([]), 'EMPTY_INPUT');
  for (const bad of [[NaN], [-0.1], [1.1], [Infinity], ['0.1'], [null], [0.1, undefined]]) throwsCode(() => benjaminiHochberg(bad), 'INVALID_INPUT');
  throwsCode(() => benjaminiHochberg('x'), 'INVALID_INPUT');
  throwsCode(() => benjaminiHochberg([0.1, 0.2], { familySize: 1 }), 'INVALID_OPTION');
  throwsCode(() => benjaminiHochberg([0.1], { familySize: 2.5 }), 'INVALID_OPTION');
  throwsCode(() => benjaminiHochberg([0.1], { alpha: 0 }), 'INVALID_OPTION');
});
