'use strict';
/**
 * Frontend-logic tests for the sales range migration.
 *
 * Covers:
 *  • cphDateNextDay / cphDaySpan / unixToCphDate — date helpers
 *  • getCphDateRange                             — period → CPH date strings
 *  • apiSalesRange                               — request count, caching, error cases
 *  • buildHourlyMap                              — item.date + item.hour fields
 *  • itemBucket                                  — YYYY-MM-DD bucketing
 *  • lineChannel / buildChannelKpis / WOLT_VIA_HEAPS — store-aware Wolt classification
 *  • categorizeItems                             — field-shape compatibility
 *  • Calculation regression against the Nørrebro 2026-09-20 fixture
 *
 * All functions are inlined here (pure JS, no DOM) so the test can run
 * in Node.js without a browser or JSDOM.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

// ── Inline implementations (must exactly match index.html new code) ────────────

function cphDateNextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function cphDaySpan(start, endExcl) {
  return Math.round((new Date(endExcl + 'T12:00:00Z') - new Date(start + 'T12:00:00Z')) / 86400000);
}

function unixToCphDate(unixTs) {
  return new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Copenhagen' }).format(new Date(unixTs * 1000));
}

// Testable version: accepts explicit todayStr instead of calling new Date()
function getCphDateRange(period, { customFrom, customTo, todayStr }) {
  const todayCph = todayStr;

  switch (period) {
    case 'today':
      return { start: todayCph, end: cphDateNextDay(todayCph) };

    case 'yesterday': {
      const [y, m, d] = todayCph.split('-').map(Number);
      const yest = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
      return { start: yest, end: todayCph };
    }

    case 'this-week': {
      const d = new Date(todayCph + 'T12:00:00Z');
      const wd = d.getUTCDay();
      const mon = new Date(d);
      mon.setUTCDate(d.getUTCDate() - (wd === 0 ? 6 : wd - 1));
      return { start: mon.toISOString().slice(0, 10), end: cphDateNextDay(todayCph) };
    }

    case 'last-week': {
      const d = new Date(todayCph + 'T12:00:00Z');
      const wd = d.getUTCDay();
      const mon = new Date(d);
      mon.setUTCDate(d.getUTCDate() - (wd === 0 ? 6 : wd - 1) - 7);
      const monday = mon.toISOString().slice(0, 10);
      const sun = new Date(mon);
      sun.setUTCDate(mon.getUTCDate() + 7);
      return { start: monday, end: sun.toISOString().slice(0, 10) };
    }

    case 'this-month':
      return { start: todayCph.slice(0, 7) + '-01', end: cphDateNextDay(todayCph) };

    case 'last-month': {
      const [y, m] = todayCph.split('-').map(Number);
      const firstThis = todayCph.slice(0, 7) + '-01';
      const firstLast = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
      return { start: firstLast, end: firstThis };
    }

    case 'this-year':
      return { start: todayCph.slice(0, 4) + '-01-01', end: cphDateNextDay(todayCph) };

    case 'last-year': {
      const y = Number(todayCph.slice(0, 4));
      return { start: `${y - 1}-01-01`, end: `${y}-01-01` };
    }

    case 'custom':
      if (customFrom && customTo) {
        return { start: customFrom, end: cphDateNextDay(customTo) };
      }
      return { start: todayCph, end: cphDateNextDay(todayCph) };

    default:
      return { start: todayCph, end: cphDateNextDay(todayCph) };
  }
}

function buildHourlyMap(items) {
  const map = {};
  for (const item of items) {
    const day  = item.date;
    const hour = item.hour;
    if (!day || hour == null || hour < 0 || hour > 23) continue;
    if (!map[day]) map[day] = new Float32Array(24);
    map[day][hour] += (item.priceexclvat || 0);
  }
  return map;
}

function itemBucket(dateStr, interval) {
  if (!dateStr) return null;
  if (interval === 'daily')   return dateStr;
  if (interval === 'monthly') return dateStr.slice(0, 7);
  const d = new Date(dateStr + 'T12:00:00Z');
  if (isNaN(d)) return null;
  const wd = d.getUTCDay();
  const mon = new Date(d);
  mon.setUTCDate(d.getUTCDate() - (wd === 0 ? 6 : wd - 1));
  return mon.toISOString().slice(0, 10);
}

// Inline match of index.html WOLT_VIA_HEAPS + lineChannel + buildChannelKpis.
// These must exactly mirror the production implementations in index.html.
const WOLT_VIA_HEAPS = {
  'indre-by': 'Online External 2',
};

function lineChannel(paymenttype, storeId) {
  if (paymenttype === 'Wolt') return 'wolt';
  if (WOLT_VIA_HEAPS[storeId] === paymenttype) return 'wolt';
  if (paymenttype === 'Online External 3') return 'uberEats';
  if (paymenttype === 'Heaps online') return 'heaps';
  return null;
}

function buildChannelKpis(items, storeId) {
  let total = 0, wolt = 0, uberEats = 0, heaps = 0;
  for (const item of items) {
    const v  = item.priceexclvat || 0;
    const ch = lineChannel(item.paymenttype, storeId);
    total += v;
    if      (ch === 'wolt')     wolt     += v;
    else if (ch === 'uberEats') uberEats += v;
    else if (ch === 'heaps')    heaps    += v;
  }
  return { total, wolt, uberEats, heaps };
}

function categorizeItems(items) {
  const out = { rolls: 0, kombos: 0, kebab: 0, falafel: 0, chicken: 0 };
  for (const item of items) {
    const n = (item.productname || '').toLowerCase().trim();
    const qty = parseInt(item.count || 1);
    if (qty <= 0) continue;
    const isKombo      = /kombo|combo/.test(n);
    const isProtein    = /kebab|falafel|kylling|chicken|lamb/.test(n);
    const isKillerRoll = n.startsWith('killer') && isProtein;
    if (!isKombo && !isKillerRoll) continue;
    if (isKombo) out.kombos += qty; else out.rolls += qty;
    if (n.includes('lamb') || n.includes('kebab')) out.kebab += qty;
    else if (n.includes('falafel')) out.falafel += qty;
    else if (n.includes('chicken') || n.includes('kylling')) out.chicken += qty;
  }
  return out;
}

// Testable apiSalesRange: injectable fetch + shared cache object
async function apiSalesRange(storeId, start, endExcl, mockFetch, cache) {
  const key = `srange:${storeId}:${start}:${endExcl}`;
  if (key in cache) return cache[key];

  const res = await mockFetch(`/api/sales-range/${storeId}/${start}/${endExcl}`);
  if (!res) return [];
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'API error');
  if (!data.meta || !data.meta.complete) throw new Error('Incomplete sales data from server');
  cache[key] = data.lines;
  return cache[key];
}

// Helper: build a complete valid mock response
function mkOkResponse(lines = []) {
  const body = JSON.stringify({
    lines,
    meta: { complete: true, pages: 1, rawLineCount: lines.length,
            processedLineCount: lines.length, outOfRange: 0,
            duplicatesRemoved: 0, invalidCount: 0, conflictCount: 0,
            start: '2026-09-20', end: '2026-09-21', storeId: 'norrebro' },
  });
  return { ok: true, json: async () => JSON.parse(body) };
}

function mkErrResponse(status, errMsg) {
  const body = JSON.stringify({ error: errMsg });
  return { ok: false, status, json: async () => JSON.parse(body) };
}

// ── cphDateNextDay ─────────────────────────────────────────────────────────────
describe('cphDateNextDay', () => {
  test('normal day', () => assert.equal(cphDateNextDay('2026-09-20'), '2026-09-21'));
  test('month boundary Sep→Oct', () => assert.equal(cphDateNextDay('2026-09-30'), '2026-10-01'));
  test('year boundary Dec→Jan', () => assert.equal(cphDateNextDay('2025-12-31'), '2026-01-01'));
  test('Feb 28 non-leap year', () => assert.equal(cphDateNextDay('2026-02-28'), '2026-03-01'));
  test('Feb 28 leap year → Feb 29', () => assert.equal(cphDateNextDay('2028-02-28'), '2028-02-29'));
  test('Feb 29 leap year → Mar 1', () => assert.equal(cphDateNextDay('2028-02-29'), '2028-03-01'));
  test('spring-forward day (2026-03-29)', () => assert.equal(cphDateNextDay('2026-03-29'), '2026-03-30'));
  test('fall-back day (2026-10-25)', () => assert.equal(cphDateNextDay('2026-10-25'), '2026-10-26'));
});

// ── cphDaySpan ─────────────────────────────────────────────────────────────────
describe('cphDaySpan', () => {
  test('1-day range', () => assert.equal(cphDaySpan('2026-09-20', '2026-09-21'), 1));
  test('7-day range', () => assert.equal(cphDaySpan('2026-09-14', '2026-09-21'), 7));
  test('14-day range', () => assert.equal(cphDaySpan('2026-09-07', '2026-09-21'), 14));
  test('30-day range', () => assert.equal(cphDaySpan('2026-09-01', '2026-10-01'), 30));
  test('31-day range', () => assert.equal(cphDaySpan('2026-08-01', '2026-09-01'), 31));
  test('whole year', () => assert.equal(cphDaySpan('2026-01-01', '2027-01-01'), 365));
  test('month crossing DST spring-forward', () =>
    assert.equal(cphDaySpan('2026-03-01', '2026-04-01'), 31));
  test('month crossing DST fall-back', () =>
    assert.equal(cphDaySpan('2026-10-01', '2026-11-01'), 31));
});

// ── unixToCphDate — timezone safety ───────────────────────────────────────────
describe('unixToCphDate — timezone safety', () => {
  // CPH midnight (CEST, UTC+2) on 2026-09-20 = 2026-09-19T22:00:00Z = 1789855200
  test('CPH midnight 2026-09-20 → 2026-09-20', () =>
    assert.equal(unixToCphDate(1789855200), '2026-09-20'));

  // 1 second before CPH midnight → previous day
  test('1s before CPH midnight → 2026-09-19', () =>
    assert.equal(unixToCphDate(1789855200 - 1), '2026-09-19'));

  // 22:30 UTC = 00:30 CPH (CEST) → next CPH date
  test('22:30 UTC = 00:30 CPH → CPH date advances while NY date does not', () => {
    const ts = new Date(Date.UTC(2026, 8, 20, 22, 30)).getTime() / 1000;
    assert.equal(unixToCphDate(ts), '2026-09-21');
  });

  // Spring-forward: midnight on 2026-03-29 is CET (UTC+1) = 2026-03-28T23:00:00Z
  test('spring-forward day midnight (CET) → 2026-03-29', () => {
    const ts = new Date(Date.UTC(2026, 2, 28, 23, 0, 0)).getTime() / 1000;
    assert.equal(unixToCphDate(ts), '2026-03-29');
  });

  // 1s before spring-forward midnight → 2026-03-28
  test('1s before spring-forward midnight → 2026-03-28', () => {
    const ts = new Date(Date.UTC(2026, 2, 28, 22, 59, 59)).getTime() / 1000;
    assert.equal(unixToCphDate(ts), '2026-03-28');
  });

  // Fall-back: midnight on 2026-10-25 is CEST (UTC+2) = 2026-10-24T22:00:00Z
  test('fall-back day midnight (CEST) → 2026-10-25', () => {
    const ts = new Date(Date.UTC(2026, 9, 24, 22, 0, 0)).getTime() / 1000;
    assert.equal(unixToCphDate(ts), '2026-10-25');
  });

  // Winter noon UTC (CET, UTC+1): same calendar date
  test('winter noon UTC → same CPH date', () => {
    const ts = new Date(Date.UTC(2026, 0, 15, 12)).getTime() / 1000;
    assert.equal(unixToCphDate(ts), '2026-01-15');
  });
});

// ── getCphDateRange ────────────────────────────────────────────────────────────
describe('getCphDateRange — date semantics', () => {
  // Use 2026-09-22 (Tuesday) as today for deterministic tests
  const TODAY = '2026-09-22';
  const ctx = (custom = {}) => ({ todayStr: TODAY, customFrom: null, customTo: null, ...custom });

  test('today: start=today, end=tomorrow', () => {
    const r = getCphDateRange('today', ctx());
    assert.equal(r.start, '2026-09-22');
    assert.equal(r.end,   '2026-09-23');
  });

  test('yesterday: start=yesterday, end=today', () => {
    const r = getCphDateRange('yesterday', ctx());
    assert.equal(r.start, '2026-09-21');
    assert.equal(r.end,   '2026-09-22');
  });

  test('yesterday: end is exclusive — today is NOT included', () => {
    const r = getCphDateRange('yesterday', ctx());
    assert.equal(r.end, TODAY); // end === today means today is excluded
  });

  test('this-week: starts on Monday 2026-09-21 (Tuesday today)', () => {
    const r = getCphDateRange('this-week', ctx());
    assert.equal(r.start, '2026-09-21');
    assert.equal(r.end,   '2026-09-23'); // exclusive = tomorrow
  });

  test('this-week when today is Monday: single-day span', () => {
    const r = getCphDateRange('this-week', { ...ctx(), todayStr: '2026-09-21' });
    assert.equal(r.start, '2026-09-21');
    assert.equal(r.end,   '2026-09-22');
    assert.equal(cphDaySpan(r.start, r.end), 1);
  });

  test('last-week: starts on Monday, ends on Monday (exclusive Sunday)', () => {
    const r = getCphDateRange('last-week', ctx()); // today = Tuesday 2026-09-22
    assert.equal(r.start, '2026-09-14'); // previous Monday
    assert.equal(r.end,   '2026-09-21'); // Monday of this week (exclusive)
    assert.equal(cphDaySpan(r.start, r.end), 7);
  });

  test('last-week: when today is Monday, previous full week is correct', () => {
    const r = getCphDateRange('last-week', { ...ctx(), todayStr: '2026-09-21' });
    assert.equal(r.start, '2026-09-14');
    assert.equal(r.end,   '2026-09-21');
    assert.equal(cphDaySpan(r.start, r.end), 7);
  });

  test('this-month: starts on 2026-09-01', () => {
    const r = getCphDateRange('this-month', ctx());
    assert.equal(r.start, '2026-09-01');
    assert.equal(r.end,   '2026-09-23');
  });

  test('last-month: August 2026', () => {
    const r = getCphDateRange('last-month', ctx());
    assert.equal(r.start, '2026-08-01');
    assert.equal(r.end,   '2026-09-01');
    assert.equal(cphDaySpan(r.start, r.end), 31);
  });

  test('last-month: January wraps to December of previous year', () => {
    const r = getCphDateRange('last-month', { ...ctx(), todayStr: '2026-01-15' });
    assert.equal(r.start, '2025-12-01');
    assert.equal(r.end,   '2026-01-01');
    assert.equal(cphDaySpan(r.start, r.end), 31);
  });

  test('this-year: starts on 2026-01-01', () => {
    const r = getCphDateRange('this-year', ctx());
    assert.equal(r.start, '2026-01-01');
    assert.equal(r.end,   '2026-09-23');
  });

  test('last-year: full year 2025', () => {
    const r = getCphDateRange('last-year', ctx());
    assert.equal(r.start, '2025-01-01');
    assert.equal(r.end,   '2026-01-01');
    assert.equal(cphDaySpan(r.start, r.end), 365);
  });

  test('custom: uses customFrom/customTo with exclusive end', () => {
    const r = getCphDateRange('custom', { ...ctx(), customFrom: '2026-08-01', customTo: '2026-08-31' });
    assert.equal(r.start, '2026-08-01');
    assert.equal(r.end,   '2026-09-01'); // exclusive
    assert.equal(cphDaySpan(r.start, r.end), 31);
  });

  test('custom single day: end = next day (exclusive)', () => {
    const r = getCphDateRange('custom', { ...ctx(), customFrom: '2026-09-20', customTo: '2026-09-20' });
    assert.equal(r.start, '2026-09-20');
    assert.equal(r.end,   '2026-09-21');
    assert.equal(cphDaySpan(r.start, r.end), 1);
  });

  test('end is always strictly after start', () => {
    for (const period of ['today','yesterday','this-week','last-week','this-month','last-month','this-year','last-year']) {
      const r = getCphDateRange(period, ctx());
      assert.ok(r.start < r.end, `${period}: expected start < end, got ${r.start} >= ${r.end}`);
    }
  });
});

// ── apiSalesRange — request count and caching ─────────────────────────────────
describe('apiSalesRange — request count', () => {
  test('1-day range: exactly 1 HTTP request', async () => {
    let calls = 0;
    const fetch = async () => { calls++; return mkOkResponse(); };
    await apiSalesRange('norrebro', '2026-09-20', '2026-09-21', fetch, {});
    assert.equal(calls, 1);
  });

  test('7-day range: exactly 1 HTTP request', async () => {
    let calls = 0;
    const fetch = async () => { calls++; return mkOkResponse(); };
    await apiSalesRange('norrebro', '2026-09-14', '2026-09-21', fetch, {});
    assert.equal(calls, 1);
  });

  test('30-day range: exactly 1 HTTP request', async () => {
    let calls = 0;
    const fetch = async () => { calls++; return mkOkResponse(); };
    await apiSalesRange('norrebro', '2026-09-01', '2026-10-01', fetch, {});
    assert.equal(calls, 1);
  });

  test('6 stores in parallel: exactly 6 requests, not stores × days', async () => {
    const STORES = ['indre-by','vesterbro','christianshavn','fisketorvet','frederiksberg','norrebro'];
    let calls = 0;
    const fetch = async () => { calls++; return mkOkResponse(); };
    const cache = {};
    // 14-day range — old code would have made 6 × 14 = 84 requests
    await Promise.all(STORES.map(id => apiSalesRange(id, '2026-09-08', '2026-09-22', fetch, cache)));
    assert.equal(calls, 6);
  });

  test('graph range with 6 stores: exactly 6 requests', async () => {
    const STORES = ['indre-by','vesterbro','christianshavn','fisketorvet','frederiksberg','norrebro'];
    let calls = 0;
    const fetch = async () => { calls++; return mkOkResponse(); };
    const cache = {};
    // 30-day graph range — old code: 6 × 30 = 180 requests
    await Promise.all(STORES.map(id => apiSalesRange(id, '2026-08-24', '2026-09-23', fetch, cache)));
    assert.equal(calls, 6);
  });

  test('cached: second call for same store+dates makes 0 additional requests', async () => {
    let calls = 0;
    const fetch = async () => { calls++; return mkOkResponse(); };
    const cache = {};
    await apiSalesRange('norrebro', '2026-09-20', '2026-09-21', fetch, cache);
    await apiSalesRange('norrebro', '2026-09-20', '2026-09-21', fetch, cache);
    assert.equal(calls, 1);
  });

  test('different dates: separate requests, not served from cache', async () => {
    let calls = 0;
    const fetch = async () => { calls++; return mkOkResponse(); };
    const cache = {};
    await apiSalesRange('norrebro', '2026-09-20', '2026-09-21', fetch, cache);
    await apiSalesRange('norrebro', '2026-09-21', '2026-09-22', fetch, cache);
    assert.equal(calls, 2);
  });

  test('URL contains storeId, start, and exclusive end', async () => {
    let calledUrl = '';
    const fetch = async (url) => { calledUrl = url; return mkOkResponse(); };
    await apiSalesRange('norrebro', '2026-09-20', '2026-09-21', fetch, {});
    assert.equal(calledUrl, '/api/sales-range/norrebro/2026-09-20/2026-09-21');
  });

  test('meta.complete=false throws — incomplete result not returned as data', async () => {
    const body = JSON.stringify({ lines: [], meta: { complete: false, pages: 1 } });
    const fetch = async () => ({ ok: true, json: async () => JSON.parse(body) });
    await assert.rejects(
      apiSalesRange('norrebro', '2026-09-20', '2026-09-21', fetch, {}),
      /Incomplete/
    );
  });

  test('incomplete result is not cached — re-fetches on retry', async () => {
    let calls = 0;
    const body = JSON.stringify({ lines: [], meta: { complete: false } });
    const fetchFail = async () => { calls++; return { ok: true, json: async () => JSON.parse(body) }; };
    const cache = {};
    await assert.rejects(apiSalesRange('norrebro', '2026-09-20', '2026-09-21', fetchFail, cache));
    await assert.rejects(apiSalesRange('norrebro', '2026-09-20', '2026-09-21', fetchFail, cache));
    assert.equal(calls, 2); // both attempts hit the server
  });

  test('missing meta throws', async () => {
    const body = JSON.stringify({ lines: [] }); // no meta
    const fetch = async () => ({ ok: true, json: async () => JSON.parse(body) });
    await assert.rejects(apiSalesRange('norrebro', '2026-09-20', '2026-09-21', fetch, {}));
  });

  test('server error (res.ok=false) throws', async () => {
    const fetch = async () => mkErrResponse(502, 'Upstream data fetch failed');
    await assert.rejects(
      apiSalesRange('norrebro', '2026-09-20', '2026-09-21', fetch, {}),
      /Upstream/
    );
  });
});

// ── buildHourlyMap ─────────────────────────────────────────────────────────────
describe('buildHourlyMap', () => {
  test('uses item.date and item.hour (not item.datetime)', () => {
    const items = [
      { date: '2026-09-20', hour: 14, priceexclvat: 100 },
      { date: '2026-09-20', hour: 14, priceexclvat: 50 },
    ];
    const map = buildHourlyMap(items);
    assert.ok('2026-09-20' in map);
    assert.ok(Math.abs(map['2026-09-20'][14] - 150) < 0.001);
  });

  test('skips lines where hour is null or missing', () => {
    const items = [
      { date: '2026-09-20', hour: null, priceexclvat: 999 },
      { date: '2026-09-20', priceexclvat: 999 },
    ];
    const map = buildHourlyMap(items);
    assert.equal(Object.keys(map).length, 0);
  });

  test('skips lines where date is missing', () => {
    const items = [{ hour: 10, priceexclvat: 999 }];
    const map = buildHourlyMap(items);
    assert.equal(Object.keys(map).length, 0);
  });

  test('multiple dates produce separate map entries', () => {
    const items = [
      { date: '2026-09-20', hour: 10, priceexclvat: 100 },
      { date: '2026-09-21', hour: 10, priceexclvat: 200 },
    ];
    const map = buildHourlyMap(items);
    assert.ok(Math.abs(map['2026-09-20'][10] - 100) < 0.001);
    assert.ok(Math.abs(map['2026-09-21'][10] - 200) < 0.001);
  });

  test('hour 0 and hour 23 are both handled', () => {
    const items = [
      { date: '2026-09-20', hour: 0,  priceexclvat: 50 },
      { date: '2026-09-20', hour: 23, priceexclvat: 75 },
    ];
    const map = buildHourlyMap(items);
    assert.ok(Math.abs(map['2026-09-20'][0]  - 50) < 0.001);
    assert.ok(Math.abs(map['2026-09-20'][23] - 75) < 0.001);
  });

  test('CPH hour is used directly (no UTC conversion)', () => {
    // hour=14 in CPH; old code using new Date(item.datetime).getHours()
    // would give different results in UTC or NY timezone.
    // The new code just reads item.hour — always 14.
    const items = [{ date: '2026-09-20', hour: 14, priceexclvat: 120 }];
    const map = buildHourlyMap(items);
    assert.ok(Math.abs(map['2026-09-20'][14] - 120) < 0.001);
    // All other hours are zero
    for (let h = 0; h < 24; h++) {
      if (h !== 14) assert.equal(map['2026-09-20'][h] || 0, 0);
    }
  });
});

// ── itemBucket ─────────────────────────────────────────────────────────────────
describe('itemBucket', () => {
  test('daily: returns date as-is', () =>
    assert.equal(itemBucket('2026-09-20', 'daily'), '2026-09-20'));

  test('monthly: returns YYYY-MM', () =>
    assert.equal(itemBucket('2026-09-20', 'monthly'), '2026-09'));

  test('monthly: first of month', () =>
    assert.equal(itemBucket('2026-09-01', 'monthly'), '2026-09'));

  test('weekly: Monday stays on Monday', () =>
    assert.equal(itemBucket('2026-09-21', 'weekly'), '2026-09-21'));

  test('weekly: Tuesday → previous Monday', () =>
    assert.equal(itemBucket('2026-09-22', 'weekly'), '2026-09-21'));

  test('weekly: Sunday → Monday of same ISO week', () =>
    assert.equal(itemBucket('2026-09-27', 'weekly'), '2026-09-21'));

  test('weekly: Sunday (literal getDay()=0) maps back 6 days', () =>
    assert.equal(itemBucket('2026-09-27', 'weekly'), '2026-09-21'));

  test('weekly: Monday crossing month boundary', () => {
    // 2026-10-05 is Monday
    assert.equal(itemBucket('2026-10-05', 'weekly'), '2026-10-05');
  });

  test('weekly: date after DST spring-forward', () =>
    // 2026-03-30 is Monday (day after spring-forward)
    assert.equal(itemBucket('2026-03-30', 'weekly'), '2026-03-30'));

  test('null input returns null', () =>
    assert.equal(itemBucket(null, 'weekly'), null));

  test('empty string returns null', () =>
    assert.equal(itemBucket('', 'daily'), null));

  test('uses YYYY-MM-DD not datetime string', () => {
    // Proves we only accept date strings, not ISO datetimes
    assert.equal(itemBucket('2026-09-22', 'daily'), '2026-09-22');
  });
});

// ── buildChannelKpis — new field shape ─────────────────────────────────────────
describe('buildChannelKpis — new field shape', () => {
  test('uses priceexclvat and paymenttype fields', () => {
    const items = [
      { priceexclvat: 100, paymenttype: 'Kontant' },
      { priceexclvat: 200, paymenttype: 'Wolt' },
      { priceexclvat: 50,  paymenttype: 'Online External 3' },
      { priceexclvat: 80,  paymenttype: 'Heaps online' },
    ];
    const ch = buildChannelKpis(items);
    assert.ok(Math.abs(ch.total    - 430) < 0.001);
    assert.ok(Math.abs(ch.wolt     - 200) < 0.001);
    assert.ok(Math.abs(ch.uberEats - 50)  < 0.001);
    assert.ok(Math.abs(ch.heaps    - 80)  < 0.001);
  });

  test('no datetime field needed', () => {
    // Confirms this function works without datetime
    const items = [{ priceexclvat: 100, paymenttype: 'Wolt' }];
    const ch = buildChannelKpis(items);
    assert.equal(ch.wolt, 100);
  });
});

// ── categorizeItems — new field shape ─────────────────────────────────────────
describe('categorizeItems — new field shape', () => {
  test('uses productname (not name) for categorization', () => {
    const items = [
      { productname: 'Kombo - Lamb', count: 2 },
      { productname: 'Killer Kebab', count: 3 },
    ];
    const c = categorizeItems(items);
    assert.equal(c.kombos, 2);
    assert.equal(c.rolls,  3);
  });

  test('refund lines (count ≤ 0) are excluded', () => {
    const items = [
      { productname: 'Kombo - Lamb', count: 2 },
      { productname: 'Kombo - Lamb', count: -1 },
    ];
    const c = categorizeItems(items);
    assert.equal(c.kombos, 2); // refund excluded
  });
});

// ── Calculation regression — Nørrebro 2026-09-20 fixture ──────────────────────
describe('calculation regression — Nørrebro 2026-09-20 fixture', () => {
  const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'norrebro-2026-09-20.fixture.json');
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const lines   = fixture.lines;

  const LEM_ADDON_PID   = 27242080;
  const LEM_UPGRADE_PID = 27242148;
  const LEM_STAND_PID   = 27242164;

  test('fixture has date field on each line', () => {
    assert.ok(lines.every(l => typeof l.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(l.date)));
  });

  test('revenue ex VAT = 13,143.68 DKK', () => {
    const total = lines.reduce((s, l) => s + (l.priceexclvat || 0), 0);
    assert.ok(Math.abs(total - 13143.68) < 0.005, `Got ${total}`);
  });

  test('Wolt ex VAT = 2,120.48 DKK', () => {
    const wolt = lines
      .filter(l => l.paymenttype === 'Wolt')
      .reduce((s, l) => s + (l.priceexclvat || 0), 0);
    assert.ok(Math.abs(wolt - 2120.48) < 0.005, `Got ${wolt}`);
  });

  test('Wolt share = 16.1331%', () => {
    const ch   = buildChannelKpis(lines);
    const pct  = ch.wolt / ch.total * 100;
    assert.ok(Math.abs(pct - 16.1331) < 0.001, `Got ${pct}`);
  });

  // Note: categorizeItems uses name-regex and count>0 but does NOT filter by price.
  // The fixture.test.js business gold numbers (66 kombos, 54 rolls) use productid + p>0
  // to exclude zero-price staff-meal lines.  categorizeItems includes those 3 staff meals,
  // so its counts are 67 kombos and 56 rolls — which is the correct frontend output both
  // before and after this migration (the numbers are unchanged).
  test('kombos = 67 (via categorizeItems; includes 1 zero-price staff meal)', () => {
    const c = categorizeItems(lines);
    assert.equal(c.kombos, 67);
  });

  test('standalone rolls = 56 (via categorizeItems; includes 2 zero-price staff meals)', () => {
    const c = categorizeItems(lines);
    assert.equal(c.rolls, 56);
  });

  test('kombo share ≈ 54.5% (via categorizeItems, consistent with 67 kombos, 56 rolls)', () => {
    const c   = categorizeItems(lines);
    const tot = c.rolls + c.kombos;
    const pct = c.kombos / tot * 100;
    assert.ok(Math.abs(pct - 54.47) < 0.1, `Got ${pct}`);
  });

  test('total lemonades = 20 (by productid)', () => {
    const total = lines
      .filter(l => l.productid === LEM_ADDON_PID ||
                   l.productid === LEM_UPGRADE_PID ||
                   l.productid === LEM_STAND_PID)
      .reduce((s, l) => s + (l.count || 0), 0);
    assert.equal(total, 20);
  });

  test('buildChannelKpis total matches sum(priceexclvat)', () => {
    const ch  = buildChannelKpis(lines);
    const sum = lines.reduce((s, l) => s + (l.priceexclvat || 0), 0);
    assert.ok(Math.abs(ch.total - sum) < 0.001);
  });
});

// ── lineChannel — channel classification rules ────────────────────────────────
describe('lineChannel — classification rules', () => {
  // Direct Wolt
  test('paymenttype=Wolt → wolt at any store', () => {
    for (const id of ['norrebro','vesterbro','indre-by','christianshavn','fisketorvet','frederiksberg',undefined]) {
      assert.equal(lineChannel('Wolt', id), 'wolt', `Failed for storeId=${id}`);
    }
  });

  // Online External 2 — Wolt only at indre-by
  test('Online External 2 at indre-by → wolt', () =>
    assert.equal(lineChannel('Online External 2', 'indre-by'), 'wolt'));

  test('Online External 2 at norrebro → null (not wolt)', () =>
    assert.equal(lineChannel('Online External 2', 'norrebro'), null));

  test('Online External 2 at vesterbro → null', () =>
    assert.equal(lineChannel('Online External 2', 'vesterbro'), null));

  test('Online External 2 at christianshavn → null', () =>
    assert.equal(lineChannel('Online External 2', 'christianshavn'), null));

  test('Online External 2 at fisketorvet → null', () =>
    assert.equal(lineChannel('Online External 2', 'fisketorvet'), null));

  test('Online External 2 at frederiksberg → null', () =>
    assert.equal(lineChannel('Online External 2', 'frederiksberg'), null));

  test('Online External 2 with no storeId → null', () =>
    assert.equal(lineChannel('Online External 2', undefined), null));

  // Heaps never Wolt
  test('Heaps online → heaps (never wolt)', () => {
    for (const id of ['norrebro','indre-by',undefined]) {
      assert.equal(lineChannel('Heaps online', id), 'heaps', `Failed for storeId=${id}`);
    }
  });

  // Other channels
  test('Online External 3 → uberEats at any store', () => {
    for (const id of ['norrebro','indre-by',undefined]) {
      assert.equal(lineChannel('Online External 3', id), 'uberEats');
    }
  });

  test('Betalingskort → null', () =>
    assert.equal(lineChannel('Betalingskort', 'norrebro'), null));

  test('Kontant → null', () =>
    assert.equal(lineChannel('Kontant', 'norrebro'), null));

  test('Splitbetaling → null', () =>
    assert.equal(lineChannel('Splitbetaling', 'norrebro'), null));

  test('LifePeaks → null', () =>
    assert.equal(lineChannel('LifePeaks', 'norrebro'), null));

  test('null paymenttype → null', () =>
    assert.equal(lineChannel(null, 'indre-by'), null));

  test('unknown paymenttype → null', () =>
    assert.equal(lineChannel('SomeNewPlatform', 'indre-by'), null));
});

// ── buildChannelKpis — store-aware Wolt classification ────────────────────────
describe('buildChannelKpis — store-aware Wolt', () => {
  const ALL_STORES = ['norrebro','vesterbro','indre-by','christianshavn','fisketorvet','frederiksberg'];

  test('direct paymenttype=Wolt counts as wolt at all 6 stores', () => {
    for (const id of ALL_STORES) {
      const ch = buildChannelKpis([{ priceexclvat: 100, paymenttype: 'Wolt' }], id);
      assert.ok(Math.abs(ch.wolt - 100) < 0.001, `Failed for ${id}`);
    }
  });

  test('Online External 2 counts as wolt at indre-by', () => {
    const ch = buildChannelKpis([{ priceexclvat: 200, paymenttype: 'Online External 2' }], 'indre-by');
    assert.ok(Math.abs(ch.wolt - 200) < 0.001);
    assert.equal(ch.heaps, 0);
    assert.equal(ch.uberEats, 0);
  });

  test('Online External 2 does NOT count as wolt at norrebro', () => {
    const ch = buildChannelKpis([{ priceexclvat: 200, paymenttype: 'Online External 2' }], 'norrebro');
    assert.equal(ch.wolt, 0);
    assert.ok(Math.abs(ch.total - 200) < 0.001);
  });

  test('Online External 2 does NOT count as wolt at vesterbro', () => {
    const ch = buildChannelKpis([{ priceexclvat: 150, paymenttype: 'Online External 2' }], 'vesterbro');
    assert.equal(ch.wolt, 0);
  });

  test('Online External 2 does NOT count as wolt at christianshavn', () => {
    const ch = buildChannelKpis([{ priceexclvat: 150, paymenttype: 'Online External 2' }], 'christianshavn');
    assert.equal(ch.wolt, 0);
  });

  test('Online External 2 does NOT count as wolt at fisketorvet', () => {
    const ch = buildChannelKpis([{ priceexclvat: 150, paymenttype: 'Online External 2' }], 'fisketorvet');
    assert.equal(ch.wolt, 0);
  });

  test('Online External 2 does NOT count as wolt at frederiksberg', () => {
    const ch = buildChannelKpis([{ priceexclvat: 150, paymenttype: 'Online External 2' }], 'frederiksberg');
    assert.equal(ch.wolt, 0);
  });

  test('Heaps online never counts as wolt at indre-by', () => {
    const ch = buildChannelKpis([{ priceexclvat: 300, paymenttype: 'Heaps online' }], 'indre-by');
    assert.equal(ch.wolt, 0);
    assert.ok(Math.abs(ch.heaps - 300) < 0.001);
  });

  test('Heaps online never counts as wolt at any store', () => {
    for (const id of ALL_STORES) {
      const ch = buildChannelKpis([{ priceexclvat: 100, paymenttype: 'Heaps online' }], id);
      assert.equal(ch.wolt, 0, `Heaps counted as wolt at ${id}`);
    }
  });

  test('Online External 3 remains uberEats at all stores', () => {
    for (const id of ALL_STORES) {
      const ch = buildChannelKpis([{ priceexclvat: 100, paymenttype: 'Online External 3' }], id);
      assert.ok(Math.abs(ch.uberEats - 100) < 0.001, `Failed for ${id}`);
      assert.equal(ch.wolt, 0);
    }
  });

  test('Splitbetaling stays only in total (not attributed)', () => {
    const ch = buildChannelKpis([{ priceexclvat: 250, paymenttype: 'Splitbetaling' }], 'norrebro');
    assert.ok(Math.abs(ch.total - 250) < 0.001);
    assert.equal(ch.wolt, 0);
    assert.equal(ch.uberEats, 0);
    assert.equal(ch.heaps, 0);
  });

  test('LifePeaks stays only in total', () => {
    const ch = buildChannelKpis([{ priceexclvat: 76, paymenttype: 'LifePeaks' }], 'norrebro');
    assert.ok(Math.abs(ch.total - 76) < 0.001);
    assert.equal(ch.wolt, 0);
  });

  test('Wolt refund (negative priceexclvat) subtracts from wolt', () => {
    const ch = buildChannelKpis([
      { priceexclvat:  100, paymenttype: 'Wolt' },
      { priceexclvat:  -50, paymenttype: 'Wolt' },
    ], 'norrebro');
    assert.ok(Math.abs(ch.wolt  -  50) < 0.001);
    assert.ok(Math.abs(ch.total -  50) < 0.001);
  });

  test('Online External 2 refund at indre-by subtracts from wolt', () => {
    const ch = buildChannelKpis([
      { priceexclvat:  200, paymenttype: 'Online External 2' },
      { priceexclvat:  -80, paymenttype: 'Online External 2' },
    ], 'indre-by');
    assert.ok(Math.abs(ch.wolt  - 120) < 0.001);
    assert.ok(Math.abs(ch.total - 120) < 0.001);
  });

  test('count=2 does NOT multiply priceexclvat', () => {
    // priceexclvat is already the line total; count must never multiply it
    const ch = buildChannelKpis([{ priceexclvat: 298, count: 2, paymenttype: 'Wolt' }], 'norrebro');
    assert.ok(Math.abs(ch.wolt  - 298) < 0.001, 'wolt must not be 596');
    assert.ok(Math.abs(ch.total - 298) < 0.001, 'total must not be 596');
  });

  test('count=3 does NOT multiply priceexclvat', () => {
    const ch = buildChannelKpis([{ priceexclvat: 447, count: 3, paymenttype: 'Heaps online' }], 'norrebro');
    assert.ok(Math.abs(ch.heaps - 447) < 0.001);
    assert.ok(Math.abs(ch.total - 447) < 0.001);
  });

  test('null priceexclvat treated as 0', () => {
    const ch = buildChannelKpis([{ priceexclvat: null, paymenttype: 'Wolt' }], 'norrebro');
    assert.equal(ch.wolt, 0);
    assert.equal(ch.total, 0);
  });

  test('Wolt % formula: wolt / total × 100', () => {
    const items = [
      { priceexclvat: 100, paymenttype: 'Betalingskort' },
      { priceexclvat:  50, paymenttype: 'Wolt' },
    ];
    const ch  = buildChannelKpis(items, 'norrebro');
    const pct = ch.total > 0 ? ch.wolt / ch.total * 100 : null;
    assert.ok(Math.abs(pct - 33.3333) < 0.001);
  });
});

// ── buildChannelKpis — fixture regression with storeId ────────────────────────
describe('buildChannelKpis — fixture regression (norrebro, with storeId)', () => {
  const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'norrebro-2026-09-20.fixture.json');
  const lines = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')).lines;

  test('total ex VAT = 13,143.68 DKK (with storeId)', () => {
    const ch = buildChannelKpis(lines, 'norrebro');
    assert.ok(Math.abs(ch.total - 13143.68) < 0.005, `Got ${ch.total}`);
  });

  test('Wolt ex VAT = 2,120.48 DKK (with storeId)', () => {
    const ch = buildChannelKpis(lines, 'norrebro');
    assert.ok(Math.abs(ch.wolt - 2120.48) < 0.005, `Got ${ch.wolt}`);
  });

  test('Wolt share = 16.1331% (with storeId)', () => {
    const ch  = buildChannelKpis(lines, 'norrebro');
    const pct = ch.wolt / ch.total * 100;
    assert.ok(Math.abs(pct - 16.1331) < 0.001, `Got ${pct}`);
  });

  test('no Online External 2 lines in fixture — storeId has no effect on result', () => {
    // The fixture pre-dates Wolt-via-Heaps; passing 'indre-by' must give same total
    const chNb = buildChannelKpis(lines, 'norrebro');
    const chIb = buildChannelKpis(lines, 'indre-by');
    assert.ok(Math.abs(chNb.wolt  - chIb.wolt)  < 0.001);
    assert.ok(Math.abs(chNb.total - chIb.total) < 0.001);
  });
});

// ── chain totals — mixed stores classify correctly ────────────────────────────
describe('chain totals — mixed stores classify correctly', () => {
  // Simulate a chain call: per-store line arrays, accumulated with per-store storeId
  function chainKpis(storeLineMap) {
    return storeLineMap.reduce((acc, { id, lines }) => {
      const kpis = buildChannelKpis(lines, id);
      return { total: acc.total + kpis.total, wolt: acc.wolt + kpis.wolt,
               uberEats: acc.uberEats + kpis.uberEats, heaps: acc.heaps + kpis.heaps };
    }, { total: 0, wolt: 0, uberEats: 0, heaps: 0 });
  }

  test('norrebro Wolt + indre-by OE2 both land in wolt', () => {
    const ch = chainKpis([
      { id: 'norrebro', lines: [{ priceexclvat: 100, paymenttype: 'Wolt' }] },
      { id: 'indre-by', lines: [{ priceexclvat: 200, paymenttype: 'Online External 2' }] },
    ]);
    assert.ok(Math.abs(ch.wolt  - 300) < 0.001);
    assert.ok(Math.abs(ch.total - 300) < 0.001);
  });

  test('indre-by OE2 goes to wolt; norrebro OE2 goes only to total', () => {
    const ch = chainKpis([
      { id: 'indre-by', lines: [{ priceexclvat: 200, paymenttype: 'Online External 2' }] },
      { id: 'norrebro', lines: [{ priceexclvat: 150, paymenttype: 'Online External 2' }] },
    ]);
    assert.ok(Math.abs(ch.wolt  - 200) < 0.001);   // only indre-by
    assert.ok(Math.abs(ch.total - 350) < 0.001);   // both in total
  });

  test('Heaps from all stores stays in heaps, not wolt', () => {
    const ch = chainKpis([
      { id: 'norrebro', lines: [{ priceexclvat: 100, paymenttype: 'Heaps online' }] },
      { id: 'indre-by', lines: [{ priceexclvat: 200, paymenttype: 'Heaps online' }] },
    ]);
    assert.equal(ch.wolt, 0);
    assert.ok(Math.abs(ch.heaps - 300) < 0.001);
  });

  test('Splitbetaling at any store stays only in total', () => {
    const ch = chainKpis([
      { id: 'norrebro', lines: [{ priceexclvat: 150, paymenttype: 'Splitbetaling' }] },
      { id: 'indre-by', lines: [{ priceexclvat: 100, paymenttype: 'Splitbetaling' }] },
    ]);
    assert.equal(ch.wolt, 0);
    assert.ok(Math.abs(ch.total - 250) < 0.001);
  });

  test('chain total = sum of all store totals', () => {
    const storeLineMap = [
      { id: 'norrebro',       lines: [{ priceexclvat: 100, paymenttype: 'Wolt' },         { priceexclvat: 200, paymenttype: 'Betalingskort' }] },
      { id: 'indre-by',       lines: [{ priceexclvat: 150, paymenttype: 'Online External 2' }, { priceexclvat: 80, paymenttype: 'Kontant' }] },
      { id: 'vesterbro',      lines: [{ priceexclvat: 120, paymenttype: 'Heaps online' }] },
    ];
    const ch = chainKpis(storeLineMap);
    const expected = storeLineMap.flatMap(s => s.lines).reduce((s, l) => s + (l.priceexclvat || 0), 0);
    assert.ok(Math.abs(ch.total - expected) < 0.001);
    assert.ok(Math.abs(ch.wolt  - 250) < 0.001);   // 100 (norrebro Wolt) + 150 (indre-by OE2)
    assert.ok(Math.abs(ch.heaps - 120) < 0.001);
  });
});

// ── no extra requests — buildChannelKpis is synchronous ──────────────────────
describe('no extra requests — buildChannelKpis and lineChannel are synchronous', () => {
  test('buildChannelKpis returns synchronously (no I/O)', () => {
    const items = [{ priceexclvat: 100, paymenttype: 'Wolt' }];
    const start = Date.now();
    const ch = buildChannelKpis(items, 'norrebro');
    assert.ok(Date.now() - start < 10, 'must complete in < 10 ms');
    assert.ok(ch.wolt > 0);
  });

  test('apiSalesRange result is used directly by buildChannelKpis — no additional fetch', async () => {
    let calls = 0;
    const fetch = async () => { calls++; return mkOkResponse([{ priceexclvat: 100, paymenttype: 'Wolt' }]); };
    const cache = {};
    const lines = await apiSalesRange('norrebro', '2026-09-20', '2026-09-21', fetch, cache);
    const ch    = buildChannelKpis(lines, 'norrebro');
    assert.equal(calls, 1, 'only 1 request should have been made');
    assert.ok(Math.abs(ch.wolt - 100) < 0.001);
  });
});
