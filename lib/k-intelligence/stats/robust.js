'use strict';
// Robust location/scale and the same-weekday baseline.
const { StatsError, fail, numberArray, integer, dateLabel, finiteNumber } = require('./validate');

// 1 / Phi^-1(0.75): makes the MAD a consistent estimator of sigma under normality.
const MAD_SCALE = 1.482602218505602;

function sorted(values) { return Float64Array.from(values).sort(); }

function medianOfSorted(s) {
  const n = s.length, mid = n >> 1;
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function median(values) {
  numberArray(values, 'values');
  return medianOfSorted(sorted(values));
}

// Median absolute deviation about the median. scaled=true multiplies by MAD_SCALE.
function mad(values, { scaled = false } = {}) {
  numberArray(values, 'values');
  const m = medianOfSorted(sorted(values));
  const deviations = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) deviations[i] = Math.abs(values[i] - m);
  const raw = medianOfSorted(deviations.sort());
  return scaled ? raw * MAD_SCALE : raw;
}

// ISO weekday of a calendar label: Monday = 1 ... Sunday = 7. Pure calendar arithmetic.
function isoWeekday(date) {
  dateLabel(date, 'date');
  const d = new Date(date + 'T00:00:00.000Z').getUTCDay();
  return d === 0 ? 7 : d;
}

function addDays(date, days) {
  const d = new Date(date + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Same-weekday baseline for `targetDate`: robust centre/scale of the same weekday over the
// `lookbackWeeks` weeks BEFORE the target (the target itself is never in its own baseline).
// series: [{ date, value, eligible? }]. A day is excluded, never zero-filled, when
//   value === null            -> reason 'null'
//   eligible === false        -> reason 'ineligible'
// Dates outside the window or on another weekday are simply not part of the baseline.
// Returns sufficient:false (with null statistics) when fewer than `minObservations` remain.
function sameWeekdayBaseline(series, targetDate, { lookbackWeeks = 8, minObservations = 4 } = {}) {
  if (!Array.isArray(series)) fail('INVALID_INPUT', 'series must be an array');
  if (series.length === 0) fail('EMPTY_INPUT', 'series must not be empty');
  dateLabel(targetDate, 'targetDate');
  integer(lookbackWeeks, 'lookbackWeeks', 1, 520);
  integer(minObservations, 'minObservations', 2, lookbackWeeks);
  const weekday = isoWeekday(targetDate);
  const from = addDays(targetDate, -7 * lookbackWeeks);
  const seen = new Set();
  const used = [], excluded = [];
  series.forEach((row, i) => {
    if (!row || typeof row !== 'object') fail('INVALID_INPUT', `series[${i}] must be an object`);
    dateLabel(row.date, `series[${i}].date`);
    if (seen.has(row.date)) fail('INVALID_INPUT', `series has duplicate date ${row.date}`);
    seen.add(row.date);
    if (row.eligible !== undefined && typeof row.eligible !== 'boolean') fail('INVALID_INPUT', `series[${i}].eligible must be a boolean`);
    // null is the only accepted "no value"; NaN/undefined/strings are errors, not gaps.
    if (row.value !== null) finiteNumber(row.value, `series[${i}].value`);
    const inWindow = row.date >= from && row.date < targetDate && isoWeekday(row.date) === weekday;
    if (!inWindow) return;
    if (row.value === null) excluded.push({ date: row.date, reason: 'null' });
    else if (row.eligible === false) excluded.push({ date: row.date, reason: 'ineligible' });
    else used.push({ date: row.date, value: row.value });
  });
  used.sort((a, b) => (a.date < b.date ? -1 : 1));
  excluded.sort((a, b) => (a.date < b.date ? -1 : 1));
  const base = { targetDate, weekday, window: { from, toExclusive: targetDate }, lookbackWeeks, minObservations,
    n: used.length, usedDates: used.map(r => r.date), excluded };
  if (used.length < minObservations) return { ...base, sufficient: false, median: null, mad: null, madScaled: null };
  const values = used.map(r => r.value);
  const m = median(values), raw = mad(values);
  return { ...base, sufficient: true, median: m, mad: raw, madScaled: raw * MAD_SCALE };
}

// Robust z-score against a baseline. Returns null (not Infinity) when the scale is zero.
function robustZ(value, baseline) {
  finiteNumber(value, 'value');
  if (!baseline || baseline.sufficient !== true) return null;
  if (!(baseline.madScaled > 0)) return null;
  return (value - baseline.median) / baseline.madScaled;
}

module.exports = { MAD_SCALE, median, mad, isoWeekday, sameWeekdayBaseline, robustZ, StatsError };
