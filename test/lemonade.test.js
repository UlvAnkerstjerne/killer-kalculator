'use strict';
/**
 * Tests for the lemonade-today endpoint after migration to fetchSalesRange.
 *
 * Covers:
 *  • cphDateNextDay unit tests — normal days, boundaries, both DST transitions
 *  • GET /api/lemonade/today   — count semantics, refunds, dedup, next-day
 *    exclusion, incomplete fetch, failure handling, history-protection flag
 *  • GET /api/sales/:storeId/:unixtime — removed route returns 404
 */

const { describe, test, before, after, beforeEach } = require('node:test');
const assert  = require('node:assert/strict');
const http    = require('node:http');
const crypto  = require('node:crypto');
const bcrypt  = require('bcryptjs');

// ── Environment (before server.js loads) ──────────────────────────────────────

const TEST_USERNAME      = 'lem-testuser';
const TEST_PASSWORD      = 'lem-test-password';
const TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);

process.env.NODE_ENV          = 'test';
process.env.KK_USERNAME       = TEST_USERNAME;
process.env.KK_PASSWORD_HASH  = TEST_PASSWORD_HASH;
process.env.KK_SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.PLANDAY_APP_ID             = 'lem-planday-appid';
process.env.PLANDAY_REFRESH_TOKEN      = 'lem-planday-rt';
process.env.ONLINEPOS_TOKEN_INDRE_BY        = 'lem-tok-indre-by';
process.env.ONLINEPOS_TOKEN_VESTERBRO       = 'lem-tok-vesterbro';
process.env.ONLINEPOS_TOKEN_CHRISTIANSHAVN  = 'lem-tok-christianshavn';
process.env.ONLINEPOS_TOKEN_FISKETORVET     = 'lem-tok-fisketorvet';
process.env.ONLINEPOS_TOKEN_FREDERIKSBERG   = 'lem-tok-frederiksberg';
process.env.ONLINEPOS_TOKEN_NORREBRO        = 'lem-tok-norrebro';

// Token → store id map (mirrors STORES in server.js)
const TOKEN_TO_STORE = {
  'lem-tok-indre-by':       'indre-by',
  'lem-tok-vesterbro':      'vesterbro',
  'lem-tok-christianshavn': 'christianshavn',
  'lem-tok-fisketorvet':    'fisketorvet',
  'lem-tok-frederiksberg':  'frederiksberg',
  'lem-tok-norrebro':       'norrebro',
};

// ── Configurable axios mock ───────────────────────────────────────────────────
// mockHandlers: token → async function returning an axios response object,
//               or a function that throws.
// If no handler is registered for a token the mock returns an empty single-page
// success response.

const mockHandlers = {}; // token → () => Promise<response>

function resetMock() {
  for (const k of Object.keys(mockHandlers)) delete mockHandlers[k];
}

// Today in Copenhagen (used throughout tests)
const TODAY_CPH = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Copenhagen' }).format(new Date());

function mkPageResponse(lines, nextUrl = null, currentPage = 1) {
  return {
    status: 200,
    data: {
      current_page:  currentPage,
      next_page_url: nextUrl,
      data:          lines,
    },
  };
}

function mkLemLine(overrides = {}) {
  return {
    orderlineid:  'LEM001',
    productid:    27242164,
    productname:  'Killer Lemonade (35 kr)',
    productgroup: 'Drinks',
    count:        1,
    price:        35,
    priceexclvat: 28.0,
    paymenttype:  'Dankort',
    timestamp_pay: TODAY_CPH + ' 12:00:00',
    ...overrides,
  };
}

const axiosMock = {
  post: async (url) => {
    if (url && url.includes('planday.com/connect/token')) {
      return { status: 200, data: { access_token: 'mock-planday-access', expires_in: 3600 } };
    }
    return { status: 200, data: {} };
  },
  get: async (url, config) => {
    if (url && url.includes('api.onlinepos.dk')) {
      const token = config?.headers?.token;
      const handler = mockHandlers[token];
      if (handler) return handler();
      // Default: empty single-page success
      return mkPageResponse([]);
    }
    return { status: 200, data: { data: [], paging: { total: 0 } } };
  },
  create: () => axiosMock,
  defaults: { headers: { common: {} } },
};

const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true, exports: axiosMock,
};

