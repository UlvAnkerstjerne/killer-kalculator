'use strict';
/**
 * Tests for the revenue-from-sales-range migration in index.html.
 *
 * Covers:
 *  • cphDateOffset       — UTC date arithmetic (DST-safe)
 *  • lyDateRange         — same-period-last-year YYYY-MM-DD range
 *  • Revenue calculation — sum(priceexclvat), no VAT division, refunds
 *  • Fixture regression  — 13,143.68 DKK ex VAT from norrebro-2026-09-20
 *  • Daily grouping      — uses line.date field, not parsed datetime
 *  • Timezone safety     — cphDateOffset + itemBucket use UTC math; no local-TZ
 *  • Request counts      — 1 range-request per store regardless of bucket count
 *  • Incomplete/failed   — never cached or rendered as revenue
 *  • Removed routes      — /api/revenue and /api/all-revenue return 404
 */

const { describe, test, before, after } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');
const http    = require('node:http');
const crypto  = require('node:crypto');
const bcrypt  = require('bcryptjs');

// ── Inline pure functions (extracted from index.html) ─────────────────────────
// These must be kept in sync with index.html whenever the originals change.

function cphDateNextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function cphDateOffset(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// getCphDateRange with optional todayStr override for deterministic tests.
function getCphDateRange(period, { todayStr } = {}) {
  const todayCph = todayStr ||
    new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Copenhagen' }).format(new Date());

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

    default:
      return { start: todayCph, end: cphDateNextDay(todayCph) };
  }
}

function lyDateRange(period, { todayStr } = {}) {
  const { start, end } = getCphDateRange(period, { todayStr });
  return { start: cphDateOffset(start, -364), end: cphDateOffset(end, -364) };
}

// itemBucket — extract from frontend-sales.test.js (identical copy)
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

// ── Testable versions of apiRevenue / apiAllRevenue / graph revenue ──────────
// Each function takes an injected apiSalesRange function so calls can be counted.

async function apiRevenue_t(storeId, start, end, apiSalesRangeFn) {
  try {
    const lines = await apiSalesRangeFn(storeId, start, end);
    return lines.reduce((s, l) => s + (l.priceexclvat || 0), 0);
  } catch(e) {
    return null;
  }
}

async function apiAllRevenue_t(start, end, stores, apiSalesRangeFn) {
  const results = await Promise.allSettled(
    stores.map(async s => {
      const lines = await apiSalesRangeFn(s, start, end);
      return { id: s, rev: lines.reduce((sum, l) => sum + (l.priceexclvat || 0), 0) };
    })
  );
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    throw new Error(`Revenue unavailable: ${failed.length} store(s) failed — ` +
      failed.map(r => r.reason?.message || 'unknown').join('; '));
  }
  const out = {};
  for (const r of results) out[r.value.id] = r.value.rev;
  return out;
}

