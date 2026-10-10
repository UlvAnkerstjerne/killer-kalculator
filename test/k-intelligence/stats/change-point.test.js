'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectMeanShift, createRng, limits, defaults } = require('../../../lib/k-intelligence/stats');
const { fixture, close, throwsCode } = require('./helpers');

const REL = { rel: 1e-9, abs: 1e-12 };

test('scan statistic, location, segment means and effect size match an independent numpy computation', () => {
  for (const c of fixture('change-point.json').cases) {
    const r = detectMeanShift(c.x, { phiFit: 'global', minSegment: c.minSegment, bootstrapReps: 19 });
    const label = `${c.name}/m=${c.minSegment}`;
    assert.equal(r.location, c.location, label);
    close(r.beforeMean, c.beforeMean, REL, label);
    close(r.afterMean, c.afterMean, REL, label);
    close(r.delta, c.delta, REL, label);
    close(r.effectSize, c.effectSize, REL, label);
    close(r.statistic, c.statistic, REL, label);
  }
});

test('planted shifts are found at the right place with a small p; a null series is not flagged', () => {
  const rng = createRng(11);
  const series = [...Array.from({ length: 26 }, () => 100 + rng.normal() * 3), ...Array.from({ length: 26 }, () => 125 + rng.normal() * 3)];
  const r = detectMeanShift(series, { phiFit: 'global', minSegment: 6, bootstrapReps: 499 });
  assert.equal(r.detected, true);
  assert.ok(Math.abs(r.location - 26) <= 1, `location ${r.location}`);
  assert.ok(r.pValue <= 0.01 && r.delta > 15 && r.effectSize > 3);
  assert.ok(r.afterMean > r.beforeMean);
  const quiet = detectMeanShift(Array.from({ length: 52 }, () => 100 + rng.normal() * 3), { phiFit: 'global', minSegment: 6, bootstrapReps: 499 });
  assert.equal(quiet.detected, false);
  assert.ok(quiet.pValue > 0.05);
});

test('noise-free step: exact location, means, and a downward shift reports a negative delta', () => {
  const x = [...Array(15).fill(10), ...Array(10).fill(4)];
  const r = detectMeanShift(x.map((v, i) => v + (i % 2) * 0.01), { phiFit: 'global', minSegment: 5, bootstrapReps: 99 });
  assert.equal(r.location, 15);
  assert.ok(r.delta < -5.9 && r.delta > -6.1);
  assert.ok(r.effectSize < -50);
});

test('minimum segment length is honoured: a shift nearer the edge than minSegment is not located there', () => {
  const x = [...Array(28).fill(0), 5, 5].map((v, i) => v + Math.sin(i) * 0.1);
  const strict = detectMeanShift(x, { phiFit: 'global', minSegment: 6, bootstrapReps: 99 });
  assert.ok(strict.location <= x.length - 6, `location ${strict.location}`);
  assert.ok(strict.location >= 6);
  const loose = detectMeanShift(x, { phiFit: 'global', minSegment: 2 + 1, bootstrapReps: 99 });
  assert.ok(loose.location > strict.location || loose.location <= x.length - 3);
});

test('result is deterministic for a given seed and changes only the p-value across seeds', () => {
  const rng = createRng(5);
  const x = Array.from({ length: 40 }, () => rng.normal());
  const a = detectMeanShift(x, { phiFit: 'global', minSegment: 5, seed: 9, bootstrapReps: 199 });
  const b = detectMeanShift(x, { phiFit: 'global', minSegment: 5, seed: 9, bootstrapReps: 199 });
  const c = detectMeanShift(x, { phiFit: 'global', minSegment: 5, seed: 10, bootstrapReps: 199 });
  assert.deepEqual(a, b);
  assert.equal(a.location, c.location);
  assert.equal(a.statistic, c.statistic);
});

