'use strict';

/**
 * Tests for GET /api/sales-range/:storeId/:start/:end
 *
 * The axios module is replaced in require.cache before server.js loads so that
 * every OnlinePOS GET is intercepted.  A mutable `mockConfig` object controls
 * what the mock returns for each test, allowing multi-page, error and conflict
 * scenarios without any network contact.
 */

const { describe, test, before, after } = require('node:test');
const assert  = require('node:assert/strict');
const http    = require('node:http');
const crypto  = require('node:crypto');
const bcrypt  = require('bcryptjs');
const path    = require('node:path');

// ── Environment (must be set before server.js loads) ──────────────────────────

const TEST_PASSWORD      = 'sr-test-password';
const TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);
const TEST_USERNAME      = 'sr-testuser';

process.env.NODE_ENV          = 'test';
process.env.KK_USERNAME       = TEST_USERNAME;
process.env.KK_PASSWORD_HASH  = TEST_PASSWORD_HASH;
process.env.KK_SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.PLANDAY_APP_ID             = 'sr-planday-appid';
process.env.PLANDAY_REFRESH_TOKEN      = 'sr-planday-rt';
process.env.ONLINEPOS_TOKEN_INDRE_BY        = 'sr-tok-indre-by';
process.env.ONLINEPOS_TOKEN_VESTERBRO       = 'sr-tok-vesterbro';
process.env.ONLINEPOS_TOKEN_CHRISTIANSHAVN  = 'sr-tok-christianshavn';
process.env.ONLINEPOS_TOKEN_FISKETORVET     = 'sr-tok-fisketorvet';
process.env.ONLINEPOS_TOKEN_FREDERIKSBERG   = 'sr-tok-frederiksberg';
process.env.ONLINEPOS_TOKEN_NORREBRO        = 'sr-tok-norrebro';

// ── Configurable axios mock ───────────────────────────────────────────────────
// mockConfig.pages: array of pre-built axios response objects served in order
//   for calls to api.onlinepos.dk.
// mockConfig.shouldThrow: if set, the mock throws this error instead.

const mockConfig = {
  pages:       [],
  pageIdx:     0,
  shouldThrow: null,
  calls:       0,
  delayMs:     0,
  active:      0,
  maxActive:   0,
};

function resetMock() {
  mockConfig.pages       = [];
  mockConfig.pageIdx     = 0;
  mockConfig.shouldThrow = null;
  mockConfig.calls       = 0;
  mockConfig.delayMs     = 0;
  mockConfig.active      = 0;
  mockConfig.maxActive   = 0;
  if (typeof app !== 'undefined') {
    app.locals.salesRangeCache.clear();
    app.locals.revenueSummaryCache.clear();
  }
}

/** Build a single-page OnlinePOS envelope axios response. */
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

/**
 * Build a minimal valid OnlinePOS line.
 * Includes sensitive fields that must never appear in the sanitised response.
 */
