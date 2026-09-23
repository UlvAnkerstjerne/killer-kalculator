'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { completedRanges, warmCompletedPeriods } = require('../lib/completed-period-warming');
const { createSalesRangeCache, DEFAULT_HISTORICAL_TTL_MS, DEFAULT_MAX_BYTES, estimateSerializedBytes } = require('../lib/sales-range-cache');
const { createSharedSalesFetcher } = require('../lib/shared-sales-fetcher');
const { deriveSalesSubrange } = require('../lib/sales-range-derivation');
const { buildRevenueSummaryResult, deriveRevenueSummarySubrange } = require('../lib/revenue-summary');
const { cphMidnightUnix } = require('../lib/pos-fetcher');
const stores = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map(id => [id, {}]));
function result(start, end, complete = true) {
  return { lines: [{ _cphDate: start, timestamp_pay: start + ' 23:59:59', count: -2, priceexclvat: -100 }],
    meta: { complete, pages: 1, rawLineCount: 1, processedLineCount: 1, conflicts: [], start, end } };
}
function setup(today = '2026-09-23', extra = {}) {
  const calls = [];
  const now = () => Date.parse(today + 'T12:00:00Z');
  const fetcher = createSharedSalesFetcher(async args => {
    calls.push(args);
    await new Promise(resolve => setImmediate(resolve));
    return result(args.start, args.end);
  });
  const salesCache = createSalesRangeCache({ fetchRange: fetcher, deriveRange: deriveSalesSubrange, now, ...extra });
  const summaryCache = createSalesRangeCache({ fetchRange: async args => buildRevenueSummaryResult(await fetcher(args)), deriveRange: deriveRevenueSummarySubrange, now });
  return { today, stores, salesCache, summaryCache, calls, log: () => {}, warn: () => {}, now };
}

test('completed presets use CPH calendar boundaries across Monday, year, leap and DST transitions', () => {
  for (const [today, expected] of [
    ['2026-09-23', [['2026-09-14', '2026-09-21'], ['2026-09-22', '2026-09-23'], ['2026-08-01', '2026-09-01']]],
    ['2026-09-21', [['2026-09-14', '2026-09-21'], ['2026-09-20', '2026-09-21'], ['2026-08-01', '2026-09-01']]],
    ['2027-01-01', [['2026-12-21', '2026-12-28'], ['2026-12-31', '2027-01-01'], ['2026-12-01', '2027-01-01']]],
    ['2024-03-01', [['2024-02-19', '2024-02-26'], ['2024-02-29', '2024-03-01'], ['2024-02-01', '2024-03-01']]],
    ['2026-03-30', [['2026-03-23', '2026-03-30'], ['2026-03-29', '2026-03-30'], ['2026-02-01', '2026-03-01']]],
  ]) {
    const ranges = completedRanges(today);
    assert.deepEqual(ranges.map(r => r.name), ['last-week', 'yesterday', 'last-month']);
    assert.deepEqual(ranges.map(r => [r.start, r.end]), expected);
  }
  assert.equal(cphMidnightUnix('2026-03-30') - cphMidnightUnix('2026-03-29'), 23 * 3600);
  assert.equal(cphMidnightUnix('2026-10-26') - cphMidnightUnix('2026-10-25'), 25 * 3600);
});

test('all six stores get current lines + compact LY, six-hour historical TTL, and no timers', async () => {
  const ctx = setup();
  const report = await warmCompletedPeriods(ctx);
  assert.equal(report.outcomes.length, 36);
  assert.ok(report.outcomes.every(o => o.complete && o.retained));
  assert.equal(ctx.salesCache.stats().refreshTimers, 0);
  assert.equal(ctx.summaryCache.stats().refreshTimers, 0);
  for (const outcome of report.outcomes) {
    const entry = (outcome.kind === 'ly' ? ctx.summaryCache : ctx.salesCache).inspect(outcome);
    assert.equal(entry.freshUntil - entry.fetchedAt, DEFAULT_HISTORICAL_TTL_MS);
    if (outcome.kind === 'ly') assert.deepEqual(entry.result.lines, []);
  }
  const count = ctx.calls.length;
  await warmCompletedPeriods(ctx);
  assert.equal(ctx.calls.length, count, 'repeated warm makes no exports');
  ctx.salesCache.clear(); ctx.summaryCache.clear();
});

test('Monday derives Yesterday from Last Week, never from current Monday', async () => {
  const ctx = setup('2026-09-21');
  const current = { storeId: 'a', start: '2026-09-21', end: '2026-09-22' };
  await ctx.salesCache.get(current);
  const report = await warmCompletedPeriods(ctx);
  const yesterday = report.outcomes.find(o => o.kind === 'current' && o.period === 'yesterday' && o.storeId === 'a');
  assert.equal(yesterday.status, 'derived');
  assert.deepEqual(ctx.salesCache.inspect(yesterday).result.meta.derivedFrom, { start: '2026-09-14', end: '2026-09-21' });
  assert.ok(!ctx.calls.some(c => c.start === '2026-09-20'));
  ctx.salesCache.clear(); ctx.summaryCache.clear();
});