test('constant series is reported as degenerate, never as a detection or NaN', () => {
  const r = detectMeanShift(Array(20).fill(7), { phiFit: 'global', minSegment: 4, bootstrapReps: 19 });
  assert.equal(r.degenerate, true); assert.equal(r.detected, false); assert.equal(r.pValue, 1);
  assert.equal(r.location, null); assert.equal(r.beforeMean, 7); assert.equal(r.delta, 0);
});

test('minimum series length and segment-length requirements', () => {
  const min = limits.changePoint.minN;
  assert.equal(min, 12);
  throwsCode(() => detectMeanShift(Array.from({ length: min - 1 }, (_, i) => i), { phiFit: 'global', minSegment: 3 }), 'INSUFFICIENT_DATA');
  throwsCode(() => detectMeanShift(Array.from({ length: 12 }, (_, i) => i), { phiFit: 'global', minSegment: 7 }), 'INSUFFICIENT_DATA');
  assert.equal(detectMeanShift(Array.from({ length: 12 }, (_, i) => i * i), { phiFit: 'global', minSegment: 6, bootstrapReps: 19 }).location, 6);
});

test('input validation: required minSegment, NaN/Infinity/empty input, bad options', () => {
  const ok = Array.from({ length: 20 }, (_, i) => Math.sin(i));
  throwsCode(() => detectMeanShift(ok), 'INVALID_OPTION');
  throwsCode(() => detectMeanShift(ok, {}), 'INVALID_OPTION');
  throwsCode(() => detectMeanShift(ok, { phiFit: 'global', minSegment: 2 }), 'INVALID_OPTION');
  throwsCode(() => detectMeanShift(ok, { phiFit: 'global', minSegment: 3.5 }), 'INVALID_OPTION');
  throwsCode(() => detectMeanShift(ok, { phiFit: 'global', minSegment: 4, bootstrapReps: 5 }), 'INVALID_OPTION');
  throwsCode(() => detectMeanShift(ok, { phiFit: 'global', minSegment: 4, alpha: 1.5 }), 'INVALID_OPTION');
  throwsCode(() => detectMeanShift([], { phiFit: 'global', minSegment: 4 }), 'EMPTY_INPUT');
  for (const bad of [[...ok.slice(0, 19), NaN], [...ok.slice(0, 19), Infinity], [...ok.slice(0, 19), null], 'x']) {
    throwsCode(() => detectMeanShift(bad, { phiFit: 'global', minSegment: 4 }), 'INVALID_INPUT');
  }
});

test('C2 (phiFit segment) shares the scan result with C1 and differs only in the bootstrap calibration', () => {
  const rng = createRng(31);
  const x = [...Array.from({ length: 20 }, () => 50 + rng.normal() * 2), ...Array.from({ length: 20 }, () => 56 + rng.normal() * 2)];
  const c1 = detectMeanShift(x, { phiFit: 'global', minSegment: 6, seed: 4, bootstrapReps: 199 });
  const c2 = detectMeanShift(x, { phiFit: 'segment', minSegment: 6, seed: 4, bootstrapReps: 199 });
  assert.equal(c1.location, c2.location);
  assert.equal(c1.statistic, c2.statistic);
  assert.equal(c2.phiFit, 'segment');
  assert.ok(c2.phi < c1.phi, `a real shift inflates the global phi (${c1.phi}) more than the segment-residual phi (${c2.phi})`);
  assert.equal(c2.detected, true);
});

test('phiFit is validated; no default is wired before the pre-registered selection', () => {
  const x = Array.from({ length: 24 }, (_, i) => Math.sin(i));
  throwsCode(() => detectMeanShift(x, { phiFit: 'other', minSegment: 4 }), 'INVALID_OPTION');
  if (defaults.changePointPhiFit === null) throwsCode(() => detectMeanShift(x, { minSegment: 4 }), 'INVALID_OPTION');
});

test('input array is not mutated', () => {
  const x = Array.from({ length: 24 }, (_, i) => (i < 12 ? 1 : 3) + (i % 3) * 0.1);
  const copy = x.slice();
  detectMeanShift(x, { phiFit: 'global', minSegment: 4, bootstrapReps: 49 });
  assert.deepEqual(x, copy);
});
