'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  secondOfDayFromLine,
  buildRevenueSummaryResult,
  publicRevenueSummary,
} = require('../lib/revenue-summary');

function source(lines, complete = true) {
  return {
    lines,
    meta: {
      ok: complete,
      complete,
      pages: 1,
      rawLineCount: lines.length,
      processedLineCount: lines.length,
      outOfRange: 0,
      duplicatesRemoved: 0,
      invalidCount: 0,
      conflicts: complete ? [] : [{ conflict: true }],
      start: '2025-09-22',
      end: '2025-09-25',
    },
  };
}

describe('compact revenue summary', () => {
  test('aggregates complete, daily and exact-second revenue including refunds', () => {
    const result = buildRevenueSummaryResult(source([
      { _cphDate: '2025-09-22', timestamp_pay: '2025-09-22 09:00:00', priceexclvat: 100 },
      { _cphDate: '2025-09-22', timestamp_pay: '2025-09-22 09:00:00', priceexclvat: 25 },
      { _cphDate: '2025-09-22', timestamp_pay: '2025-09-22 10:00:00', priceexclvat: -10 },
      { _cphDate: '2025-09-23', timestamp_pay: '2025-09-23 12:00:00', priceexclvat: 50 },
    ]));
    assert.equal(result.summary.completeRevenue, 165);
    assert.deepEqual(result.summary.daily, [
      { date: '2025-09-22', revenue: 115, seconds: [[32400, 125], [36000, -10]], missingTimeLineCount: 0 },
      { date: '2025-09-23', revenue: 50, seconds: [[43200, 50]], missingTimeLineCount: 0 },
    ]);
    assert.deepEqual(result.lines, [], 'full product lines are discarded');
  });

  test('missing-time revenue remains in complete totals but outside timed boundary data', () => {
    const result = buildRevenueSummaryResult(source([
      { _cphDate: '2025-09-24', timestamp_pay: '2025-09-24', priceexclvat: 100 },
    ]));
    assert.equal(result.summary.completeRevenue, 100);
    assert.deepEqual(result.summary.daily[0], {
      date: '2025-09-24', revenue: 100, seconds: [], missingTimeLineCount: 1,
    });
  });

  test('public response includes time resolution for the requested boundary only', () => {
    const result = buildRevenueSummaryResult(source([
      { _cphDate: '2025-09-22', timestamp_pay: '2025-09-22 09:00:00', priceexclvat: 10 },
      { _cphDate: '2025-09-23', timestamp_pay: '2025-09-23 10:00:00', priceexclvat: 20 },
    ]));
    const response = publicRevenueSummary(result, '2025-09-23');
    assert.deepEqual(response.dailyRevenue, [
      { date: '2025-09-22', revenue: 10 },
      { date: '2025-09-23', revenue: 20 },
    ]);
    assert.deepEqual(response.boundary.seconds, [[36000, 20]]);
    assert.doesNotMatch(JSON.stringify(response), /2025-09-22 09:00:00|timestamp_pay/);
  });

  test('zero revenue is a valid complete result', () => {
    const response = publicRevenueSummary(buildRevenueSummaryResult(source([])));
    assert.equal(response.completeRevenue, 0);
    assert.deepEqual(response.dailyRevenue, []);
    assert.equal(response.boundary, null);
  });

  test('second extraction rejects missing and invalid clock values', () => {
    assert.equal(secondOfDayFromLine({ timestamp_pay: '2025-09-24 23:59:59' }), 86399);
    assert.equal(secondOfDayFromLine({ datetime: '2025-09-24T12:34:56' }), 45296);
    assert.equal(secondOfDayFromLine({ timestamp_pay: '2025-09-24 24:00:00' }), null);
    assert.equal(secondOfDayFromLine({ timestamp_pay: null }), null);
  });
});