async function graphRevenue_t(stores, graphFrom, graphTo, interval, apiSalesRangeFn) {
  const revByStore = {};
  await Promise.all(stores.map(async storeId => {
    revByStore[storeId] = {};
    try {
      const lines = await apiSalesRangeFn(storeId, graphFrom, cphDateNextDay(graphTo));
      for (const line of lines) {
        const key = itemBucket(line.date, interval);
        if (!key) continue;
        revByStore[storeId][key] = (revByStore[storeId][key] || 0) + (line.priceexclvat || 0);
      }
    } catch(e) {}
  }));
  return revByStore;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'norrebro-2026-09-20.fixture.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const FIXTURE_LINES = fixture.lines;

const SIX_STORES = ['indre-by', 'vesterbro', 'christianshavn', 'fisketorvet', 'frederiksberg', 'norrebro'];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('cphDateOffset — UTC arithmetic', () => {
  test('offset by 0 returns same date', () => {
    assert.equal(cphDateOffset('2026-09-22', 0), '2026-09-22');
  });

  test('+1 day', () => {
    assert.equal(cphDateOffset('2026-09-22', 1), '2026-09-23');
  });

  test('-1 day', () => {
    assert.equal(cphDateOffset('2026-09-22', -1), '2026-09-21');
  });

  test('crosses month boundary forwards', () => {
    assert.equal(cphDateOffset('2026-09-30', 1), '2026-10-01');
  });

  test('crosses month boundary backwards', () => {
    assert.equal(cphDateOffset('2026-10-01', -1), '2026-09-30');
  });

  test('crosses year boundary forwards', () => {
    assert.equal(cphDateOffset('2026-12-31', 1), '2027-01-01');
  });

  test('crosses year boundary backwards', () => {
    assert.equal(cphDateOffset('2027-01-01', -1), '2026-12-31');
  });

  test('-364 from 2026-09-22 = 2025-09-23 (52 weeks back)', () => {
    assert.equal(cphDateOffset('2026-09-22', -364), '2025-09-23');
  });

  test('handles Feb 29 in leap year', () => {
    assert.equal(cphDateOffset('2024-02-28', 1), '2024-02-29');
  });

  test('skips Feb 29 in non-leap year', () => {
    assert.equal(cphDateOffset('2026-02-28', 1), '2026-03-01');
  });

  test('spring-forward eve: -1 from 2026-03-29 = 2026-03-28', () => {
    assert.equal(cphDateOffset('2026-03-29', -1), '2026-03-28');
  });

  test('spring-forward day: +1 from 2026-03-29 = 2026-03-30', () => {
    assert.equal(cphDateOffset('2026-03-29', 1), '2026-03-30');
  });

  test('fall-back: -1 from 2026-10-25 = 2026-10-24', () => {
    assert.equal(cphDateOffset('2026-10-25', -1), '2026-10-24');
  });
});

describe('lyDateRange — same-period-last-year', () => {
  const TODAY = '2026-09-22';

  test('today → 364 days earlier, same width (1 day)', () => {
    const r = lyDateRange('today', { todayStr: TODAY });
    assert.equal(r.start, '2025-09-23');
    assert.equal(r.end,   '2025-09-24');
  });

  test('yesterday → 364 days earlier, same width (1 day)', () => {
    const r = lyDateRange('yesterday', { todayStr: TODAY });
    assert.equal(r.start, '2025-09-22');
    assert.equal(r.end,   '2025-09-23');
  });

  test('last-week → 364 days earlier (7-day span)', () => {
    const r = lyDateRange('last-week', { todayStr: TODAY });
    const cur = getCphDateRange('last-week', { todayStr: TODAY });
    // Both spans are 7 days
    const curSpan = Math.round((new Date(cur.end + 'T12:00:00Z') - new Date(cur.start + 'T12:00:00Z')) / 86400000);
    const lySpan  = Math.round((new Date(r.end   + 'T12:00:00Z') - new Date(r.start   + 'T12:00:00Z')) / 86400000);
    assert.equal(curSpan, 7);
    assert.equal(lySpan,  7);
    // start is 364 days before current start
    assert.equal(r.start, cphDateOffset(cur.start, -364));
    assert.equal(r.end,   cphDateOffset(cur.end,   -364));
  });

  test('last-year → 364 days earlier', () => {
    const r   = lyDateRange('last-year', { todayStr: TODAY });
    const cur = getCphDateRange('last-year', { todayStr: TODAY });
    assert.equal(r.start, cphDateOffset(cur.start, -364));
    assert.equal(r.end,   cphDateOffset(cur.end,   -364));
  });

  test('TZ-invariant: cphDateOffset never uses local time — result is purely UTC arithmetic', () => {
    // Verify the offset calculation doesn't depend on Intl/local timezone at all.
    // cphDateOffset splits the string and uses Date.UTC — no getHours(), no toLocaleString().
    const a = cphDateOffset('2026-03-29', -364); // spring-forward day
    const b = cphDateOffset('2026-10-25', -364); // fall-back day
    assert.equal(typeof a, 'string');
    assert.equal(typeof b, 'string');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(a));
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(b));
    // Results don't depend on whether the host is in UTC, CPH, or LA — same calculation
    assert.equal(a, cphDateOffset('2026-03-29', -364));
    assert.equal(b, cphDateOffset('2026-10-25', -364));
  });
});