// ── Load server ───────────────────────────────────────────────────────────────
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

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function makeCookieJar() {
  const store = {};
  return {
    set(raw) {
      for (const part of raw) {
        const [kv] = part.split(';');
        const [k, v] = kv.split('=');
        store[k.trim()] = v?.trim() ?? '';
      }
    },
    header() {
      return Object.entries(store).map(([k, v]) => `${k}=${v}`).join('; ');
    },
    get(k) { return store[k]; },
  };
}

async function request(method, path, { body, headers = {}, jar } = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        if (jar && res.headers['set-cookie']) jar.set(res.headers['set-cookie']);
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function login() {
  const jar = makeCookieJar();
  const r = await request('POST', '/api/auth/login', {
    body: { username: TEST_USERNAME, password: TEST_PASSWORD },
    jar,
  });
  const csrfToken = r.body.csrfToken;
  return { jar, csrfToken };
}

// ── cphDateNextDay — inline unit tests ────────────────────────────────────────
// (mirrors the function added to server.js)

function cphDateNextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

describe('cphDateNextDay — server-side helper', () => {
  test('normal day', () => assert.equal(cphDateNextDay('2026-09-20'), '2026-09-21'));
  test('end of month Sep → Oct', () => assert.equal(cphDateNextDay('2026-09-30'), '2026-10-01'));
  test('end of year Dec → Jan', () => assert.equal(cphDateNextDay('2025-12-31'), '2026-01-01'));
  test('Feb 28 non-leap year → Mar 1', () => assert.equal(cphDateNextDay('2026-02-28'), '2026-03-01'));
  test('Feb 28 leap year → Feb 29', () => assert.equal(cphDateNextDay('2028-02-28'), '2028-02-29'));
  test('Feb 29 leap year → Mar 1', () => assert.equal(cphDateNextDay('2028-02-29'), '2028-03-01'));

  // DST transitions — the next-day calculation must be calendar-day-based,
  // not 86400-seconds-based (which would fail on 23-hour and 25-hour days).
  test('spring-forward eve 2026-03-28 → 2026-03-29', () =>
    assert.equal(cphDateNextDay('2026-03-28'), '2026-03-29'));
  test('spring-forward day 2026-03-29 → 2026-03-30', () =>
    assert.equal(cphDateNextDay('2026-03-29'), '2026-03-30'));
  test('fall-back eve 2026-10-24 → 2026-10-25', () =>
    assert.equal(cphDateNextDay('2026-10-24'), '2026-10-25'));
  test('fall-back day 2026-10-25 → 2026-10-26', () =>
    assert.equal(cphDateNextDay('2026-10-25'), '2026-10-26'));
  test('day after fall-back 2026-10-26 → 2026-10-27', () =>
    assert.equal(cphDateNextDay('2026-10-26'), '2026-10-27'));
});

// ── GET /api/lemonade/today ────────────────────────────────────────────────────

describe('GET /api/lemonade/today — authentication', () => {
  test('unauthenticated request returns 401', async () => {
    const r = await request('GET', '/api/lemonade/today');
    assert.equal(r.status, 401);
  });
});

describe('GET /api/lemonade/today — response shape', () => {
  beforeEach(() => resetMock());

  test('returns date, stores, total, complete fields', async () => {
    const { jar } = await login();
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.ok(typeof r.body.date    === 'string', 'date missing');
    assert.ok(typeof r.body.stores  === 'object', 'stores missing');
    assert.ok(typeof r.body.total   === 'number', 'total missing');
    assert.ok(typeof r.body.complete === 'boolean', 'complete missing');
  });

  test('date field matches today in Copenhagen', async () => {
    const { jar } = await login();
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.date, TODAY_CPH);
  });

  test('returns complete:true when all stores succeed', async () => {
    const { jar } = await login();
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.complete, true);
  });
});

