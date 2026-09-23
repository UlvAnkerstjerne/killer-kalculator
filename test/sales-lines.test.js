'use strict';
// Unit tests for lib/sales-lines.js
// Tests are grouped to prove each contract individually.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const fs     = require('node:fs');

const { toCphDate, processLines } = require('../lib/sales-lines');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal valid raw API line.  Override any field via `over`. */
const mkLine = (over = {}) => ({
  orderlineid:   1,
  orderid:       100,
  timestamp_pay: '2026-09-20 12:00:00',
  productid:     99001,
  productname:   'Test Product',
  productgroup:  'Test',
  price:         100,
  priceexclvat:  80,
  discount:      0,
  count:         1,
  paymenttype:   'Betalingskort',
  ...over,
});

const FIRMAID = '18095';
const D20     = '2026-09-20';   // reference date
const D21     = '2026-09-21';

// ── toCphDate: basic parsing ──────────────────────────────────────────────────
describe('toCphDate — basic parsing', () => {
  test('parses standard CPH-local datetime string', () => {
    assert.equal(toCphDate('2026-09-20 14:31:00'), '2026-09-20');
  });

  test('parses ISO 8601 variant with T separator', () => {
    assert.equal(toCphDate('2026-09-20T14:31:00'), '2026-09-20');
  });

  test('trims leading/trailing whitespace', () => {
    assert.equal(toCphDate('  2026-09-20 14:31:00  '), '2026-09-20');
  });

  test('returns null for null', () => {
    assert.equal(toCphDate(null), null);
  });

  test('returns null for undefined', () => {
    assert.equal(toCphDate(undefined), null);
  });

  test('returns null for empty string', () => {
    assert.equal(toCphDate(''), null);
  });

  test('returns null for date-only string (no time component)', () => {
    assert.equal(toCphDate('2026-09-20'), null);
  });

  test('returns null for slash-separated date', () => {
    assert.equal(toCphDate('20/09/2026 12:00:00'), null);
  });

  test('returns null for invalid month 13', () => {
    assert.equal(toCphDate('2026-13-01 12:00:00'), null);
  });

  test('returns null for invalid day 00', () => {
    assert.equal(toCphDate('2026-09-00 12:00:00'), null);
  });
});

// ── toCphDate: DST transitions ────────────────────────────────────────────────
// Denmark / Europe/Copenhagen:
//   Spring 2026 forward  — 2026-03-29 02:00 CET → 03:00 CEST (UTC+1→UTC+2)
//   Fall   2026 back     — 2026-10-25 03:00 CEST → 02:00 CET  (UTC+2→UTC+1)
//
// Because timestamp_pay is already in CPH local time, the calendar date is the
// date portion of the string.  DST transitions are within-day events, so they
// never push a CPH-local time into the adjacent calendar day.
describe('toCphDate — DST transitions', () => {
  // Spring forward ─────────────────────────────────────────────────────────────
  test('spring forward 2026-03-29: 01:59:59 (last second before gap) → correct date', () => {
    assert.equal(toCphDate('2026-03-29 01:59:59'), '2026-03-29');
  });

  test('spring forward 2026-03-29: 03:00:00 (first second after gap) → correct date', () => {
    assert.equal(toCphDate('2026-03-29 03:00:00'), '2026-03-29');
  });

  test('spring forward: day before transition → adjacent date', () => {
    assert.equal(toCphDate('2026-03-28 23:59:59'), '2026-03-28');
  });

  // Fall back ──────────────────────────────────────────────────────────────────
  test('fall back 2026-10-25: 01:59:59 (before ambiguous hour) → correct date', () => {
    assert.equal(toCphDate('2026-10-25 01:59:59'), '2026-10-25');
  });

  test('fall back 2026-10-25: 02:30:00 (ambiguous hour, occurs twice) → correct date', () => {
    assert.equal(toCphDate('2026-10-25 02:30:00'), '2026-10-25');
  });

  test('fall back: day before transition → adjacent date', () => {
    assert.equal(toCphDate('2026-10-24 23:59:59'), '2026-10-24');
  });
});