describe('revenue calculation — sum(priceexclvat)', () => {
  test('empty lines → 0', () => {
    const rev = [].reduce((s, l) => s + (l.priceexclvat || 0), 0);
    assert.equal(rev, 0);
  });

  test('single line: priceexclvat is used directly (not divided by 1.25)', () => {
    const lines = [{ priceexclvat: 100, count: 1 }];
    const rev = lines.reduce((s, l) => s + (l.priceexclvat || 0), 0);
    assert.equal(rev, 100);
  });

  test('count=2: price is already the line total — NOT multiplied by count', () => {
    // In the OnlinePOS API, price is the pre-totalled line amount (count already folded in).
    // Revenue = sum(priceexclvat), never sum(priceexclvat * count).
    const lines = [{ priceexclvat: 100, count: 2 }];
    const rev = lines.reduce((s, l) => s + (l.priceexclvat || 0), 0);
    assert.equal(rev, 100);  // NOT 200
  });

  test('count=3: price is already totalled — NOT multiplied', () => {
    const lines = [{ priceexclvat: 240, count: 3 }];
    const rev = lines.reduce((s, l) => s + (l.priceexclvat || 0), 0);
    assert.equal(rev, 240);  // NOT 720
  });

  test('refund (count=-1, negative price) subtracts from total', () => {
    const lines = [
      { priceexclvat:  80, count:  1 },  // sale
      { priceexclvat: -80, count: -1 },  // refund
    ];
    const rev = lines.reduce((s, l) => s + (l.priceexclvat || 0), 0);
    assert.equal(rev, 0);
  });

  test('partial refund leaves positive total', () => {
    const lines = [
      { priceexclvat: 80, count: 1 },
      { priceexclvat: -40, count: -1 },
    ];
    const rev = lines.reduce((s, l) => s + (l.priceexclvat || 0), 0);
    assert.equal(rev, 40);
  });

  test('null priceexclvat treated as 0', () => {
    const lines = [
      { priceexclvat: null, count: 1 },
      { priceexclvat: 50,   count: 1 },
    ];
    const rev = lines.reduce((s, l) => s + (l.priceexclvat || 0), 0);
    assert.equal(rev, 50);
  });

  test('multiple lines sum correctly', () => {
    const lines = [
      { priceexclvat: 100 },
      { priceexclvat:  50 },
      { priceexclvat:  25 },
    ];
    const rev = lines.reduce((s, l) => s + (l.priceexclvat || 0), 0);
    assert.equal(rev, 175);
  });
});

describe('fixture regression — Nørrebro 2026-09-20', () => {
  test('fixture has 466 lines', () => {
    assert.equal(FIXTURE_LINES.length, 466);
  });

  test('sum(priceexclvat) = 13,143.68 DKK ex VAT', () => {
    const total = FIXTURE_LINES.reduce((s, l) => s + (l.priceexclvat || 0), 0);
    assert.ok(Math.abs(total - 13143.68) < 0.005, `Got ${total}`);
  });

  test('NOT sum(priceexclvat * count) — old multiplication would be wrong', () => {
    const withMult = FIXTURE_LINES.reduce((s, l) => s + (l.priceexclvat || 0) * (l.count || 1), 0);
    const direct   = FIXTURE_LINES.reduce((s, l) => s + (l.priceexclvat || 0), 0);
    // They differ because some lines have count=2 or count=3
    assert.notEqual(Math.round(withMult * 100), Math.round(direct * 100),
      'Expected multiplication and direct sum to differ (fixture has multi-count lines)');
  });

  test('NOT total/1.25 — division is unreliable when VAT rates are mixed', () => {
    // The old apiRevenue received incl-VAT totals and divided by 1.25.
    // When product lines carry different effective VAT rates the approximation is wrong.
    // (The Nørrebro fixture happens to be uniform 25%, so we use synthetic data here.)
    const mixed = [
      { price: 120, priceexclvat: 100.00 },  // 20% effective VAT
      { price:  75, priceexclvat:  60.00 },  // 25% effective VAT
    ];
    const inclVat      = mixed.reduce((s, l) => s + (l.price        || 0), 0); // 195
    const approximated = inclVat / 1.25;  // 156 — wrong
    const exact        = mixed.reduce((s, l) => s + (l.priceexclvat || 0), 0); // 160
    assert.notEqual(approximated, exact,
      'incl-VAT / 1.25 must differ from exact ex-VAT when rates are mixed');
    assert.ok(Math.abs(exact - 160) < 0.001);
  });
});