describe('GET /api/lemonade/today — lemonade counting', () => {
  beforeEach(() => resetMock());

  test('count=1 lemonade line adds 1 to store total', async () => {
    const { jar } = await login();
    mockHandlers['lem-tok-norrebro'] = () => mkPageResponse([
      mkLemLine({ orderlineid: 'L001', count: 1 }),
    ]);
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.stores['norrebro'], 1);
  });

  test('count=2 lemonade line adds 2 (not 1) — counts units not lines', async () => {
    const { jar } = await login();
    mockHandlers['lem-tok-norrebro'] = () => mkPageResponse([
      mkLemLine({ orderlineid: 'L001', count: 2 }),
    ]);
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.stores['norrebro'], 2);
  });

  test('two count=1 lemonade lines → store total 2', async () => {
    const { jar } = await login();
    mockHandlers['lem-tok-norrebro'] = () => mkPageResponse([
      mkLemLine({ orderlineid: 'L001', count: 1 }),
      mkLemLine({ orderlineid: 'L002', count: 1 }),
    ]);
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.stores['norrebro'], 2);
  });

  test('refund (count=-1) subtracts from total — not counted as +1', async () => {
    const { jar } = await login();
    mockHandlers['lem-tok-norrebro'] = () => mkPageResponse([
      mkLemLine({ orderlineid: 'L001', count:  2 }),
      mkLemLine({ orderlineid: 'L002', count: -1 }), // refund
    ]);
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.stores['norrebro'], 1); // 2 + (-1) = 1
  });

  test('refund of full quantity nets to zero', async () => {
    const { jar } = await login();
    mockHandlers['lem-tok-norrebro'] = () => mkPageResponse([
      mkLemLine({ orderlineid: 'L001', count:  1 }),
      mkLemLine({ orderlineid: 'L002', count: -1 }),
    ]);
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.stores['norrebro'], 0);
  });

  test('non-lemonade lines do not affect count', async () => {
    const { jar } = await login();
    mockHandlers['lem-tok-norrebro'] = () => mkPageResponse([
      mkLemLine({ orderlineid: 'L001', count: 1 }),
      { orderlineid: 'K001', productname: 'Killer Kebab',  count: 5,
        timestamp_pay: TODAY_CPH + ' 11:00:00' },
    ]);
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.stores['norrebro'], 1);
  });

  // ── Canonical product-ID classification tests ─────────────────────────────

  test('lemonade addon (pid 27242080) is counted', async () => {
    const { jar } = await login();
    mockHandlers['lem-tok-norrebro'] = () => mkPageResponse([
      mkLemLine({ orderlineid: 'A001', productid: 27242080, productname: '+ Lemonade', price: 10, count: 1, timestamp_pay: TODAY_CPH + ' 12:00:00' }),
    ]);
    const r = await request('GET', '/api/lemonade/today', { headers: { Cookie: jar.header() } });
    assert.equal(r.status, 200);
    assert.equal(r.body.stores['norrebro'], 1);
  });

  test('lemonade upgrade (pid 27242148) is counted', async () => {
    const { jar } = await login();
    mockHandlers['lem-tok-norrebro'] = () => mkPageResponse([
      mkLemLine({ orderlineid: 'U001', productid: 27242148, productname: '+ Killer Lemonade (+10 kr)', price: 10, count: 1, timestamp_pay: TODAY_CPH + ' 12:00:00' }),
    ]);
    const r = await request('GET', '/api/lemonade/today', { headers: { Cookie: jar.header() } });
    assert.equal(r.status, 200);
    assert.equal(r.body.stores['norrebro'], 1);
  });

  test('Lover (pid 29838736) does NOT count as lemonade', async () => {
    const { jar } = await login();
    mockHandlers['lem-tok-norrebro'] = () => mkPageResponse([
      mkLemLine({ orderlineid: 'LV01', productid: 29838736, productname: 'Lover', price: 35, count: 1, timestamp_pay: TODAY_CPH + ' 12:00:00' }),
    ]);
    const r = await request('GET', '/api/lemonade/today', { headers: { Cookie: jar.header() } });
    assert.equal(r.status, 200);
    assert.equal(r.body.stores['norrebro'], 0);
  });

  test('+ Lover addon (pid 29843293) does NOT count as lemonade', async () => {
    const { jar } = await login();
    mockHandlers['lem-tok-norrebro'] = () => mkPageResponse([
      mkLemLine({ orderlineid: 'LVA1', productid: 29843293, productname: '+ Lover (+10 kr)', price: 10, count: 1, timestamp_pay: TODAY_CPH + ' 12:00:00' }),
    ]);
    const r = await request('GET', '/api/lemonade/today', { headers: { Cookie: jar.header() } });
    assert.equal(r.status, 200);
    assert.equal(r.body.stores['norrebro'], 0);
  });

  test('product named "lemonade" with an unregistered ID is not counted', async () => {
    // Canonical classification is by ID only. A product with "lemonade" in its name
    // but an unknown ID must never count — even if the old fuzzy filter would have matched.
    const { jar } = await login();
    mockHandlers['lem-tok-norrebro'] = () => mkPageResponse([
      mkLemLine({ orderlineid: 'X001', productid: 99999999, productname: 'Special Lemonade', price: 30, count: 1, timestamp_pay: TODAY_CPH + ' 12:00:00' }),
    ]);
    const r = await request('GET', '/api/lemonade/today', { headers: { Cookie: jar.header() } });
    assert.equal(r.status, 200);
    assert.equal(r.body.stores['norrebro'], 0);
  });

  test('unknown 4 DKK Wolt line (pid 29569042) does not count as lemonade', async () => {
    const { jar } = await login();
    mockHandlers['lem-tok-norrebro'] = () => mkPageResponse([
      mkLemLine({ orderlineid: 'W001', productid: 29569042, productname: 'Unknown external product', price: 4, count: 1, timestamp_pay: TODAY_CPH + ' 12:00:00' }),
    ]);
    const r = await request('GET', '/api/lemonade/today', { headers: { Cookie: jar.header() } });
    assert.equal(r.status, 200);
    assert.equal(r.body.stores['norrebro'], 0);
  });

  test('total equals sum across all stores', async () => {
    const { jar } = await login();
    mockHandlers['lem-tok-norrebro']  = () => mkPageResponse([
      mkLemLine({ orderlineid: 'L001', count: 3 }),
    ]);
    mockHandlers['lem-tok-vesterbro'] = () => mkPageResponse([
      mkLemLine({ orderlineid: 'L002', count: 2 }),
    ]);
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.stores['norrebro'],  3);
    assert.equal(r.body.stores['vesterbro'], 2);
    assert.equal(r.body.total, 5);
  });
});