// ── Date range filter: inclusive start / exclusive end ────────────────────────
describe('date range filter', () => {
  const opts = (overrides = {}) => ({
    firmaid: FIRMAID, lines: [], start: D20, end: D21, ...overrides,
  });

  test('start date is inclusive — 00:00:00 on start date is kept', () => {
    const lines = [mkLine({ orderlineid: 1, timestamp_pay: '2026-09-20 00:00:00' })];
    const { lines: out, meta } = processLines({ ...opts(), lines });
    assert.equal(out.length, 1);
    assert.equal(meta.outOfRange, 0);
  });

  test('end date is exclusive — 00:00:00 on end date is excluded', () => {
    const lines = [mkLine({ orderlineid: 2, timestamp_pay: '2026-09-21 00:00:00' })];
    const { lines: out, meta } = processLines({ ...opts(), lines });
    assert.equal(out.length, 0);
    assert.equal(meta.outOfRange, 1);
  });

  test('23:59:59 on start date is included', () => {
    const lines = [mkLine({ orderlineid: 3, timestamp_pay: '2026-09-20 23:59:59' })];
    const { lines: out } = processLines({ ...opts(), lines });
    assert.equal(out.length, 1);
  });

  test('23:59:59 on day before start is excluded', () => {
    const lines = [mkLine({ orderlineid: 4, timestamp_pay: '2026-09-19 23:59:59' })];
    const { lines: out, meta } = processLines({ ...opts(), lines });
    assert.equal(out.length, 0);
    assert.equal(meta.outOfRange, 1);
  });

  test('multi-day response is correctly split by date', () => {
    const lines = [
      mkLine({ orderlineid: 10, timestamp_pay: '2026-09-19 22:00:00' }),  // before
      mkLine({ orderlineid: 11, timestamp_pay: '2026-09-20 08:00:00' }),  // in range
      mkLine({ orderlineid: 12, timestamp_pay: '2026-09-20 21:00:00' }),  // in range
      mkLine({ orderlineid: 13, timestamp_pay: '2026-09-21 00:30:00' }),  // after
    ];
    const { lines: out, meta } = processLines({ ...opts(), lines });
    assert.equal(out.length, 2);
    assert.equal(meta.outOfRange, 2);
  });

  test('inputCount equals outOfRange + invalidCount + outputCount + duplicatesRemoved + conflicts', () => {
    const lines = [
      mkLine({ orderlineid: 20, timestamp_pay: '2026-09-19 12:00:00' }),  // out of range
      mkLine({ orderlineid: 21, timestamp_pay: '2026-09-20 12:00:00' }),  // in range
      mkLine({ orderlineid: 21, timestamp_pay: '2026-09-20 12:00:00' }),  // dup
      mkLine({ orderlineid: 22, timestamp_pay: null }),                   // invalid
    ];
    const { meta: m } = processLines({ ...opts(), lines });
    assert.equal(
      m.outOfRange + m.invalidCount + m.outputCount + m.duplicatesRemoved + m.conflicts.length,
      m.inputCount,
    );
  });
});

