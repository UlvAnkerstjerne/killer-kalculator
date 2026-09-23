'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createSalesRangeCache,
  DEFAULT_CURRENT_TTL_MS,
  DEFAULT_HISTORICAL_TTL_MS,
  DEFAULT_REFRESH_AHEAD_MS,
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

function fakeScheduler() {
  let nextId = 1;
  const scheduled = new Map();
  return {
    scheduled,
    setTimer(callback, delay) {
      const id = nextId++;
      scheduled.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) { scheduled.delete(id); },
    fire(id) {
      const timer = scheduled.get(id);
      scheduled.delete(id);
      timer.callback();
    },
  };
}

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
    assert.equal(DEFAULT_CURRENT_TTL_MS, 10 * 60 * 1000);
    assert.equal(current.freshUntil - current.fetchedAt, DEFAULT_CURRENT_TTL_MS);
    assert.equal(historical.freshUntil - historical.fetchedAt, DEFAULT_HISTORICAL_TTL_MS);
    assert.ok(historical.freshUntil > current.freshUntil);
  });

  test('startup-warmed current data refreshes once shortly before ten-minute expiry', async () => {
    let nowMs = Date.parse('2026-09-23T12:00:00Z');
    let calls = 0;
    let finishRefresh;
    const scheduler = fakeScheduler();
    const cache = createSalesRangeCache({
      now: () => nowMs,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      fetchRange: async ({ start, end }) => {
        calls++;
        if (calls === 1) return completeResult(start, end, 100);
        return new Promise(resolve => { finishRefresh = () => resolve(completeResult(start, end, 125)); });
      },
    });
    await cache.get(TODAY);
    assert.equal(scheduler.scheduled.size, 1);
    const [timerId, timer] = [...scheduler.scheduled.entries()][0];
    assert.equal(timer.delay, DEFAULT_CURRENT_TTL_MS - DEFAULT_REFRESH_AHEAD_MS);

    nowMs += DEFAULT_CURRENT_TTL_MS - DEFAULT_REFRESH_AHEAD_MS;
    scheduler.fire(timerId);
    assert.equal(calls, 2, 'one initial fetch and one shared refresh');

    // Once the old value reaches ten minutes, callers wait for the already
    // running refresh instead of receiving over-age data or duplicating I/O.
    nowMs += DEFAULT_REFRESH_AHEAD_MS + 1;
    let settled = false;
    const a = cache.get(TODAY).then(value => { settled = true; return value; });
    const b = cache.get(TODAY);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'data older than ten minutes is not returned');
    assert.equal(calls, 2, 'warming and user requests share the refresh');

    finishRefresh();
    const [first, second] = await Promise.all([a, b]);
    assert.equal(first.result.lines[0].priceexclvat, 125);
    assert.equal(second.result.lines[0].priceexclvat, 125);
    assert.equal(cache.stats().refreshTimers, 0, 'proactive refresh does not create a polling loop');
  });

  test('refresh failure retains the last success internally but never serves it past ten minutes', async () => {
    let nowMs = Date.parse('2026-09-23T12:00:00Z');
    let calls = 0;
    const scheduler = fakeScheduler();
    const cache = createSalesRangeCache({
      now: () => nowMs,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      fetchRange: async ({ start, end }) => {
        calls++;
        if (calls === 1) return completeResult(start, end, 321);
        throw new Error('OnlinePOS unavailable');
      },
    });
    await cache.get(TODAY);
    nowMs += DEFAULT_CURRENT_TTL_MS - DEFAULT_REFRESH_AHEAD_MS;
    scheduler.fire([...scheduler.scheduled.keys()][0]);
    await new Promise(resolve => setImmediate(resolve));

    const retained = cache.inspect(TODAY);
    assert.equal(retained.result.lines[0].priceexclvat, 321);
    assert.equal(retained.lastRefreshError, 'OnlinePOS unavailable');

    nowMs += DEFAULT_REFRESH_AHEAD_MS + 1;
    await assert.rejects(cache.get(TODAY), /OnlinePOS unavailable/);
    assert.equal(calls, 3, 'expired data triggers a new coalescible refresh');
    assert.equal(cache.inspect(TODAY).result.lines[0].priceexclvat, 321);
  });

  test('inactive open keys are not proactively refreshed', async () => {
    let nowMs = Date.parse('2026-09-23T12:00:00Z');
    let calls = 0;
    const scheduler = fakeScheduler();
    const cache = createSalesRangeCache({
      now: () => nowMs,
      recentAccessMs: 5 * 60 * 1000,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      fetchRange: async ({ start, end }) => { calls++; return completeResult(start, end); },
    });
    await cache.get(TODAY);
    nowMs += DEFAULT_CURRENT_TTL_MS - DEFAULT_REFRESH_AHEAD_MS;
    scheduler.fire([...scheduler.scheduled.keys()][0]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(cache.stats().refreshTimers, 0);
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

  test('proactive refresh timers are bounded with current-range cache entries', async () => {
    const scheduler = fakeScheduler();
    const cache = createSalesRangeCache({
      maxEntries: 2,
      now: () => Date.parse('2026-09-23T12:00:00Z'),
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      fetchRange: async ({ start, end }) => completeResult(start, end),
    });
    await cache.get({ ...TODAY, storeId: 'a' });
    await cache.get({ ...TODAY, storeId: 'b' });
    await cache.get({ ...TODAY, storeId: 'c' });
    assert.equal(cache.stats().entries, 2);
    assert.equal(cache.stats().refreshTimers, 2);
    assert.equal(scheduler.scheduled.size, 2);
  });

  test('production server starts a coalesced warm of the default current range', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(source, /async function warmCurrentSalesRanges\(\)/);
    assert.match(source, /void warmCurrentSalesRanges\(\)/);
    assert.match(source, /salesRangeCache\.get\(\{\s*storeId, store, start: today, end: tomorrow/);
  });
});