describe('GET /api/lemonade/today — date filtering', () => {
  beforeEach(() => resetMock());

  test('line with today CPH timestamp is counted', async () => {
    const { jar } = await login();
    mockHandlers['lem-tok-norrebro'] = () => mkPageResponse([
      mkLemLine({ orderlineid: 'L001', count: 1,
                  timestamp_pay: TODAY_CPH + ' 23:59:00' }),
    ]);
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.stores['norrebro'], 1);
  });

  test('line with next-day CPH timestamp is excluded', async () => {
    const { jar } = await login();
    const tomorrow = cphDateNextDay(TODAY_CPH);
    mockHandlers['lem-tok-norrebro'] = () => mkPageResponse([
      mkLemLine({ orderlineid: 'L001', count: 1,
                  timestamp_pay: TODAY_CPH  + ' 12:00:00' }),   // today — included
      mkLemLine({ orderlineid: 'L002', count: 1,
                  timestamp_pay: tomorrow   + ' 00:30:00' }),   // next day — excluded
    ]);
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.stores['norrebro'], 1); // only the today line
  });
});

describe('GET /api/lemonade/today — pagination and deduplication', () => {
  beforeEach(() => resetMock());

  test('lines across two pages are both counted', async () => {
    const { jar } = await login();
    const PAGE2_URL = 'https://api.onlinepos.dk/api/exportSales/v20/1234567?page=2';
    let pageIdx = 0;
    mockHandlers['lem-tok-norrebro'] = () => {
      pageIdx++;
      if (pageIdx === 1) return mkPageResponse(
        [ mkLemLine({ orderlineid: 'L001', count: 1 }) ], PAGE2_URL, 1
      );
      return mkPageResponse(
        [ mkLemLine({ orderlineid: 'L002', count: 1 }) ], null, 2
      );
    };
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.stores['norrebro'], 2);
  });

  test('duplicate line (same orderlineid) on two pages counted once', async () => {
    const { jar } = await login();
    const PAGE2_URL = 'https://api.onlinepos.dk/api/exportSales/v20/1234567?page=2';
    let pageIdx = 0;
    mockHandlers['lem-tok-norrebro'] = () => {
      pageIdx++;
      if (pageIdx === 1) return mkPageResponse(
        [ mkLemLine({ orderlineid: 'DUP001', count: 1 }) ], PAGE2_URL, 1
      );
      return mkPageResponse(
        [ mkLemLine({ orderlineid: 'DUP001', count: 1 }) ], null, 2  // exact dup
      );
    };
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.stores['norrebro'], 1); // deduped to 1
  });
});

