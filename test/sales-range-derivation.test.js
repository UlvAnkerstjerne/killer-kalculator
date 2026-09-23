'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { processLines } = require('../lib/sales-lines');
const { computeMetrics } = require('../lib/product-metrics');
const { deriveSalesSubrange } = require('../lib/sales-range-derivation');

const MONDAY = '2026-09-21';
const TODAY = '2026-09-23';
const TOMORROW = '2026-09-24';

function rawLine(orderlineid, timestamp_pay, overrides = {}) {
  return {
    orderlineid,
    timestamp_pay,
    productid: 27242336,
    productname: 'Killer Kebab',
    count: 1,
    price: 89,
    priceexclvat: 71.2,
    paymenttype: 'Dankort',
    ...overrides,
  };
}

const raw = [
  rawLine('mon-1', '2026-09-21 12:00:00', { productid: 27242208, productname: 'Kombo - Lamb' }),
  rawLine('today-sale', '2026-09-23 12:00:00', {
    productid: 27242336, count: 2, price: 178, priceexclvat: 142.4, paymenttype: 'Wolt',
  }),
  rawLine('today-refund', '2026-09-23 13:00:00', {
    productid: 27242336, count: -1, price: -89, priceexclvat: -71.2, paymenttype: 'Wolt',
  }),
  rawLine('today-kombo', '2026-09-23 14:00:00', {
    productid: 27242208, productname: 'Kombo - Lamb', price: 149, priceexclvat: 119.2,
    paymenttype: 'Online External 2',
  }),
  rawLine('today-lemonade', '2026-09-23 15:00:00', {
    productid: 27242164, productname: 'Killer Lemonade (35 kr)', price: 35, priceexclvat: 28,
  }),
  rawLine('exclusive-end', '2026-09-24 00:00:00', { priceexclvat: 9999 }),
];

function resultFor(start, end, lines = raw) {
  const processed = processLines({ firmaid: '18095', lines, start, end });
  return {
    lines: processed.lines,
    meta: {
      ok: processed.meta.complete,
      complete: processed.meta.complete,
      pages: 1,
      rawLineCount: lines.length,
      processedLineCount: processed.lines.length,
      outOfRange: processed.meta.outOfRange,
      duplicatesRemoved: processed.meta.duplicatesRemoved,
      invalidCount: processed.meta.invalidCount,
      conflicts: processed.meta.conflicts,
      start,
      end,
    },
  };
}

function channelMetrics(lines, storeId) {
  let total = 0, wolt = 0;
  for (const line of lines) {
    const revenue = line.priceexclvat || 0;
    total += revenue;
    const woltViaHeaps = storeId === 'indre-by' ? 'Online External 2' : null;
    if (line.paymenttype === 'Wolt' || line.paymenttype === woltViaHeaps) wolt += revenue;
  }
  return { total, wolt };
}

describe('weekly-to-Today sales derivation', () => {
  const weekly = resultFor(MONDAY, TOMORROW);
  const directToday = resultFor(TODAY, TOMORROW);
  const derivedToday = deriveSalesSubrange(weekly, TODAY, TOMORROW);

  test('derived lines exactly equal a direct Today fetch with exclusive end filtering', () => {
    assert.ok(derivedToday);
    assert.deepEqual(derivedToday.lines, directToday.lines);
    assert.ok(!derivedToday.lines.some(line => line.orderlineid === 'exclusive-end'));
    assert.ok(derivedToday.lines.every(line => line._cphDate === TODAY));
  });

  test('revenue ex VAT is exactly equivalent', () => {
    const revenue = lines => lines.reduce((sum, line) => sum + (line.priceexclvat || 0), 0);
    assert.equal(revenue(derivedToday.lines), revenue(directToday.lines));
  });

  test('canonical product metrics are exactly equivalent', () => {
    assert.deepEqual(computeMetrics(derivedToday.lines), computeMetrics(directToday.lines));
  });

  test('store-aware channel metrics are exactly equivalent', () => {
    assert.deepEqual(channelMetrics(derivedToday.lines, 'indre-by'), channelMetrics(directToday.lines, 'indre-by'));
    assert.deepEqual(channelMetrics(derivedToday.lines, 'norrebro'), channelMetrics(directToday.lines, 'norrebro'));
  });

  test('refund signs and counts are preserved exactly', () => {
    const derivedRefund = derivedToday.lines.find(line => line.orderlineid === 'today-refund');
    const directRefund = directToday.lines.find(line => line.orderlineid === 'today-refund');
    assert.deepEqual(derivedRefund, directRefund);
    assert.equal(derivedRefund.count, -1);
    assert.equal(derivedRefund.priceexclvat, -71.2);
  });

  test('complete state is retained only from a complete weekly parent', () => {
    assert.equal(weekly.meta.complete, true);
    assert.equal(directToday.meta.complete, true);
    assert.equal(derivedToday.meta.complete, true);

    const incompleteWeekly = resultFor(MONDAY, TOMORROW, [
      ...raw,
      rawLine('invalid', 'not-a-date'),
    ]);
    const incompleteDirectToday = resultFor(TODAY, TOMORROW, [
      ...raw,
      rawLine('invalid', 'not-a-date'),
    ]);
    assert.equal(incompleteWeekly.meta.complete, false);
    assert.equal(incompleteDirectToday.meta.complete, false);
    assert.equal(deriveSalesSubrange(incompleteWeekly, TODAY, TOMORROW), null);
  });
});