test('Yesterday safely derives signed lines within inclusive/exclusive boundaries from This Week', async () => {
  const ctx = setup();
  const parent = { storeId: 'a', start: '2026-09-21', end: '2026-09-24' };
  const source = result(parent.start, parent.end);
  source.lines = ['2026-09-21', '2026-09-22', '2026-09-23'].map(date => ({ _cphDate: date, count: -2, priceexclvat: -100 }));
  ctx.salesCache.prime(parent, source);
  const response = await ctx.salesCache.get({ storeId: 'a', start: '2026-09-22', end: '2026-09-23' });
  assert.equal(response.cacheStatus, 'derived');
  assert.deepEqual(response.result.lines, [{ _cphDate: '2026-09-22', count: -2, priceexclvat: -100 }]);
  assert.equal(ctx.calls.length, 0);
  ctx.salesCache.clear(); ctx.summaryCache.clear();
});

test('incomplete or expired broader data is never used for derivation', async () => {
  const ctx = setup();
  const parent = { storeId: 'a', start: '2026-09-21', end: '2026-09-24' };
  assert.equal(ctx.salesCache.prime(parent, result(parent.start, parent.end, false)), false);
  assert.equal(deriveSalesSubrange(result(parent.start, parent.end, false), '2026-09-22', '2026-09-23'), null);
  assert.equal(deriveRevenueSummarySubrange(buildRevenueSummaryResult(result(parent.start, parent.end, false)), '2026-09-22', '2026-09-23'), null);
  ctx.salesCache.prime(parent, result(parent.start, parent.end), { fetchedAt: ctx.now() - 3600000 });
  const response = await ctx.salesCache.get({ storeId: 'a', start: '2026-09-22', end: '2026-09-23' });
  assert.equal(response.cacheStatus, 'miss');
  assert.equal(ctx.calls.length, 1);
  ctx.salesCache.clear(); ctx.summaryCache.clear();
});