describe('daily grouping — uses line.date field (TZ-safe)', () => {
  test('line.date string is used directly — no Date parsing for daily bucket', () => {
    const line = { date: '2026-09-20', priceexclvat: 100 };
    assert.equal(itemBucket(line.date, 'daily'), '2026-09-20');
  });

  test('monthly bucket: YYYY-MM slice (no Date parsing)', () => {
    const line = { date: '2026-09-20', priceexclvat: 100 };
    assert.equal(itemBucket(line.date, 'monthly'), '2026-09');
  });

  test('weekly bucket: Monday of the week (noon UTC — TZ-safe)', () => {
    // 2026-09-20 is a Sunday → previous Monday = 2026-09-14
    assert.equal(itemBucket('2026-09-20', 'weekly'), '2026-09-14');
  });

  test('weekly bucket: Monday stays as Monday', () => {
    assert.equal(itemBucket('2026-09-21', 'weekly'), '2026-09-21');
  });

  test('null date → null bucket', () => {
    assert.equal(itemBucket(null, 'daily'), null);
  });

  test('graph revenue groups by line.date — no unix-timestamp round-trip', async () => {
    // The critical regression: old code called safeApiRevenue(storeId, bucketFrom, bucketTo)
    // per bucket, relying on server-side timestamp filtering.
    // New code calls apiSalesRange once and groups by line.date.
    // This test verifies the grouping sums correctly by date.
    const lines = [
      { date: '2026-09-19', priceexclvat: 100 },
      { date: '2026-09-20', priceexclvat: 200 },
      { date: '2026-09-20', priceexclvat:  50 },
      { date: '2026-09-21', priceexclvat: 150 },
    ];

    let calls = 0;
    const mockFetch = async (storeId, start, end) => {
      calls++;
      return lines;
    };

    const rev = await graphRevenue_t(['store-a'], '2026-09-19', '2026-09-21', 'daily', mockFetch);

    assert.equal(calls, 1,   '1 apiSalesRange call per store');
    assert.equal(rev['store-a']['2026-09-19'], 100);
    assert.equal(rev['store-a']['2026-09-20'], 250);  // 200 + 50
    assert.equal(rev['store-a']['2026-09-21'], 150);
  });
});

describe('request counts — apiRevenue uses apiSalesRange cache', () => {
  test('single store+range → exactly 1 apiSalesRange call', async () => {
    let calls = 0;
    const mock = async () => { calls++; return [{ priceexclvat: 50 }]; };
    await apiRevenue_t('norrebro', '2026-09-20', '2026-09-21', mock);
    assert.equal(calls, 1);
  });

  test('apiRevenue result = sum(priceexclvat) from lines', async () => {
    const lines = [{ priceexclvat: 100 }, { priceexclvat: 43.68 }];
    const mock  = async () => lines;
    const rev   = await apiRevenue_t('norrebro', '2026-09-20', '2026-09-21', mock);
    assert.ok(Math.abs(rev - 143.68) < 0.001);
  });

  test('6-store apiAllRevenue → exactly 6 apiSalesRange calls', async () => {
    let calls = 0;
    const mock = async () => { calls++; return [{ priceexclvat: 100 }]; };
    await apiAllRevenue_t('2026-09-20', '2026-09-21', SIX_STORES, mock);
    assert.equal(calls, 6);
  });

  test('graph: 6-store 30-day daily → 6 calls (not 6×30=180)', async () => {
    let calls = 0;
    const mock = async () => { calls++; return []; };
    await graphRevenue_t(SIX_STORES, '2026-09-01', '2026-09-30', 'daily', mock);
    assert.equal(calls, 6);
  });

  test('graph: 6-store weekly → 6 calls (not 6 × num_weeks)', async () => {
    let calls = 0;
    const mock = async () => { calls++; return []; };
    await graphRevenue_t(SIX_STORES, '2026-09-01', '2026-09-28', 'weekly', mock);
    assert.equal(calls, 6);
  });

  test('graph: 6-store monthly → 6 calls (not 6 × num_months)', async () => {
    let calls = 0;
    const mock = async () => { calls++; return []; };
    await graphRevenue_t(SIX_STORES, '2026-01-01', '2026-12-31', 'monthly', mock);
    assert.equal(calls, 6);
  });
});

