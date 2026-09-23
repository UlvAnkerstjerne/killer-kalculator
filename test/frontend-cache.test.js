'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function createFrontendSalesClient({ fetchRange, maxEntries = 120, ttlMs = 60_000, now = Date.now }) {
  const cache = new Map();
  const inFlight = new Map();

  function write(key, lines) {
    cache.delete(key);
    cache.set(key, { lines, expiresAt: now() + ttlMs });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }

  async function get(storeId, start, end) {
    const key = `srange:${storeId}:${start}:${end}`;
    const hit = cache.get(key);
    if (hit && now() < hit.expiresAt) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.lines;
    }
    if (hit) cache.delete(key);
    if (inFlight.has(key)) return inFlight.get(key);

    const promise = (async () => {
      try {
        const data = await fetchRange(storeId, start, end);
        if (!data?.meta?.complete || !Array.isArray(data.lines)) {
          throw new Error('Incomplete sales data from server');
        }
        write(key, data.lines);
        return data.lines;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, promise);
    return promise;
  }

  return {
    get,
    clearBusinessData() { cache.clear(); inFlight.clear(); },
    sizes() { return { cache: cache.size, inFlight: inFlight.size }; },
  };
}

function ok(lines = []) {
  return { lines, meta: { complete: true } };
}

describe('frontend bounded sales caching', () => {
  test('Today → This Week → Today reuses the exact prior range', async () => {
    let calls = 0;
    const client = createFrontendSalesClient({
      fetchRange: async (_store, start) => { calls++; return ok([{ date: start }]); },
    });
    await client.get('norrebro', '2026-09-23', '2026-09-24');
    await client.get('norrebro', '2026-09-21', '2026-09-24');
    const todayAgain = await client.get('norrebro', '2026-09-23', '2026-09-24');
    assert.equal(calls, 2);
    assert.equal(todayAgain[0].date, '2026-09-23');
  });

  test('switching stores and returning reuses the first store cache', async () => {
    let calls = 0;
    const client = createFrontendSalesClient({ fetchRange: async () => { calls++; return ok(); } });
    await client.get('norrebro', '2026-09-23', '2026-09-24');
    await client.get('vesterbro', '2026-09-23', '2026-09-24');
    await client.get('norrebro', '2026-09-23', '2026-09-24');
    assert.equal(calls, 2);
  });

  test('simultaneous identical browser requests are coalesced', async () => {
    let calls = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const client = createFrontendSalesClient({
      fetchRange: async () => { calls++; await gate; return ok(); },
    });
    const a = client.get('norrebro', '2026-09-23', '2026-09-24');
    const b = client.get('norrebro', '2026-09-23', '2026-09-24');
    assert.equal(calls, 1);
    release();
    await Promise.all([a, b]);
  });

  test('failed or incomplete results are not cached as zero', async () => {
    let calls = 0;
    const client = createFrontendSalesClient({
      fetchRange: async () => {
        calls++;
        if (calls === 1) throw new Error('upstream failure');
        if (calls === 2) return { lines: [], meta: { complete: false } };
        return ok([{ priceexclvat: 42 }]);
      },
    });
    await assert.rejects(client.get('norrebro', '2026-09-23', '2026-09-24'));
    await assert.rejects(client.get('norrebro', '2026-09-23', '2026-09-24'));
    const lines = await client.get('norrebro', '2026-09-23', '2026-09-24');
    assert.equal(lines[0].priceexclvat, 42);
    assert.equal(calls, 3);
  });

  test('cache is LRU-bounded and logout/session expiry clears it', async () => {
    const client = createFrontendSalesClient({ maxEntries: 2, fetchRange: async () => ok() });
    await client.get('a', '2025-01-01', '2025-01-02');
    await client.get('b', '2025-01-01', '2025-01-02');
    await client.get('c', '2025-01-01', '2025-01-02');
    assert.equal(client.sizes().cache, 2);
    client.clearBusinessData();
    assert.deepEqual(client.sizes(), { cache: 0, inFlight: 0 });
  });

  test('production period switching preserves cache and session expiry clears business caches', () => {
    const setPeriod = html.slice(html.indexOf('function setPeriod('), html.indexOf('function updateNav('));
    const expired = html.slice(html.indexOf('function onSessionExpired('), html.indexOf('// ── Auth ──'));
    assert.doesNotMatch(setPeriod, /state\.cache\s*=|_salesCache\.clear|_salesInFlight\.clear/);
    assert.match(expired, /state\.cache\s*=\s*\{\}/);
    assert.match(expired, /_salesCache\.clear\(\)/);
    assert.match(expired, /_salesInFlight\.clear\(\)/);
    assert.match(expired, /state\.lemonadeToday\s*=\s*null/);
    assert.match(expired, /state\.meat\s*=\s*\[\]/);
    assert.match(html, /if \(!res\) throw new Error\('Session unavailable'\)/);
    assert.match(html, /if \(_salesInFlight\.get\(key\) === promise\) _salesInFlight\.delete\(key\)/);
  });
});