test('shared export queue caps combined caches/users/warming at two and coalesces identical ranges', async () => {
  let active = 0, maxActive = 0, calls = 0;
  const shared = createSharedSalesFetcher(async args => {
    calls++; maxActive = Math.max(maxActive, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; return result(args.start, args.end);
  });
  const sales = createSalesRangeCache({ fetchRange: shared });
  const summary = createSalesRangeCache({ fetchRange: async args => buildRevenueSummaryResult(await shared(args)) });
  const args = Object.keys(stores).map(storeId => ({ storeId, start: '2025-01-01', end: '2025-02-01' }));
  await Promise.all(args.flatMap(a => [sales.get(a, { allowEviction: false }), sales.get(a), summary.get(a)]));
  assert.equal(calls, 6);
  assert.equal(maxActive, 2);
  sales.clear(); summary.clear();
});

test('failures/incomplete stores remain unavailable and logs omit upstream error details', async () => {
  const ctx = setup();
  const logs = [];
  ctx.warn = message => logs.push(message);
  ctx.salesCache = createSalesRangeCache({ fetchRange: async args => {
    if (args.storeId === 'a') throw new Error('secret-provider-value');
    return result(args.start, args.end, args.storeId !== 'b');
  } });
  const report = await warmCompletedPeriods(ctx);
  assert.equal(report.outcomes.filter(o => o.kind === 'current' && !o.complete).length, 6);
  for (const range of completedRanges(ctx.today)) {
    assert.equal(ctx.salesCache.inspect({ storeId: 'a', ...range }), null);
    assert.equal(ctx.salesCache.inspect({ storeId: 'b', ...range }), null);
  }
  assert.equal(logs.length, 6);
  assert.doesNotMatch(logs.join('\n'), /secret-provider-value/);
  ctx.salesCache.clear(); ctx.summaryCache.clear();
});

test('completed warming preserves Today/This Week under both entry and actual 32 MiB pressure', async () => {
  for (const constraint of ['entries', 'bytes']) {
    const ctx = setup('2026-09-23', constraint === 'entries' ? { maxEntries: 12 } : {});
    const priority = [];
    for (const storeId of Object.keys(stores)) for (const start of ['2026-09-21', '2026-09-23']) {
      const args = { storeId, start, end: '2026-09-24' };
      const value = result(args.start, args.end);
      if (constraint === 'bytes') value.lines[0].productname = 'x'.repeat(Math.floor(DEFAULT_MAX_BYTES / 12) - 400);
      assert.ok(ctx.salesCache.prime(args, value));
      priority.push([args, ctx.salesCache.inspect(args).result]);
    }
    const report = await warmCompletedPeriods(ctx);
    assert.ok(ctx.salesCache.stats().entries <= 120);
    assert.ok(ctx.salesCache.stats().estimatedBytes <= DEFAULT_MAX_BYTES);
    for (const [args, value] of priority) assert.equal(ctx.salesCache.inspect(args).result, value);
    assert.ok(report.outcomes.some(o => o.kind === 'current' && !o.retained));
    assert.ok(report.outcomes.filter(o => o.kind === 'ly').every(o => o.retained));
    ctx.salesCache.clear(); ctx.summaryCache.clear();
  }
});

test('non-evicting admission also applies when warming joins a user request in flight', async () => {
  let release;
  const cache = createSalesRangeCache({ maxEntries: 1, fetchRange: args => new Promise(resolve => {
    release = () => resolve(result(args.start, args.end));
  }) });
  const priority = { storeId: 'a', start: '2026-09-23', end: '2026-09-24' };
  cache.prime(priority, result(priority.start, priority.end));
  const historical = { storeId: 'a', start: '2026-08-01', end: '2026-09-01' };
  const user = cache.get(historical);
  const warm = cache.get(historical, { allowEviction: false });
  release();
  const responses = await Promise.all([user, warm]);
  assert.ok(responses.every(r => r.cacheStatus === 'uncached-capacity'));
  assert.ok(cache.inspect(priority));
  assert.equal(cache.stats().estimatedBytes, estimateSerializedBytes(result(priority.start, priority.end)));
  cache.clear();
});

test('Last Month current stores are fetched sequentially even when the shared limit allows two', async () => {
  let active = 0, peak = 0;
  const ctx = setup('2026-09-23', { fetchRange: async args => {
    const month = args.start === '2026-08-01';
    if (month) peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    if (month) active--;
    return result(args.start, args.end);
  } });
  await warmCompletedPeriods(ctx);
  assert.equal(peak, 1);
  ctx.salesCache.clear(); ctx.summaryCache.clear();
});

test('derived LY retains refunds, full-period budget basis and daily grey-bar totals', () => {
  const parent = result('2025-09-01', '2025-10-01');
  parent.lines = [
    { _cphDate: '2025-09-14', timestamp_pay: '2025-09-14 12:00:00', priceexclvat: 999 },
    { _cphDate: '2025-09-15', timestamp_pay: '2025-09-15 12:00:00', priceexclvat: 200 },
    { _cphDate: '2025-09-21', timestamp_pay: '2025-09-21 23:59:59', priceexclvat: -100 },
    { _cphDate: '2025-09-22', timestamp_pay: '2025-09-22 00:00:00', priceexclvat: 999 },
  ];
  const derived = deriveRevenueSummarySubrange(buildRevenueSummaryResult(parent), '2025-09-15', '2025-09-22');
  assert.equal(derived.summary.completeRevenue, 100);
  assert.equal(Math.round(derived.summary.completeRevenue * 1.10), 110);
  assert.deepEqual(derived.summary.daily.map(day => [day.date, day.revenue]), [['2025-09-15', 200], ['2025-09-21', -100]]);
});

test('on-demand historical admission also preserves protected current entries without partial eviction', async () => {
  const ctx = setup('2026-09-23', { maxEntries: 2,
    isProtected: ({ end }) => end === '2026-09-24' });
  const today = { storeId: 'a', start: '2026-09-23', end: '2026-09-24' };
  const week = { storeId: 'a', start: '2026-09-21', end: '2026-09-24' };
  await ctx.salesCache.get(today);
  await ctx.salesCache.get(week);
  const historical = { storeId: 'a', start: '2026-08-01', end: '2026-09-01' };
  const response = await ctx.salesCache.get(historical);
  assert.equal(response.cacheStatus, 'uncached-capacity');
  assert.ok(ctx.salesCache.inspect(today));
  assert.ok(ctx.salesCache.inspect(week));
  assert.equal(ctx.salesCache.stats().entries, 2);
  ctx.salesCache.clear(); ctx.summaryCache.clear();
});

test('crossing CPH midnight never reuses a pre-close snapshot as complete Yesterday', async () => {
  let nowMs = Date.parse('2026-09-23T21:59:00Z'); // 23:59 CPH
  let calls = 0;
  const cache = createSalesRangeCache({ now: () => nowMs, deriveRange: deriveSalesSubrange,
    fetchRange: async args => { calls++; return result(args.start, args.end); } });
  const week = { storeId: 'a', start: '2026-09-21', end: '2026-09-24' };
  const day = { storeId: 'a', start: '2026-09-23', end: '2026-09-24' };
  await cache.get(week);
  nowMs += 120000; // 00:01 CPH; parent is fresh, but predates the day's close.
  const yesterday = await cache.get(day);
  assert.equal(yesterday.cacheStatus, 'miss');
  assert.equal(calls, 2, 'must not derive the now-closed day from the open snapshot');
  const closedWeek = await cache.get(week);
  assert.equal(closedWeek.cacheStatus, 'refreshed');
  assert.equal(calls, 3, 'an exact key also requires a post-close snapshot');
  assert.equal(cache.inspect(week).freshUntil - cache.inspect(week).fetchedAt, DEFAULT_HISTORICAL_TTL_MS);
  assert.equal(cache.stats().refreshTimers, 0);
  cache.clear();
});