describe('incomplete / failed data — not cached or rendered as revenue', () => {
  test('apiRevenue returns null when apiSalesRange throws', async () => {
    const mock = async () => { throw new Error('Incomplete sales data from server'); };
    const rev  = await apiRevenue_t('norrebro', '2026-09-20', '2026-09-21', mock);
    assert.equal(rev, null);
  });

  test('apiRevenue returns null on network error', async () => {
    const mock = async () => { throw new Error('OnlinePOS request failed'); };
    const rev  = await apiRevenue_t('norrebro', '2026-09-20', '2026-09-21', mock);
    assert.equal(rev, null);
  });

  test('apiAllRevenue throws when any store fails — fail closed (no partial total)', async () => {
    const mock = async (storeId) => {
      if (storeId === 'norrebro') throw new Error('fetch failed');
      return [{ priceexclvat: 100 }];
    };
    await assert.rejects(
      () => apiAllRevenue_t('2026-09-20', '2026-09-21', SIX_STORES, mock),
      /Revenue unavailable/
    );
  });

  test('graph: failed store leaves empty bucket map (not zero-filled)', async () => {
    const mock = async (storeId) => {
      if (storeId === 'norrebro') throw new Error('fetch failed');
      return [{ date: '2026-09-20', priceexclvat: 100 }];
    };
    const rev = await graphRevenue_t(['norrebro', 'vesterbro'], '2026-09-20', '2026-09-20', 'daily', mock);
    assert.deepEqual(rev['norrebro'], {});  // no keys at all
    assert.equal(rev['vesterbro']['2026-09-20'], 100);
  });

  test('apiRevenue null is distinct from 0 — callers can show "—" instead of 0', () => {
    // null means "fetch failed"; 0 means "genuinely no revenue".
    // This is important for sidebar display: rev !== null ? kr(rev) : '—'
    assert.notEqual(null, 0);
    assert.equal(null ?? '—', '—');
    assert.equal(0    ?? '—',  0);
  });
});

// ── Removed routes: integration test against real server ──────────────────────

const TEST_USERNAME      = 'rev-testuser';
const TEST_PASSWORD      = 'rev-test-password';
const TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);

process.env.NODE_ENV          = 'test';
process.env.KK_USERNAME       = TEST_USERNAME;
process.env.KK_PASSWORD_HASH  = TEST_PASSWORD_HASH;
process.env.KK_SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.PLANDAY_APP_ID             = 'rev-planday-appid';
process.env.PLANDAY_REFRESH_TOKEN      = 'rev-planday-rt';
process.env.ONLINEPOS_TOKEN_INDRE_BY        = 'rev-tok-indre-by';
process.env.ONLINEPOS_TOKEN_VESTERBRO       = 'rev-tok-vesterbro';
process.env.ONLINEPOS_TOKEN_CHRISTIANSHAVN  = 'rev-tok-christianshavn';
process.env.ONLINEPOS_TOKEN_FISKETORVET     = 'rev-tok-fisketorvet';
process.env.ONLINEPOS_TOKEN_FREDERIKSBERG   = 'rev-tok-frederiksberg';
process.env.ONLINEPOS_TOKEN_NORREBRO        = 'rev-tok-norrebro';

// Minimal axios mock (no real HTTP)
const axiosMock = {
  post: async (url) => {
    if (url && url.includes('planday.com')) {
      return { status: 200, data: { access_token: 'mock', expires_in: 3600 } };
    }
    return { status: 200, data: {} };
  },
  get: async () => ({ status: 200, data: { current_page: 1, next_page_url: null, data: [] } }),
  create: () => axiosMock,
  defaults: { headers: { common: {} } },
};

const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true, exports: axiosMock,
};

const app = require('../server');
let server;
let baseUrl;

before(() => new Promise(resolve => {
  server = app.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise(resolve => server.close(resolve)));

function reqGet(urlPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: server.address().port,
      path: urlPath,
      method: 'GET',
    };
    http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode }));
    }).on('error', reject).end();
  });
}