describe('GET /api/lemonade/today — incomplete and failed fetches', () => {
  beforeEach(() => resetMock());

  test('incomplete result (meta.complete=false) returns complete:false', async () => {
    const { jar } = await login();
    // Conflict: same orderlineid, different data → processLines marks complete:false
    mockHandlers['lem-tok-norrebro'] = () => mkPageResponse([
      mkLemLine({ orderlineid: 'CONFLICT', count: 1, productname: 'Killer Lemonade (35 kr)' }),
      mkLemLine({ orderlineid: 'CONFLICT', count: 2, productname: 'Killer Lemonade (35 kr)' }),
    ]);
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.complete, false);
  });

  test('incomplete store is excluded from stores map (not counted as 0)', async () => {
    const { jar } = await login();
    mockHandlers['lem-tok-norrebro'] = () => mkPageResponse([
      mkLemLine({ orderlineid: 'C1', count: 1 }),
      mkLemLine({ orderlineid: 'C1', count: 2 }),  // conflict → incomplete
    ]);
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    // norrebro was incomplete — should be absent from stores, not 0
    assert.ok(!('norrebro' in r.body.stores),
      `norrebro should be absent from stores when incomplete, got ${JSON.stringify(r.body.stores)}`);
  });

  test('failed store (network error) sets complete:false', async () => {
    const { jar } = await login();
    const err = new Error('connect ECONNREFUSED');
    err.response = undefined;
    mockHandlers['lem-tok-norrebro'] = () => { throw err; };
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.complete, false);
  });

  test('failed store excluded from stores map (not counted as 0)', async () => {
    const { jar } = await login();
    mockHandlers['lem-tok-norrebro'] = () => { throw new Error('mock error'); };
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.ok(!('norrebro' in r.body.stores),
      'failed store must be absent, not zero');
  });

  test('other stores still counted when one fails', async () => {
    const { jar } = await login();
    mockHandlers['lem-tok-norrebro']  = () => { throw new Error('mock error'); };
    mockHandlers['lem-tok-vesterbro'] = () => mkPageResponse([
      mkLemLine({ orderlineid: 'L001', count: 3 }),
    ]);
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.complete, false);
    assert.equal(r.body.stores['vesterbro'], 3);
    assert.ok(!('norrebro' in r.body.stores));
  });

  test('history protection: complete:false signals caller to skip save', async () => {
    // The scheduled save in server.js guards on data.complete before writing.
    // This test verifies the flag is correctly propagated so the save can be skipped.
    const { jar } = await login();
    mockHandlers['lem-tok-norrebro'] = () => { throw new Error('mock error'); };
    const r = await request('GET', '/api/lemonade/today', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.complete, false,
      'complete:false tells the scheduled save to skip writing to history');
  });
});

// ── Removed route: GET /api/sales/:storeId/:unixtime ─────────────────────────

describe('GET /api/sales/:storeId/:unixtime — removed route returns 404', () => {
  test('unauthenticated request to old route returns 404 (not 401)', async () => {
    // The route is gone entirely — Express returns 404 before auth middleware.
    const r = await request('GET', '/api/sales/norrebro/1789855200');
    assert.equal(r.status, 404);
  });

  test('authenticated request to old route returns 404', async () => {
    const { jar } = await login();
    const r = await request('GET', '/api/sales/norrebro/1789855200', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 404);
  });

  test('authenticated request to old route with unknown store returns 404', async () => {
    const { jar } = await login();
    const r = await request('GET', '/api/sales/unknown-store/1789855200', {
      headers: { Cookie: jar.header() },
    });
    assert.equal(r.status, 404);
  });

  test('new sales-range route still works (not affected by removal)', async () => {
    resetMock();
    const { jar } = await login();
    const r = await request('GET', '/api/sales-range/norrebro/2026-09-20/2026-09-21', {
      headers: { Cookie: jar.header() },
    });
    // 200 (data from mock) not 404
    assert.equal(r.status, 200);
  });
});