function mkLine(overrides = {}) {
  return {
    orderlineid:     'OL001',
    productid:       101,
    productname:     'Killer Kebab',
    productgroupid:  5,
    productgroup:    'Rolls',
    count:           1,
    price:           89,
    priceexclvat:    71.20,
    paymenttype:     'Dankort',
    paymenttypecode: 'DANKORT',
    timestamp_pay:   '2026-09-20 12:00:00',
    // Sensitive fields that the sanitiser must strip:
    cardnumber:      '1234****5678',
    clerk:           'Alice',
    firmaid:         13205,
    debtorname:      'John Doe',
    orderid:         99001,
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
      mockConfig.calls++;
      mockConfig.active++;
      mockConfig.maxActive = Math.max(mockConfig.maxActive, mockConfig.active);
      try {
        if (mockConfig.delayMs) {
          await new Promise(resolve => setTimeout(resolve, mockConfig.delayMs));
        }
        if (mockConfig.shouldThrow) throw mockConfig.shouldThrow;
        const page = mockConfig.pages[mockConfig.pageIdx];
        if (page !== undefined) mockConfig.pageIdx++;
        // Default: empty single page if no pages configured
        return page ?? mkPageResponse([]);
      } finally {
        mockConfig.active--;
      }
    }
    // All other GETs (Planday, etc.) return empty paginated response
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

// ── HTTP test helpers ─────────────────────────────────────────────────────────

let server;
let baseUrl;

before(() => new Promise(resolve => {
  server = app.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise(resolve => server.close(resolve)));

function makeCookieJar() {
  const store = {};
  return {
    absorb(arr) {
      for (const c of (arr || [])) {
        const [pair] = c.split(';');
        const [k, v] = pair.split('=');
        if (k && v !== undefined) store[k.trim()] = v.trim();
      }
    },
    header() {
      return Object.entries(store).map(([k, v]) => `${k}=${v}`).join('; ');
    },
  };
}

function request(opts) {
  return new Promise((resolve, reject) => {
    const { method = 'GET', path: urlPath, headers = {}, body, cookieJar } = opts;
    const cookies = cookieJar ? cookieJar.header() : '';
    const reqHeaders = { ...headers };
    if (cookies) reqHeaders['Cookie'] = cookies;

    const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
    if (bodyBuf) {
      reqHeaders['Content-Type']   = 'application/json';
      reqHeaders['Content-Length'] = bodyBuf.length;
    }

    const url = new URL(urlPath, baseUrl);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: reqHeaders },
      res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          if (cookieJar) cookieJar.absorb(res.headers['set-cookie'] || []);
          let json = null;
          try { json = JSON.parse(raw); } catch (_) {}
          resolve({ status: res.statusCode, body: raw, json });
        });
      }
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function doLogin() {
  const jar = makeCookieJar();
  const r = await request({
    method: 'POST', path: '/api/auth/login',
    body: { username: TEST_USERNAME, password: TEST_PASSWORD },
    cookieJar: jar,
  });
  return { jar, csrfToken: r.json?.csrfToken };
}

async function authGet(urlPath, jar) {
  return request({ path: urlPath, cookieJar: jar });
}

// ── 1. Authentication ─────────────────────────────────────────────────────────

describe('sales-range — authentication', () => {
  test('unauthenticated request returns 401', async () => {
    resetMock();
    const r = await request({ path: '/api/sales-range/vesterbro/2026-09-20/2026-09-21' });
    assert.equal(r.status, 401);
  });
});

// ── 2. Response shape and field allowlist ─────────────────────────────────────

describe('sales-range — response shape', () => {
  test('valid authenticated request returns 200 with lines and meta', async () => {
    resetMock();
    mockConfig.pages = [mkPageResponse([mkLine()])];

    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-20/2026-09-21', jar);

    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.lines),  'response.lines must be an array');
    assert.ok(r.json.meta && typeof r.json.meta === 'object', 'response.meta must be an object');
  });

  test('each line contains exactly the 12 allowlisted fields and nothing else', async () => {
    resetMock();
    mockConfig.pages = [mkPageResponse([mkLine()])];

    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-20/2026-09-21', jar);

    assert.equal(r.json.lines.length, 1);
    const line = r.json.lines[0];
    const got  = Object.keys(line).sort();
    const want = [
      'count', 'date', 'hour', 'paymenttype', 'paymenttypecode',
      'price', 'priceexclvat', 'productgroup', 'productgroupid',
      'productid', 'productname', 'secondOfDay',
    ].sort();
    assert.deepEqual(got, want, `Line keys mismatch: ${JSON.stringify(got)}`);
  });

  test('sensitive fields injected into upstream rows never reach the response', async () => {
    resetMock();
    mockConfig.pages = [mkPageResponse([
      mkLine({
        cardnumber:    '9999-8888-7777-6666',
        clerk:         'SensitiveEmployee',
        firmaid:       13205,
        debtorname:    'Sensitive Customer',
        orderid:       99999,
        orderlineid:   'SENSITIVE_OL',
        ordernumber:   'SENSITIVE_ORDER',
        accountnumber: 'ACCT123',
        account:       'Account Data',
        MasterID:      'MASTERID',
        pid:           'PID123',
        pnumber:       'PNUM456',
        chkno:         'CHK789',
        costprice:     55.00,
        discount:      10.00,
        vatrate:       25,
        ean_1:         'EAN001',
      }),
    ])];

    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-20/2026-09-21', jar);

    assert.equal(r.status, 200);
    const body = r.body;

    // None of the injected sensitive values must appear anywhere in the JSON body
    const forbidden = [
      '9999-8888-7777-6666', 'SensitiveEmployee', 'Sensitive Customer',
      'SENSITIVE_OL', 'SENSITIVE_ORDER', 'ACCT123', 'Account Data',
      'MASTERID', 'PID123', 'PNUM456', 'CHK789', 'EAN001',
    ];
    for (const val of forbidden) {
      assert.ok(!body.includes(val), `Sensitive value "${val}" leaked into response`);
    }

    // Field names must not appear either
    const forbiddenKeys = [
      'cardnumber', 'clerk', 'firmaid', 'debtorname', 'orderid',
      'orderlineid', 'ordernumber', 'accountnumber', 'account', 'MasterID',
      'pid', 'pnumber', 'chkno', 'costprice', 'discount', 'vatrate',
      'ean_1', 'timestamp_pay', 'datetime',
    ];
    for (const key of forbiddenKeys) {
      assert.ok(!body.includes(`"${key}"`), `Field name "${key}" leaked into response`);
    }
  });

  test('metadata contains all required keys and no raw conflict records', async () => {
    resetMock();
    mockConfig.pages = [mkPageResponse([])];

    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-20/2026-09-21', jar);

    assert.equal(r.status, 200);
    const meta = r.json.meta;

    // Required keys present
    const requiredKeys = [
      'complete', 'pages', 'rawLineCount', 'processedLineCount',
      'outOfRange', 'duplicatesRemoved', 'invalidCount', 'conflictCount',
      'start', 'end', 'storeId', 'cacheStatus', 'stale', 'cacheAgeMs',
    ];
    for (const key of requiredKeys) {
      assert.ok(key in meta, `meta missing required key: ${key}`);
    }

    // conflictCount is a number, not an array
    assert.equal(typeof meta.conflictCount, 'number');
    assert.equal(typeof meta.cacheAgeMs, 'number');
    assert.ok(meta.cacheAgeMs >= 0);

    // No 'conflicts' array exposed
    assert.ok(!('conflicts' in meta), 'meta must not expose raw conflicts array');
  });

  test('conflictCount reflects conflict count without exposing conflict data', async () => {
    resetMock();
    // Two lines with same orderlineid but different price → conflict
    mockConfig.pages = [mkPageResponse([
      mkLine({ orderlineid: 'SAME', price: 89,  priceexclvat: 71.2  }),
      mkLine({ orderlineid: 'SAME', price: 149, priceexclvat: 119.2 }),
    ])];

    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-20/2026-09-21', jar);

    assert.equal(r.status, 200);
    assert.equal(r.json.meta.conflictCount, 1, 'conflictCount should be 1');
    assert.ok(!('conflicts' in r.json.meta), 'raw conflicts must not be in meta');
    // Raw conflict data (orderlineids, prices) must not appear in the body
    assert.ok(!r.json.body?.includes('SAME'), 'orderlineid in conflict must not reach browser');
  });

  test('complete is false when processLines reports conflicts — not overridden', async () => {
    resetMock();
    mockConfig.pages = [mkPageResponse([
      mkLine({ orderlineid: 'CLASH', price: 89 }),
      mkLine({ orderlineid: 'CLASH', price: 200 }),
    ])];

    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-20/2026-09-21', jar);

    assert.equal(r.status, 200,   'incomplete result must still return 200, not 502');
    assert.equal(r.json.meta.complete, false, 'complete must be false when conflicts exist');
  });
});