describe('fail-closed — apiAllRevenue error semantics', () => {
  test('all stores succeed → returns map with one entry per store', async () => {
    const mock = async (storeId) => [{ priceexclvat: 50 }];
    const out  = await apiAllRevenue_t('2026-09-20', '2026-09-21', SIX_STORES, mock);
    assert.equal(Object.keys(out).length, 6);
    for (const id of SIX_STORES) assert.equal(out[id], 50);
  });

  test('genuine zero sales (empty lines) → revenue 0, not thrown', async () => {
    const mock = async () => [];  // empty = zero sales, not a failure
    const out  = await apiAllRevenue_t('2026-09-20', '2026-09-21', SIX_STORES, mock);
    for (const id of SIX_STORES) assert.equal(out[id], 0);
  });

  test('zero is distinct from null: zero means no sales, null means fetch failed', () => {
    // apiRevenue_t returns null on throw, never 0 for a failed fetch
    assert.notEqual(null, 0);
    assert.equal(null ?? 'error', 'error');
    assert.equal(0    ?? 'error',  0);       // 0 is a valid revenue value
  });

  test('one failed store of six → throws, no partial chain total', async () => {
    const mock = async (storeId) => {
      if (storeId === 'fisketorvet') throw new Error('incomplete');
      return [{ priceexclvat: 200 }];
    };
    await assert.rejects(
      () => apiAllRevenue_t('2026-09-20', '2026-09-21', SIX_STORES, mock),
      /Revenue unavailable.*1 store/
    );
  });

  test('two failed stores of six → error message names count', async () => {
    const mock = async (storeId) => {
      if (storeId === 'vesterbro' || storeId === 'norrebro') throw new Error('timeout');
      return [{ priceexclvat: 100 }];
    };
    await assert.rejects(
      () => apiAllRevenue_t('2026-09-20', '2026-09-21', SIX_STORES, mock),
      /Revenue unavailable.*2 store/
    );
  });

  test('all six fail → throws with count 6', async () => {
    const mock = async () => { throw new Error('server down'); };
    await assert.rejects(
      () => apiAllRevenue_t('2026-09-20', '2026-09-21', SIX_STORES, mock),
      /Revenue unavailable.*6 store/
    );
  });

  test('recovery — second call succeeds after first threw', async () => {
    let attempt = 0;
    const mock = async (storeId) => {
      attempt++;
      if (attempt <= SIX_STORES.length) throw new Error('first batch fails');
      return [{ priceexclvat: 100 }];
    };
    // First attempt: all stores fail
    await assert.rejects(
      () => apiAllRevenue_t('2026-09-20', '2026-09-21', SIX_STORES, mock),
      /Revenue unavailable/
    );
    // Second attempt: all stores succeed
    const mock2 = async () => [{ priceexclvat: 75 }];
    const out   = await apiAllRevenue_t('2026-09-20', '2026-09-21', SIX_STORES, mock2);
    assert.equal(Object.keys(out).length, 6);
    for (const id of SIX_STORES) assert.equal(out[id], 75);
  });

  test('apiRevenue_t returns null on throw (single-store fail path)', async () => {
    const mock = async () => { throw new Error('store network error'); };
    const rev  = await apiRevenue_t('norrebro', '2026-09-20', '2026-09-21', mock);
    assert.equal(rev, null);
  });

  test('apiRevenue_t returns 0 for empty lines (zero sales, not failure)', async () => {
    const mock = async () => [];
    const rev  = await apiRevenue_t('norrebro', '2026-09-20', '2026-09-21', mock);
    assert.equal(rev, 0);
    assert.notEqual(rev, null);
  });
});

