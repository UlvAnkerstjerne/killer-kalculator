'use strict';

const assert = require('node:assert/strict');
const { estimateSerializedBytes } = require('../../lib/sales-range-cache');

const STORES = ['indre-by', 'vesterbro', 'christianshavn', 'fisketorvet', 'frederiksberg', 'norrebro'];
const RETAINED_BYTES = 30_459_173;
const CURRENT_BYTES = 3_000_933;
const REJECTED_BYTES = { fisketorvet: 7_796_599, norrebro: 3_511_723 };
const RANGES = {
  week: { start: '2026-09-21', end: '2026-09-24' },
  today: { start: '2026-09-23', end: '2026-09-24' },
  'last-week': { start: '2026-09-14', end: '2026-09-21' },
  yesterday: { start: '2026-09-22', end: '2026-09-23' },
  'last-month': { start: '2026-08-01', end: '2026-09-01' },
};

// Synthetic ASCII padding exercises real JSON byte accounting and admission.
// This models serialized size, not production line contents or heap usage.
function sizedResult(args, bytes) {
  const result = {
    lines: [{ priceexclvat: 100, productname: '' }],
    meta: { complete: true, pages: 1, rawLineCount: 1, processedLineCount: 1,
      conflicts: [], storeId: args.storeId, start: args.start, end: args.end },
  };
  const padding = bytes - estimateSerializedBytes(result);
  assert.ok(padding >= 0);
  result.lines[0].productname = 'x'.repeat(padding);
  assert.equal(estimateSerializedBytes(result), bytes);
  return result;
}

function simulateProductionAdmission(cache) {
  assert.equal(cache.stats().entries, 0, 'simulation requires an empty cache');
  const candidates = [];
  // Production logged these aggregates, not individual retained-entry sizes.
  // Distribute the current total across 12 keys and the remaining retained
  // bytes across 12 completed day/week keys plus four month keys.
  let currentIndex = 0;
  for (const period of ['week', 'today']) for (const storeId of STORES) {
    candidates.push({ period, storeId, ...RANGES[period],
      bytes: Math.floor(CURRENT_BYTES / 12) + (currentIndex++ < CURRENT_BYTES % 12 ? 1 : 0) });
  }
  const historyBytes = (RETAINED_BYTES - CURRENT_BYTES) / 16;
  assert.ok(Number.isInteger(historyBytes));
  for (const period of ['last-week', 'yesterday', 'last-month']) for (const storeId of STORES) {
    candidates.push({ period, storeId, ...RANGES[period],
      bytes: period === 'last-month' ? (REJECTED_BYTES[storeId] || historyBytes) : historyBytes });
  }
  const currentEntries = new Map();
  const outcomes = candidates.map(candidate => {
    const result = sizedResult(candidate, candidate.bytes);
    const retained = cache.prime(candidate, result, { allowEviction: false });
    if (['week', 'today'].includes(candidate.period)) currentEntries.set(candidate, result);
    return { ...candidate, retained };
  });
  return {
    kind: 'serialized-size simulation; retained-entry allocation is representative, not measured individually',
    measuredRetainedBytes: RETAINED_BYTES,
    outcomes,
    allLastMonthAdmitted: outcomes.filter(o => o.period === 'last-month').every(o => o.retained),
    currentEntriesRetained: [...currentEntries].every(([args, result]) => cache.inspect(args)?.result === result),
    ...cache.stats(),
    headroomBytes: cache.stats().maxBytes - cache.stats().estimatedBytes,
  };
}

module.exports = { sizedResult, simulateProductionAdmission };
