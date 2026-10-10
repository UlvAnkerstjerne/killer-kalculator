'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { median, mad, MAD_SCALE, normalQuantile, isoWeekday, sameWeekdayBaseline, robustZ } = require('../../../lib/k-intelligence/stats');
const { fixture, close, throwsCode } = require('./helpers');

test('median and MAD match numpy/scipy (raw and normal-consistent scaling)', () => {
  for (const c of fixture('robust.json').robust) {
    close(median(c.values), c.median, { rel: 1e-14, abs: 1e-14 }, c.name);
    close(mad(c.values), c.mad, { rel: 1e-14, abs: 1e-14 }, c.name);
    close(mad(c.values, { scaled: true }), c.madScaled, { rel: 1e-14, abs: 1e-14 }, c.name);
  }
});

test('MAD_SCALE is 1 / normal quantile(0.75)', () => {
  close(MAD_SCALE, 1 / normalQuantile(0.75), { rel: 1e-14, abs: 0 });
});

test('median/MAD known answers, outlier robustness and input immutability', () => {
  assert.equal(median([5]), 5);
  assert.equal(median([1, 2]), 1.5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(mad([1, 1, 2, 2, 4, 6, 9]), 1);
  const v = [10, 11, 12, 13, 14, 1e9];
  const copy = v.slice();
  assert.equal(median(v), 12.5);
  assert.deepEqual(v, copy);
  assert.ok(mad(v) < 3);
  assert.equal(mad([4, 4, 4, 4]), 0);
});

test('median/MAD reject empty, NaN, Infinity and non-numeric input', () => {
  throwsCode(() => median([]), 'EMPTY_INPUT');
  throwsCode(() => mad([]), 'EMPTY_INPUT');
  for (const bad of [[1, NaN], [1, Infinity], [-Infinity], ['2'], [null], [undefined], [1, , 3]]) {
    throwsCode(() => median(bad), 'INVALID_INPUT');
    throwsCode(() => mad(bad), 'INVALID_INPUT');
  }
  throwsCode(() => median('abc'), 'INVALID_INPUT');
  throwsCode(() => median(null), 'INVALID_INPUT');
});

test('isoWeekday uses calendar labels', () => {
  assert.equal(isoWeekday('2026-10-05'), 1); // Monday
  assert.equal(isoWeekday('2026-10-09'), 5); // Friday
  assert.equal(isoWeekday('2026-10-11'), 7); // Sunday
  assert.equal(isoWeekday('2026-03-29'), 7); // DST change day still a plain calendar date
  throwsCode(() => isoWeekday('2026-02-30'), 'INVALID_INPUT');
  throwsCode(() => isoWeekday('2026-2-3'), 'INVALID_INPUT');
});

test('same-weekday baseline matches an independent numpy/scipy computation', () => {
  const f = fixture('robust.json').sameWeekday;
  const b = sameWeekdayBaseline(f.series, f.targetDate, { lookbackWeeks: f.lookbackWeeks, minObservations: f.minObservations });
  assert.equal(b.sufficient, true);
  assert.equal(b.weekday, f.weekday);
  assert.equal(b.n, f.n);
  assert.deepEqual(b.usedDates, f.usedDates);
  assert.deepEqual(b.excluded.map(e => [e.date, e.reason]), f.excluded);
  close(b.median, f.median, { rel: 1e-14, abs: 1e-12 });
  close(b.mad, f.mad, { rel: 1e-14, abs: 1e-12 });
  close(b.madScaled, f.madScaled, { rel: 1e-14, abs: 1e-12 });
});

function week(values, start = '2026-09-03') { // Thursdays, ascending
  return values.map((value, i) => {
    const d = new Date(start + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 7 * i);
    return { date: d.toISOString().slice(0, 10), value };
  });
}

test('baseline: null never becomes zero, ineligible days are dropped, zero stays a real value', () => {
  const s = week([100, 200, null, 300, 0, 400]); // Thursdays 2026-09-03 ... 2026-10-08
  s[3].eligible = false;
  const b = sameWeekdayBaseline(s, '2026-10-15', { lookbackWeeks: 6, minObservations: 2 });
  assert.equal(b.sufficient, true);
  assert.deepEqual(b.usedDates, ['2026-09-03', '2026-09-10', '2026-10-01', '2026-10-08']);
  assert.deepEqual(b.excluded, [{ date: '2026-09-17', reason: 'null' }, { date: '2026-09-24', reason: 'ineligible' }]);
  // values used: 100, 200, 0, 400 -> median 150. Had null been zero-filled: 100,200,0,0,0,400 -> median 50.
  assert.equal(b.median, 150);
});

test('baseline: only the same weekday, strictly before the target, within the lookback window', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) { // daily from 2026-09-01
    const d = new Date('2026-09-01T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i);
    rows.push({ date: d.toISOString().slice(0, 10), value: d.getUTCDay() === 4 ? 1000 + i : -1 });
  }
  const b = sameWeekdayBaseline(rows, '2026-09-24', { lookbackWeeks: 2, minObservations: 2 }); // Thursday
  assert.deepEqual(b.usedDates, ['2026-09-10', '2026-09-17']);
  assert.equal(b.window.from, '2026-09-10');
  assert.ok(!b.usedDates.includes('2026-09-24'), 'target never in its own baseline');
});