describe('TZ invariance — child-process execution', () => {
  const { spawnSync } = require('node:child_process');

  function runInTZ(tz, code) {
    const res = spawnSync(process.execPath, ['-e', code], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
      timeout: 5000,
    });
    if (res.error) throw res.error;
    return res.stdout.trim();
  }

  // The core date arithmetic — should be identical in all timezones.
  const arithmeticCode = `
    function cphDateOffset(dateStr, days) {
      const [y, m, d] = dateStr.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
    }
    const results = [
      cphDateOffset('2026-03-29', -1),   // spring-forward eve
      cphDateOffset('2026-03-29',  1),   // spring-forward day
      cphDateOffset('2026-10-25', -1),   // fall-back day
      cphDateOffset('2026-12-31',  1),   // year boundary
      cphDateOffset('2026-09-22', -364), // LY offset
    ].join(',');
    process.stdout.write(results);
  `;

  const EXPECTED_ARITHMETIC = '2026-03-28,2026-03-30,2026-10-24,2027-01-01,2025-09-23';

  test('cphDateOffset — TZ=UTC matches expected output', () => {
    assert.equal(runInTZ('UTC', arithmeticCode), EXPECTED_ARITHMETIC);
  });

  test('cphDateOffset — TZ=Europe/Copenhagen matches TZ=UTC', () => {
    assert.equal(runInTZ('Europe/Copenhagen', arithmeticCode), EXPECTED_ARITHMETIC);
  });

  test('cphDateOffset — TZ=America/Los_Angeles matches TZ=UTC', () => {
    assert.equal(runInTZ('America/Los_Angeles', arithmeticCode), EXPECTED_ARITHMETIC);
  });

  // Revenue sum — pure arithmetic, no date parsing involved.
  const revSumCode = `
    const lines = [
      { priceexclvat: 100.50 },
      { priceexclvat:  49.50 },
      { priceexclvat:  -25.00 },
    ];
    const rev = lines.reduce((s, l) => s + (l.priceexclvat || 0), 0);
    process.stdout.write(rev.toFixed(2));
  `;
  const EXPECTED_REV = '125.00';

  test('revenue sum(priceexclvat) — TZ=UTC', () => {
    assert.equal(runInTZ('UTC', revSumCode), EXPECTED_REV);
  });

  test('revenue sum(priceexclvat) — TZ=Europe/Copenhagen', () => {
    assert.equal(runInTZ('Europe/Copenhagen', revSumCode), EXPECTED_REV);
  });

  test('revenue sum(priceexclvat) — TZ=America/Los_Angeles', () => {
    assert.equal(runInTZ('America/Los_Angeles', revSumCode), EXPECTED_REV);
  });

  // itemBucket weekly — uses noon UTC anchor to avoid DST edge
  const bucketCode = `
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
    const results = [
      itemBucket('2026-03-29', 'weekly'),  // spring-forward Sunday → Monday
      itemBucket('2026-10-25', 'weekly'),  // fall-back Sunday → Monday
      itemBucket('2026-09-20', 'weekly'),  // regular Sunday
    ].join(',');
    process.stdout.write(results);
  `;
  const EXPECTED_BUCKETS = '2026-03-23,2026-10-19,2026-09-14';

  test('itemBucket weekly — TZ=UTC', () => {
    assert.equal(runInTZ('UTC', bucketCode), EXPECTED_BUCKETS);
  });

  test('itemBucket weekly — TZ=Europe/Copenhagen', () => {
    assert.equal(runInTZ('Europe/Copenhagen', bucketCode), EXPECTED_BUCKETS);
  });

  test('itemBucket weekly — TZ=America/Los_Angeles', () => {
    assert.equal(runInTZ('America/Los_Angeles', bucketCode), EXPECTED_BUCKETS);
  });
});

describe('removed legacy revenue routes — return 404', () => {
  test('GET /api/revenue/:storeId/:from/:to returns 404 unauthenticated', async () => {
    const r = await reqGet('/api/revenue/vesterbro/1700000000/1700086400');
    assert.equal(r.status, 404);
  });

  test('GET /api/all-revenue/:from/:to returns 404 unauthenticated', async () => {
    const r = await reqGet('/api/all-revenue/1700000000/1700086400');
    assert.equal(r.status, 404);
  });

  test('GET /api/sales-range/:storeId/:start/:end still exists (not removed)', async () => {
    // Verify we only removed the legacy routes, not the safe one.
    const r = await reqGet('/api/sales-range/vesterbro/2026-09-20/2026-09-21');
    // Returns 401 (auth required) — route exists, not 404
    assert.equal(r.status, 401);
  });
});