// ── DST transitions in processLines ──────────────────────────────────────────
describe('processLines — DST boundary filtering', () => {
  // Spring forward 2026-03-29 ──────────────────────────────────────────────────
  test('spring forward: 01:59:59 on transition day is included for that day', () => {
    const lines = [mkLine({ orderlineid: 30, timestamp_pay: '2026-03-29 01:59:59' })];
    const { lines: out } = processLines({ firmaid: FIRMAID, lines, start: '2026-03-29', end: '2026-03-30' });
    assert.equal(out.length, 1);
  });

  test('spring forward: 03:00:00 on transition day is included for that day', () => {
    const lines = [mkLine({ orderlineid: 31, timestamp_pay: '2026-03-29 03:00:00' })];
    const { lines: out } = processLines({ firmaid: FIRMAID, lines, start: '2026-03-29', end: '2026-03-30' });
    assert.equal(out.length, 1);
  });

  test('spring forward: 23:59:59 the day before is excluded when filtering for transition day', () => {
    const lines = [mkLine({ orderlineid: 32, timestamp_pay: '2026-03-28 23:59:59' })];
    const { lines: out, meta } = processLines({ firmaid: FIRMAID, lines, start: '2026-03-29', end: '2026-03-30' });
    assert.equal(out.length, 0);
    assert.equal(meta.outOfRange, 1);
  });

  // Fall back 2026-10-25 ───────────────────────────────────────────────────────
  test('fall back: 02:30:00 (ambiguous hour) on transition day is included for that day', () => {
    const lines = [mkLine({ orderlineid: 33, timestamp_pay: '2026-10-25 02:30:00' })];
    const { lines: out } = processLines({ firmaid: FIRMAID, lines, start: '2026-10-25', end: '2026-10-26' });
    assert.equal(out.length, 1);
  });

  test('fall back: 23:59:59 the day before is excluded when filtering for transition day', () => {
    const lines = [mkLine({ orderlineid: 34, timestamp_pay: '2026-10-24 23:59:59' })];
    const { lines: out, meta } = processLines({ firmaid: FIRMAID, lines, start: '2026-10-25', end: '2026-10-26' });
    assert.equal(out.length, 0);
    assert.equal(meta.outOfRange, 1);
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────────
describe('deduplication', () => {
  const opts = { firmaid: FIRMAID, start: D20, end: D21 };

  test('repeated import of identical lines is idempotent — second copy is dropped', () => {
    const line = mkLine({ orderlineid: 40 });
    const { lines: out, meta } = processLines({ ...opts, lines: [line, line] });
    assert.equal(out.length, 1);
    assert.equal(meta.duplicatesRemoved, 1);
    assert.equal(meta.conflicts.length, 0);
  });

  test('three identical copies: one kept, two dropped', () => {
    const line = mkLine({ orderlineid: 41 });
    const { lines: out, meta } = processLines({ ...opts, lines: [line, line, line] });
    assert.equal(out.length, 1);
    assert.equal(meta.duplicatesRemoved, 2);
  });

  test('identical-looking genuine purchases with different orderlineids remain distinct', () => {
    // Same product, price, count — different orderlineid → both legitimate
    const a = mkLine({ orderlineid: 42, productid: 99001, price: 149, count: 1 });
    const b = mkLine({ orderlineid: 43, productid: 99001, price: 149, count: 1 });
    const { lines: out, meta } = processLines({ ...opts, lines: [a, b] });
    assert.equal(out.length, 2);
    assert.equal(meta.duplicatesRemoved, 0);
    assert.equal(meta.conflicts.length, 0);
  });

  test('same orderlineid with different price is reported as a conflict', () => {
    const a = mkLine({ orderlineid: 44, price: 100 });
    const b = mkLine({ orderlineid: 44, price: 200 });   // same ID, different price
    const { lines: out, meta } = processLines({ ...opts, lines: [a, b] });
    assert.equal(out.length, 1);                         // first retained
    assert.equal(meta.conflicts.length, 1);
    assert.equal(meta.conflicts[0].key, `${FIRMAID}:44`);
    assert.equal(meta.complete, false);
  });

  test('conflict entry contains both first and second line', () => {
    const a = mkLine({ orderlineid: 45, price: 100 });
    const b = mkLine({ orderlineid: 45, price: 999 });
    const { meta } = processLines({ ...opts, lines: [a, b] });
    assert.equal(meta.conflicts[0].first.price,  100);
    assert.equal(meta.conflicts[0].second.price, 999);
  });

  test('dedup key is scoped to firmaid — same orderlineid from different firmaids is not a conflict', () => {
    const line = mkLine({ orderlineid: 46 });
    const { lines: out1 } = processLines({ firmaid: '18095', lines: [line], start: D20, end: D21 });
    const { lines: out2 } = processLines({ firmaid: '13205', lines: [line], start: D20, end: D21 });
    assert.equal(out1.length, 1);
    assert.equal(out2.length, 1);
  });

  test('complete is true when there are no invalids and no conflicts', () => {
    const { meta } = processLines({ ...opts, lines: [mkLine({ orderlineid: 47 })] });
    assert.equal(meta.complete, true);
  });

  test('complete is false when a conflict exists', () => {
    const a = mkLine({ orderlineid: 48, price: 100 });
    const b = mkLine({ orderlineid: 48, price: 200 });
    const { meta } = processLines({ ...opts, lines: [a, b] });
    assert.equal(meta.complete, false);
  });
});

// ── Value semantics ───────────────────────────────────────────────────────────
describe('value semantics', () => {
  const opts = { firmaid: FIRMAID, start: D20, end: D21 };

  test('count=2 — price is preserved as the pre-totalled line value (not multiplied again)', () => {
    // Real evidence from fixture: Kombo-Lamb count=2, price=298 (= 2 × 149)
    // Multiplying again would give 596 — wrong.
    const line = mkLine({ orderlineid: 50, count: 2, price: 298, priceexclvat: 238.4 });
    const { lines: out } = processLines({ ...opts, lines: [line] });
    assert.equal(out[0].price,        298);
    assert.equal(out[0].priceexclvat, 238.4);
    assert.equal(out[0].count,        2);
  });

  test('count=3 — price and priceexclvat are preserved as-is', () => {
    const line = mkLine({ orderlineid: 51, count: 3, price: 447, priceexclvat: 357.6 });
    const { lines: out } = processLines({ ...opts, lines: [line] });
    assert.equal(out[0].price,        447);
    assert.equal(out[0].priceexclvat, 357.6);
    assert.equal(out[0].count,        3);
  });

  test('count=-1 — count remains negative (refund unit)', () => {
    const line = mkLine({ orderlineid: 52, count: -1, price: -149, priceexclvat: -119.2 });
    const { lines: out } = processLines({ ...opts, lines: [line] });
    assert.equal(out[0].count, -1);
  });

  test('count=-1 — pre-signed negative price is not flipped', () => {
    const line = mkLine({ orderlineid: 53, count: -1, price: -149, priceexclvat: -119.2 });
    const { lines: out } = processLines({ ...opts, lines: [line] });
    assert.equal(out[0].price,        -149);
    assert.equal(out[0].priceexclvat, -119.2);
  });

  test('sum(price) across a sale and its refund nets to zero', () => {
    const sale   = mkLine({ orderlineid: 54, count:  1, price:  149, priceexclvat:  119.2 });
    const refund = mkLine({ orderlineid: 55, count: -1, price: -149, priceexclvat: -119.2 });
    const { lines: out } = processLines({ ...opts, lines: [sale, refund] });
    const total = Math.round(out.reduce((s, l) => s + parseFloat(l.price), 0) * 100) / 100;
    assert.equal(total, 0);
  });

  test('price is never multiplied by count — sum(price) ≠ sum(price×count) when count>1', () => {
    const lines = [
      mkLine({ orderlineid: 56, count: 2, price: 298 }),
      mkLine({ orderlineid: 57, count: 3, price: 447 }),
    ];
    const { lines: out } = processLines({ ...opts, lines });
    const sumP  = out.reduce((s, l) => s + parseFloat(l.price), 0);
    const sumPC = out.reduce((s, l) => s + parseFloat(l.price) * parseFloat(l.count), 0);
    // 298+447=745 vs 298*2+447*3=596+1341=1937
    assert.equal(sumP,  745);
    assert.equal(sumPC, 1937);
    assert.notEqual(sumP, sumPC);
  });

  test('_cphDate is appended to each processed line', () => {
    const line = mkLine({ orderlineid: 58, timestamp_pay: '2026-09-20 15:00:00' });
    const { lines: out } = processLines({ ...opts, lines: [line] });
    assert.equal(out[0]._cphDate, '2026-09-20');
  });
});

// ── Invalid timestamps ────────────────────────────────────────────────────────
describe('invalid timestamps', () => {
  const opts = { firmaid: FIRMAID, start: D20, end: D21 };

  test('null timestamp_pay — counted as invalid, never treated as zero or today', () => {
    const line = mkLine({ orderlineid: 60, timestamp_pay: null });
    const { lines: out, meta } = processLines({ ...opts, lines: [line] });
    assert.equal(out.length, 0);
    assert.equal(meta.invalidCount, 1);
    assert.equal(meta.complete, false);
  });

  test('line with no timestamp fields — counted as invalid', () => {
    // eslint-disable-next-line no-unused-vars
    const { timestamp_pay, ...noTs } = mkLine({ orderlineid: 61 });
    const { lines: out, meta } = processLines({ ...opts, lines: [noTs] });
    assert.equal(out.length, 0);
    assert.equal(meta.invalidCount, 1);
  });

  test('garbage string timestamp — counted as invalid', () => {
    const line = mkLine({ orderlineid: 62, timestamp_pay: 'not-a-timestamp' });
    const { lines: out, meta } = processLines({ ...opts, lines: [line] });
    assert.equal(out.length, 0);
    assert.equal(meta.invalidCount, 1);
  });

  test('invalid month in timestamp — counted as invalid, not silently clamped', () => {
    const line = mkLine({ orderlineid: 63, timestamp_pay: '2026-13-20 12:00:00' });
    const { lines: out, meta } = processLines({ ...opts, lines: [line] });
    assert.equal(out.length, 0);
    assert.equal(meta.invalidCount, 1);
  });

  test('datetime fallback used when timestamp_pay absent', () => {
    // eslint-disable-next-line no-unused-vars
    const { timestamp_pay, ...base } = mkLine({ orderlineid: 64 });
    const line = { ...base, datetime: '2026-09-20 14:00:00' };
    const { lines: out, meta } = processLines({ ...opts, lines: [line] });
    assert.equal(out.length, 1);
    assert.equal(meta.invalidCount, 0);
  });
});

// ── processLines argument validation ─────────────────────────────────────────
describe('processLines — argument validation', () => {
  test('throws when firmaid is missing', () => {
    assert.throws(() => processLines({ lines: [], start: D20, end: D21 }), /firmaid/);
  });

  test('throws when start >= end', () => {
    assert.throws(
      () => processLines({ firmaid: FIRMAID, lines: [], start: D20, end: D20 }),
      /before/,
    );
  });

  test('handles null lines gracefully (treated as empty)', () => {
    const { lines: out, meta } = processLines({ firmaid: FIRMAID, lines: null, start: D20, end: D21 });
    assert.equal(out.length, 0);
    assert.equal(meta.inputCount, 0);
  });
});

// ── Nørrebro 2026-09-20 fixture reconciliation ────────────────────────────────
describe('Nørrebro 2026-09-20 fixture reconciliation', () => {
  const FIXTURE = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, 'fixtures', 'norrebro-2026-09-20.fixture.json'),
      'utf8',
    ),
  );

  // The sanitised fixture has `date` (not timestamp_pay) and `line_id` (not
  // orderlineid) — both were stripped from the raw production data.
  // We reconstruct the minimum fields processLines needs:
  //   timestamp_pay: CPH-local midday on the fixture date (always in range)
  //   orderlineid:   1-based index (unique per line → no dedup triggered)
  const adapted = FIXTURE.lines.map((l, i) => ({
    ...l,
    timestamp_pay: `${l.date} 12:00:00`,
    orderlineid:   i + 1,
  }));

  test('all 466 fixture lines are in-range and pass through unchanged', () => {
    const { lines: out, meta } = processLines({
      firmaid: '18095',
      lines:   adapted,
      start:   D20,
      end:     D21,
    });
    assert.equal(out.length,            466, `Expected 466, got ${out.length}`);
    assert.equal(meta.outOfRange,       0);
    assert.equal(meta.duplicatesRemoved, 0);
    assert.equal(meta.invalidCount,     0);
    assert.equal(meta.conflicts.length,  0);
    assert.equal(meta.complete,          true);
  });

  test('processed fixture reconciles to exactly 13,143.68 DKK ex VAT', () => {
    const { lines: out } = processLines({
      firmaid: '18095',
      lines:   adapted,
      start:   D20,
      end:     D21,
    });
    const total = Math.round(
      out.reduce((s, l) => s + parseFloat(l.priceexclvat ?? 0), 0) * 100,
    ) / 100;
    assert.equal(total, 13143.68);
  });
});
