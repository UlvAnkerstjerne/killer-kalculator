'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createSalesRangeCache,
  DEFAULT_CURRENT_TTL_MS,
  DEFAULT_HISTORICAL_TTL_MS,
} = require('../lib/sales-range-cache');

function completeResult(start, end, revenue = 100) {
  return {
    lines: [{ priceexclvat: revenue }],
    meta: {
      complete: true,
      pages: 1,
      rawLineCount: 1,
      processedLineCount: 1,
      conflicts: [],
      start,
      end,
    },
  };
}

const TODAY = { storeId: 'norrebro', store: {}, start: '2026-09-23', end: '2026-09-24' };
const HISTORY = { storeId: 'norrebro', store: {}, start: '2025-09-23', end: '2025-09-24' };

describe('server sales range cache', () => {
  test('repeated and simultaneous identical requests share one upstream fetch', async () => {
    let calls = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const cache = createSalesRangeCache({
      now: () => Date.parse('2026-09-23T12:00:00Z'),
      fetchRange: async ({ start, end }) => {
        calls++;
        await gate;
        return completeResult(start, end);
      },
    });

    const first = cache.get(TODAY);
    const second = cache.get(TODAY);
    assert.equal(calls, 1);
    release();
    await Promise.all([first, second]);
    await cache.get(TODAY);
    assert.equal(calls, 1, 'warm request is served from cache');
  });

  test('today ranges expire sooner than historical closed ranges', async () => {
    let nowMs = Date.parse('2026-09-23T12:00:00Z');
    const cache = createSalesRangeCache({
      now: () => nowMs,
      fetchRange: async ({ start, end }) => completeResult(start, end),
    });
    await cache.get(TODAY);
    await cache.get(HISTORY);

    const current = cache.inspect(TODAY);
    const historical = cache.inspect(HISTORY);
    assert.equal(current.freshUntil - current.fetchedAt, DEFAULT_CURRENT_TTL_MS);
    assert.equal(historical.freshUntil - historical.fetchedAt, DEFAULT_HISTORICAL_TTL_MS);
    assert.ok(historical.freshUntil > current.freshUntil);
  });

  test('expired current data is served stale while exactly one refresh runs', async () => {
    let nowMs = Date.parse('2026-09-23T12:00:00Z');
    let calls = 0;
    let finishRefresh;
    const cache = createSalesRangeCache({
      now: () => nowMs,
      currentTtlMs: 10,
      fetchRange: async ({ start, end }) => {
        calls++;
        if (calls === 1) return completeResult(start, end, 100);
        return new Promise(resolve => { finishRefresh = () => resolve(completeResult(start, end, 125)); });
      },
    });
    await cache.get(TODAY);
    nowMs += 11;

    const [a, b] = await Promise.all([cache.get(TODAY), cache.get(TODAY)]);
    assert.equal(a.cacheStatus, 'stale');
    assert.equal(b.cacheStatus, 'stale');
    assert.equal(a.result.lines[0].priceexclvat, 100);
    assert.equal(calls, 2, 'one initial fetch and one shared refresh');

    finishRefresh();
    await new Promise(resolve => setImmediate(resolve));
    const refreshed = await cache.get(TODAY);
    assert.equal(refreshed.result.lines[0].priceexclvat, 125);
  });

  test('refresh failure retains stale success and never substitutes zero', async () => {
    let nowMs = Date.parse('2026-09-23T12:00:00Z');
    let calls = 0;
    const cache = createSalesRangeCache({
      now: () => nowMs,
      currentTtlMs: 10,
      fetchRange: async ({ start, end }) => {
        calls++;
        if (calls === 1) return completeResult(start, end, 321);
        throw new Error('OnlinePOS unavailable');
      },
    });
    await cache.get(TODAY);
    nowMs += 11;
    const stale = await cache.get(TODAY);
    assert.equal(stale.result.lines[0].priceexclvat, 321);
    await new Promise(resolve => setImmediate(resolve));

    const retained = cache.inspect(TODAY);
    assert.equal(retained.result.lines[0].priceexclvat, 321);
    assert.equal(retained.lastRefreshError, 'OnlinePOS unavailable');
  });

  test('failed and incomplete initial results are not cached', async () => {
    let calls = 0;
    const cache = createSalesRangeCache({
      now: () => Date.parse('2026-09-23T12:00:00Z'),
      fetchRange: async ({ start, end }) => {
        calls++;
        if (calls === 1) throw new Error('network failure');
        if (calls === 2) {
          const result = completeResult(start, end);
          result.meta.complete = false;
          return result;
        }
        return completeResult(start, end, 77);
      },
    });
    await assert.rejects(cache.get(TODAY), /network failure/);
    assert.equal(cache.stats().entries, 0);
    const incomplete = await cache.get(TODAY);
    assert.equal(incomplete.result.meta.complete, false);
    assert.equal(incomplete.cacheStatus, 'bypass');
    assert.equal(cache.stats().entries, 0);
    const ok = await cache.get(TODAY);
    assert.equal(ok.result.lines[0].priceexclvat, 77);
    assert.equal(calls, 3);
  });

  test('cache evicts least-recently-used entries at its bound', async () => {
    const cache = createSalesRangeCache({
      maxEntries: 2,
      now: () => Date.parse('2026-09-23T12:00:00Z'),
      fetchRange: async ({ start, end }) => completeResult(start, end),
    });
    const a = { ...HISTORY, storeId: 'a' };
    const b = { ...HISTORY, storeId: 'b' };
    const c = { ...HISTORY, storeId: 'c' };
    await cache.get(a);
    await cache.get(b);
    await cache.get(a); // promote a; b is now LRU
    await cache.get(c);
    assert.equal(cache.stats().entries, 2);
    assert.ok(cache.inspect(a));
    assert.equal(cache.inspect(b), null);
    assert.ok(cache.inspect(c));
  });
});