test('baseline: insufficient data is explicit, not zero or NaN', () => {
  const b = sameWeekdayBaseline(week([100, null, null]), '2026-09-24', { lookbackWeeks: 3, minObservations: 2 });
  assert.equal(b.sufficient, false);
  assert.equal(b.median, null);
  assert.equal(b.mad, null);
  assert.equal(b.n, 1);
  assert.equal(robustZ(5, b), null);
});

test('baseline and robustZ: zero MAD yields null, not Infinity', () => {
  const b = sameWeekdayBaseline(week([50, 50, 50, 50]), '2026-10-01', { lookbackWeeks: 4, minObservations: 4 });
  assert.equal(b.sufficient, true);
  assert.equal(b.madScaled, 0);
  assert.equal(robustZ(60, b), null);
  const spread = sameWeekdayBaseline(week([40, 50, 60, 55, 45]), '2026-10-08', { lookbackWeeks: 5, minObservations: 4 });
  close(robustZ(70, spread), (70 - spread.median) / spread.madScaled, { rel: 1e-15, abs: 0 });
});

test('baseline validation: empty series, bad rows, NaN, duplicates and bad options throw', () => {
  throwsCode(() => sameWeekdayBaseline([], '2026-10-01'), 'EMPTY_INPUT');
  throwsCode(() => sameWeekdayBaseline('x', '2026-10-01'), 'INVALID_INPUT');
  throwsCode(() => sameWeekdayBaseline([{ date: '2026-09-24', value: NaN }], '2026-10-01'), 'INVALID_INPUT');
  throwsCode(() => sameWeekdayBaseline([{ date: '2026-09-24', value: Infinity }], '2026-10-01'), 'INVALID_INPUT');
  throwsCode(() => sameWeekdayBaseline([{ date: '2026-09-24', value: undefined }], '2026-10-01'), 'INVALID_INPUT');
  throwsCode(() => sameWeekdayBaseline([{ date: '2026-09-24', value: '5' }], '2026-10-01'), 'INVALID_INPUT');
  throwsCode(() => sameWeekdayBaseline([{ date: '2026-09-24', value: 1, eligible: 'yes' }], '2026-10-01'), 'INVALID_INPUT');
  throwsCode(() => sameWeekdayBaseline([{ date: '24/09/2026', value: 1 }], '2026-10-01'), 'INVALID_INPUT');
  throwsCode(() => sameWeekdayBaseline([{ date: '2026-09-24', value: 1 }, { date: '2026-09-24', value: 2 }], '2026-10-01'), 'INVALID_INPUT');
  throwsCode(() => sameWeekdayBaseline([null], '2026-10-01'), 'INVALID_INPUT');
  throwsCode(() => sameWeekdayBaseline([{ date: '2026-09-24', value: 1 }], '2026-13-01'), 'INVALID_INPUT');
  throwsCode(() => sameWeekdayBaseline([{ date: '2026-09-24', value: 1 }], '2026-10-01', { lookbackWeeks: 0 }), 'INVALID_OPTION');
  throwsCode(() => sameWeekdayBaseline([{ date: '2026-09-24', value: 1 }], '2026-10-01', { lookbackWeeks: 4, minObservations: 5 }), 'INVALID_OPTION');
});