describe('revenue-summary — compact LY response', () => {
  test('requires authentication', async () => {
    resetMock();
    const r = await request({
      path: '/api/revenue-summary/vesterbro/2026-09-20/2026-09-21?boundary=2026-09-20'
    });
    assert.equal(r.status, 401);
  });

  test('returns complete revenue, daily totals and only boundary seconds', async () => {
    resetMock();
    mockConfig.pages = [mkPageResponse([
      mkLine({ orderlineid: 'A', timestamp_pay: '2026-09-20 11:59:59', priceexclvat: 30000 }),
      mkLine({ orderlineid: 'B', timestamp_pay: '2026-09-20 12:00:00', priceexclvat: 5000 }),
      mkLine({ orderlineid: 'C', timestamp_pay: '2026-09-20 13:00:00', priceexclvat: 32254 }),
    ])];
    const { jar } = await doLogin();
    const r = await authGet(
      '/api/revenue-summary/vesterbro/2026-09-20/2026-09-21?boundary=2026-09-20', jar
    );

    assert.equal(r.status, 200);
    assert.equal(r.json.summary.completeRevenue, 67254);
    assert.deepEqual(r.json.summary.dailyRevenue, [{ date: '2026-09-20', revenue: 67254 }]);
    assert.deepEqual(r.json.summary.boundary.seconds, [
      [43199, 30000], [43200, 5000], [46800, 32254],
    ]);
    assert.equal(r.json.meta.complete, true);
  });

  test('does not expose raw timestamps, product, payment or sensitive fields', async () => {
    resetMock();
    mockConfig.pages = [mkPageResponse([mkLine({ orderlineid: 'SECRET-LINE' })])];
    const { jar } = await doLogin();
    const r = await authGet(
      '/api/revenue-summary/vesterbro/2026-09-20/2026-09-21?boundary=2026-09-20', jar
    );
    assert.equal(r.status, 200);
    for (const forbidden of [
      'timestamp_pay', 'datetime', 'productid', 'productname', 'paymenttype',
      'cardnumber', 'clerk', 'firmaid', 'debtorname', 'orderlineid', 'SECRET-LINE',
    ]) {
      assert.ok(!r.body.includes(forbidden), `${forbidden} leaked into compact response`);
    }
  });

  test('coalesces identical concurrent misses and serves repeats without exports', async () => {
    resetMock();
    mockConfig.delayMs = 30;
    mockConfig.pages = [mkPageResponse([mkLine()])];
    const { jar } = await doLogin();
    const path = '/api/revenue-summary/vesterbro/2026-09-20/2026-09-21?boundary=2026-09-20';
    const [a, b] = await Promise.all([authGet(path, jar), authGet(path, jar)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(mockConfig.calls, 1);
    const repeat = await authGet(path, jar);
    assert.equal(repeat.status, 200);
    assert.equal(mockConfig.calls, 1, 'cached recalculation makes no OnlinePOS request');
  });

  test('incomplete data is returned as incomplete and is never cached', async () => {
    resetMock();
    mockConfig.pages = [mkPageResponse([
      mkLine({ orderlineid: 'CLASH', priceexclvat: 10 }),
      mkLine({ orderlineid: 'CLASH', priceexclvat: 20 }),
    ])];
    const { jar } = await doLogin();
    const path = '/api/revenue-summary/vesterbro/2026-09-20/2026-09-21?boundary=2026-09-20';
    const first = await authGet(path, jar);
    assert.equal(first.status, 200);
    assert.equal(first.json.meta.complete, false);
    mockConfig.pages = [mkPageResponse([])];
    mockConfig.pageIdx = 0;
    const retry = await authGet(path, jar);
    assert.equal(retry.status, 200);
    assert.equal(mockConfig.calls, 2);
  });

  test('startup warms 18 Today/week/month summaries with bounded concurrency', async () => {
    resetMock();
    mockConfig.delayMs = 5;
    const result = await app.locals.warmLyRevenueSummaries({
      today: '2026-09-23', concurrency: 2,
    });
    assert.deepEqual(result, { warmed: 18, attempted: 18, concurrency: 2 });
    assert.equal(mockConfig.calls, 18, 'six stores × three ranges');
    assert.ok(mockConfig.maxActive <= 2, `observed concurrency ${mockConfig.maxActive}`);
    const stats = app.locals.revenueSummaryCache.stats();
    assert.equal(stats.entries, 18);
    assert.equal(stats.maxEntries, 120);
    assert.equal(stats.maxBytes, 32 * 1024 * 1024);
    assert.ok(stats.estimatedBytes < stats.maxBytes);

    await app.locals.warmLyRevenueSummaries({ today: '2026-09-23', concurrency: 2 });
    assert.equal(mockConfig.calls, 18, 'repeat warming uses cached summaries');
  });

  test('startup finishes current then existing LY before completed warming, without blocking readiness', async () => {
    resetMock();
    mockConfig.delayMs = 5;
    const sales = app.locals.salesRangeCache;
    const summaries = app.locals.revenueSummaryCache;
    const salesGet = sales.get;
    const summaryGet = summaries.get;
    const events = [];
    sales.get = async (args, options) => {
      const kind = options?.allowEviction === false ? 'completed' : 'current';
      events.push({ kind, event: 'start', args });
      const response = await salesGet(args, options);
      events.push({ kind, event: 'finish', args });
      return response;
    };
    summaries.get = async (args, options) => {
      const kind = options?.allowEviction === false ? 'completed' : 'ly';
      events.push({ kind, event: 'start', args });
      const response = await summaryGet(args, options);
      events.push({ kind, event: 'finish', args });
      return response;
    };
    try {
      let done = false;
      const warming = app.locals.warmStartupData().then(report => { done = true; return report; });
      const health = await fetch(baseUrl + '/api/health');
      assert.equal(health.status, 200);
      assert.equal(done, false, 'HTTP readiness does not await warming');
      const report = await warming;
      const firstLY = events.findIndex(e => e.kind === 'ly');
      const firstCompleted = events.findIndex(e => e.kind === 'completed');
      assert.equal(events.slice(0, firstLY).filter(e => e.kind === 'current' && e.event === 'finish').length, 12);
      assert.equal(events.slice(0, firstCompleted).filter(e => e.kind === 'ly' && e.event === 'finish').length, 18);
      assert.ok(mockConfig.maxActive <= 2);
      assert.equal(report.completed.outcomes.length, 36);
      assert.ok(report.completed.outcomes.every(o => o.retained));
      for (const event of events.filter(e => e.kind === 'current')) {
        assert.ok(sales.inspect(event.args), 'high-priority entry remains cached');
      }
      assert.equal(summaries.stats().refreshTimers, 0);
      const count = mockConfig.calls;
      await app.locals.warmStartupData();
      assert.equal(mockConfig.calls, count, 'repeat startup and visits reuse all entries');
    } finally {
      sales.get = salesGet;
      summaries.get = summaryGet;
      resetMock();
    }
  });
});

// ── 3. Value semantics preserved ──────────────────────────────────────────────

describe('sales-range — value semantics', () => {
  test('cached lines retain every public metric field without unused raw identity fields', async () => {
    resetMock();
    const raw = mkLine({ productid: 27242208, count: -2, price: -178, priceexclvat: -142.4 });
    mockConfig.pages = [mkPageResponse([raw])];
    const { jar } = await doLogin();
    const args = { storeId: 'norrebro', start: '2026-09-20', end: '2026-09-21' };
    const route = '/api/sales-range/norrebro/2026-09-20/2026-09-21';
    const initial = await authGet(route, jar);
    const repeated = await authGet(route, jar);
    assert.deepEqual(initial.json.lines, repeated.json.lines);
    const cached = app.locals.salesRangeCache.inspect(args).result.lines;
    const { computeMetrics } = require('../lib/product-metrics');
    assert.deepEqual(computeMetrics(cached), computeMetrics([raw]));
    assert.equal(computeMetrics(cached).komboUnits, -2);
    assert.deepEqual(Object.keys(cached[0]).sort(), [
      'productid', 'productname', 'productgroupid', 'productgroup', 'count', 'price',
      'priceexclvat', 'paymenttype', 'paymenttypecode', '_cphDate', 'timestamp_pay',
    ].sort());
    assert.equal(cached[0].count, -2);
    assert.equal(cached[0].priceexclvat, -142.4);
    assert.equal(mockConfig.calls, 1);
  });

  test('count=-1 (refund) remains negative in response', async () => {
    resetMock();
    mockConfig.pages = [mkPageResponse([
      mkLine({ orderlineid: 'REF1', count: -1, price: -89, priceexclvat: -71.2 }),
    ])];

    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-20/2026-09-21', jar);

    assert.equal(r.status, 200);
    assert.equal(r.json.lines.length, 1);
    const line = r.json.lines[0];
    assert.equal(line.count,       -1,    'count must remain -1');
    assert.equal(line.price,       -89,   'price must remain -89 (not flipped)');
    assert.equal(line.priceexclvat, -71.2, 'priceexclvat must remain -71.2');
  });

  test('date, hour, and secondOfDay preserve Copenhagen-local comparison time', async () => {
    resetMock();
    mockConfig.pages = [mkPageResponse([
      mkLine({ timestamp_pay: '2026-09-20 21:45:37', orderlineid: 'L1' }),
    ])];

    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-20/2026-09-21', jar);

    assert.equal(r.status, 200);
    assert.equal(r.json.lines.length, 1);
    const line = r.json.lines[0];
    assert.equal(line.date, '2026-09-20', 'date must be the CPH calendar date');
    assert.equal(line.hour, 21,           'hour must be 21 (read from CPH-local string)');
    assert.equal(typeof line.hour, 'number');
    assert.equal(line.secondOfDay, 21 * 3600 + 45 * 60 + 37);
  });

  test('invalidCount is reflected when upstream lines have no valid timestamp', async () => {
    resetMock();
    mockConfig.pages = [mkPageResponse([
      mkLine({ orderlineid: 'GOOD', timestamp_pay: '2026-09-20 10:00:00' }),
      // No timestamp — processLines will count this as invalid
      { orderlineid: 'BAD', productname: 'No timestamp line', count: 1, price: 10, priceexclvat: 8 },
    ])];

    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-20/2026-09-21', jar);

    assert.equal(r.status, 200);
    assert.equal(r.json.meta.invalidCount, 1, 'invalidCount must reflect the bad line');
    assert.equal(r.json.lines.length, 1,      'only the valid line should appear in lines');
  });
});

// ── 4. Input validation ───────────────────────────────────────────────────────

describe('sales-range — validation', () => {
  test('unknown storeId returns 404', async () => {
    resetMock();
    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/does-not-exist/2026-09-20/2026-09-21', jar);
    assert.equal(r.status, 404);
  });

  test('invalid start date format returns 400', async () => {
    resetMock();
    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/not-a-date/2026-09-21', jar);
    assert.equal(r.status, 400);
    assert.ok(r.json.error, 'error message expected');
  });

  test('invalid start date value (month 13) returns 400', async () => {
    resetMock();
    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-13-01/2026-13-02', jar);
    assert.equal(r.status, 400);
  });

  test('invalid end date format returns 400', async () => {
    resetMock();
    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-20/not-a-date', jar);
    assert.equal(r.status, 400);
  });

  test('start === end returns 400', async () => {
    resetMock();
    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-20/2026-09-20', jar);
    assert.equal(r.status, 400);
    assert.ok(r.json.error, 'error message expected');
  });

  test('start > end returns 400', async () => {
    resetMock();
    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-21/2026-09-20', jar);
    assert.equal(r.status, 400);
  });

  test('range exceeding MAX_RANGE_DAYS returns 400', async () => {
    resetMock();
    // 2020-01-01 → 2022-01-01 is 731 days — well above 366
    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2020-01-01/2022-01-01', jar);
    assert.equal(r.status, 400);
    assert.ok(r.json.error && r.json.error.includes('366'),
      `Expected "366" in error message, got: ${r.json.error}`);
  });

  test('valid single-day range (1 day span) returns 200', async () => {
    resetMock();
    mockConfig.pages = [mkPageResponse([mkLine()])];
    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-20/2026-09-21', jar);
    assert.equal(r.status, 200);
  });
});

// ── 5. Pagination ─────────────────────────────────────────────────────────────

describe('sales-range — pagination', () => {
  test('lines from all pages are combined in the response', async () => {
    resetMock();
    const page2Url = 'https://api.onlinepos.dk/api/exportSales/v20/1789855200?page=2';
    mockConfig.pages = [
      mkPageResponse(
        [mkLine({ orderlineid: 'P1L1' }), mkLine({ orderlineid: 'P1L2' })],
        page2Url,
        1
      ),
      mkPageResponse(
        [mkLine({ orderlineid: 'P2L1' })],
        null,
        2
      ),
    ];

    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-20/2026-09-21', jar);

    assert.equal(r.status, 200);
    assert.equal(r.json.meta.pages, 2, 'should have fetched 2 pages');
    assert.equal(r.json.lines.length, 3, 'all 3 in-range lines should be combined');
  });

  test('out-of-range lines from multi-page response are filtered out', async () => {
    resetMock();
    const page2Url = 'https://api.onlinepos.dk/api/exportSales/v20/1789855200?page=2';
    mockConfig.pages = [
      mkPageResponse(
        [mkLine({ orderlineid: 'IN', timestamp_pay: '2026-09-20 12:00:00' })],
        page2Url,
        1
      ),
      mkPageResponse(
        // This line is on 2026-09-21, which is outside [start, end) = [20, 21)
        [mkLine({ orderlineid: 'OUT', timestamp_pay: '2026-09-21 10:00:00' })],
        null,
        2
      ),
    ];

    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-20/2026-09-21', jar);

    assert.equal(r.status, 200);
    assert.equal(r.json.lines.length, 1, 'only the in-range line survives');
    assert.equal(r.json.meta.outOfRange, 1, 'outOfRange must be 1');
    assert.equal(r.json.meta.pages, 2);
  });
});

// ── 6. Error handling / fail-closed ──────────────────────────────────────────

describe('sales-range — error handling', () => {
  test('network error from upstream returns 502 not partial/empty data', async () => {
    resetMock();
    const netErr = new Error('connect ECONNREFUSED');
    mockConfig.shouldThrow = netErr;

    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-20/2026-09-21', jar);

    assert.equal(r.status, 502);
    assert.ok(r.json.error, 'error field expected in 502 response');
    // Must not return a lines array (even empty)
    assert.ok(!('lines' in r.json), '502 response must not contain a lines field');
  });

  test('upstream HTTP 401 error returns 502 not 401 or partial data', async () => {
    resetMock();
    const httpErr = new Error('Unauthorized');
    httpErr.response = { status: 401, data: 'Unauthorized' };
    mockConfig.shouldThrow = httpErr;

    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-20/2026-09-21', jar);

    assert.equal(r.status, 502);
    assert.ok(r.json.error, 'error field expected in 502 response');
  });

  test('502 error body does not contain store token or firmaid', async () => {
    resetMock();
    mockConfig.shouldThrow = new Error('mock upstream failure');

    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-20/2026-09-21', jar);

    assert.equal(r.status, 502);
    // The store token and firmaid must not appear in the error response
    assert.ok(!r.body.includes('sr-tok-vesterbro'), 'token must not appear in 502 body');
    assert.ok(!r.body.includes('13205'), 'firmaid must not appear in 502 body');
  });
});

// ── 7. storeId echoed safely in metadata ─────────────────────────────────────

describe('sales-range — metadata storeId', () => {
  test('meta.storeId echoes the requested store, start, end', async () => {
    resetMock();
    mockConfig.pages = [mkPageResponse([])];

    const { jar } = await doLogin();
    const r = await authGet('/api/sales-range/vesterbro/2026-09-20/2026-09-21', jar);

    assert.equal(r.status, 200);
    assert.equal(r.json.meta.storeId, 'vesterbro');
    assert.equal(r.json.meta.start,   '2026-09-20');
    assert.equal(r.json.meta.end,     '2026-09-21');
  });
});

// ── 8. Existing endpoints unaffected ─────────────────────────────────────────

describe('sales-range — existing endpoints unaffected', () => {
  test('GET /api/revenue/:storeId/:from/:to returns 404 (route removed)', async () => {
    resetMock();
    const r = await request({ path: '/api/revenue/vesterbro/1700000000/1700086400' });
    assert.equal(r.status, 404);
  });

  test('GET /api/sales/:storeId/:unixtime returns 404 (route removed)', async () => {
    resetMock();
    const r = await request({ path: '/api/sales/vesterbro/1700000000' });
    assert.equal(r.status, 404);
  });

  test('GET /api/all-revenue/:from/:to returns 404 (route removed)', async () => {
    resetMock();
    const r = await request({ path: '/api/all-revenue/1700000000/1700086400' });
    assert.equal(r.status, 404);
  });

  test('GET /api/lemonade/today still requires authentication', async () => {
    resetMock();
    const r = await request({ path: '/api/lemonade/today' });
    assert.equal(r.status, 401);
  });

  test('GET /api/health still returns 200 without auth', async () => {
    resetMock();
    const r = await request({ path: '/api/health' });
    assert.equal(r.status, 200);
  });
});
