'use strict';

const { estimateSerializedBytes } = require('./sales-range-cache');

function offsetDate(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function completedRanges(today) {
  const weekday = new Date(today + 'T12:00:00Z').getUTCDay();
  const monday = offsetDate(today, -(weekday === 0 ? 6 : weekday - 1));
  const [year, month] = today.split('-').map(Number);
  return [
    // Last Week first lets Monday's Yesterday reuse its complete Sunday data.
    { name: 'last-week', start: offsetDate(monday, -7), end: monday },
    { name: 'yesterday', start: offsetDate(today, -1), end: today },
    { name: 'last-month', start: new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10),
      end: today.slice(0, 7) + '-01' },
  ];
}

async function runBounded(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await tasks[index]() };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, tasks.length) }, () => worker()
  ));
  return results;
}

async function warmCompletedPeriods({ today, stores, salesCache, summaryCache,
  log = console.log, warn = console.warn, now = Date.now }) {
  const started = now();
  const outcomes = [];
  async function warm(cache, kind, range, storeId, store) {
    const args = { storeId, store, start: range.start, end: range.end };
    try {
      const response = await cache.get(args, { allowEviction: false });
      const complete = response.result.meta.complete;
      const retained = complete && cache.inspect(args)?.result === response.result;
      const outcome = { kind, period: range.name, storeId, start: args.start, end: args.end,
        complete, retained, status: response.cacheStatus,
        bytes: estimateSerializedBytes(response.result) };
      outcomes.push(outcome);
      if (!complete) warn(`[completed-warm] ${kind} ${range.name} ${storeId}: incomplete; unavailable`);
      else if (!retained) log(`[completed-warm] ${kind} ${range.name} ${storeId}: capacity bypass (${outcome.bytes} bytes)`);
    } catch (_) {
      // Provider error messages can contain request details; never interpolate them.
      warn(`[completed-warm] ${kind} ${range.name} ${storeId}: fetch failed; unavailable`);
      outcomes.push({ kind, period: range.name, storeId, start: args.start, end: args.end,
        complete: false, retained: false, status: 'failed', bytes: 0 });
    }
  }
  async function warmRange(cache, kind, range, concurrency) {
    await runBounded(Object.entries(stores).map(([storeId, store]) =>
      () => warm(cache, kind, range, storeId, store)
    ), concurrency);
  }
  for (const range of completedRanges(today)) {
    // Keep compact LY even if a large full-line month cannot be admitted.
    await warmRange(summaryCache, 'ly', {
      ...range, start: offsetDate(range.start, -364), end: offsetDate(range.end, -364),
    }, 2);
    // Admit one month's store at a time, measuring it before admission. No
    // completed-period write may evict Today, This Week, or any existing key.
    await warmRange(salesCache, 'current', range, range.name === 'last-month' ? 1 : 2);
  }
  const durationMs = now() - started;
  const report = { durationMs, outcomes, sales: salesCache.stats(), ly: summaryCache.stats() };
  log(`[completed-warm] complete: ${outcomes.filter(o => o.retained).length}/${outcomes.length} retained, ` +
    `${durationMs} ms, sales ${report.sales.entries} entries/${report.sales.estimatedBytes} bytes, ` +
    `LY ${report.ly.entries} entries/${report.ly.estimatedBytes} bytes`);
  return report;
}

module.exports = { completedRanges, runBounded, warmCompletedPeriods };
