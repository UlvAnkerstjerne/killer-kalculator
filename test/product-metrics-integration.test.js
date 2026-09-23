'use strict';
/**
 * Integration tests for Stage 4 Job 2:
 * canonical product-metrics engine wired into the application.
 *
 * Covers:
 *  • Fixture application path  — computeMetrics on fixture lines produces reference values
 *  • /js/product-metrics.js    — route exists, returns JS, sets window.ProductMetrics
 *  • No fuzzy name matching    — grep-level proof no categorizeItems remains in app code
 *  • Source-exposure protection — repository files not reachable via the JS route path
 *  • Lover/Lover-addon         — do not count as lemonade or any other metric
 *  • Unknown external product  — 4 DKK Wolt line counts toward nothing
 *  • Staff meals               — zero-price kombos/rolls not counted
 *  • Refunds                   — subtract correctly
 *  • Request count             — computeMetrics needs no extra HTTP call (pure function)
 */

const { describe, test, before, after } = require('node:test');
const assert  = require('node:assert/strict');
const http    = require('node:http');
const path    = require('node:path');
const fs      = require('node:fs');
const crypto  = require('node:crypto');
const bcrypt  = require('bcryptjs');

const { computeMetrics, PRODUCT_IDS, LEM_IDS } = require('../lib/product-metrics');

// ── Fixture ───────────────────────────────────────────────────────────────────
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'norrebro-2026-09-20.fixture.json');
const fixtureLines = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')).lines;

// ── Pure module: application path via fixture lines ───────────────────────────

describe('application path — computeMetrics on fixture lines', () => {
  let m;
  test('setup: compute on 466 fixture lines', () => {
    m = computeMetrics(fixtureLines);
  });

  test('kombos = 66', () => {
    assert.equal(m.komboUnits, 66);
  });

  test('standalone paid rolls = 54', () => {
    assert.equal(m.rollUnits, 54);
  });

  test('kombo % = 55.0 (to 4 dp)', () => {
    assert.equal(Math.round(m.komboPct * 10000) / 10000, 55.0);
  });

  test('lemonade = 20', () => {
    assert.equal(m.lemUnits, 20);
  });
});

describe('Lover and Lover-addon — confirmed non-lemonade IDs', () => {
  test('Lover (29838736) is not in LEM_IDS', () => {
    assert.ok(!LEM_IDS.has(PRODUCT_IDS.OTHER_LOVER));
  });

  test('+ Lover (29843293) is not in LEM_IDS', () => {
    assert.ok(!LEM_IDS.has(PRODUCT_IDS.OTHER_LOVER_ADDON));
  });

  test('Lover line does not count toward any metric', () => {
    const m = computeMetrics([
      { productid: PRODUCT_IDS.OTHER_LOVER, count: 5, price: 35 },
    ]);
    assert.equal(m.komboUnits, 0);
    assert.equal(m.rollUnits,  0);
    assert.equal(m.lemUnits,   0);
    assert.equal(m.komboPct,   null);
  });

  test('+ Lover line does not count toward any metric', () => {
    const m = computeMetrics([
      { productid: PRODUCT_IDS.OTHER_LOVER_ADDON, count: 3, price: 10 },
    ]);
    assert.equal(m.komboUnits, 0);
    assert.equal(m.rollUnits,  0);
    assert.equal(m.lemUnits,   0);
  });
});

describe('unknown external product — 4 DKK Wolt line', () => {
  test('pid 29569042 counts toward nothing', () => {
    const m = computeMetrics([
      { productid: '29569042', count: 1, price: 4 },
    ]);
    assert.equal(m.komboUnits, 0);
    assert.equal(m.rollUnits,  0);
    assert.equal(m.lemUnits,   0);
  });
});

describe('staff meals do not inflate counts', () => {
  test('zero-price kombo is excluded', () => {
    const m = computeMetrics([
      { productid: PRODUCT_IDS.KOMBO_LAMB, count: 1, price: 0 },
    ]);
    assert.equal(m.komboUnits, 0);
  });

  test('zero-price roll is excluded', () => {
    const m = computeMetrics([
      { productid: PRODUCT_IDS.ROLL_KEBAB, count: 1, price: 0 },
    ]);
    assert.equal(m.rollUnits, 0);
  });

  test('fixture: 1 zero-price falafel staff-meal kombo not counted', () => {
    // TXN_077: Kombo - Falafel at price 0, Kredit — a staff meal.
    const staffMealLines = fixtureLines.filter(l =>
      String(l.productid) === PRODUCT_IDS.KOMBO_FALAFEL && l.price === 0
    );
    assert.equal(staffMealLines.length, 1);  // one staff meal in fixture
    const m = computeMetrics(staffMealLines);
    assert.equal(m.komboUnits, 0);   // must be excluded
  });

  test('fixture: 2 zero-price roll staff-meal lines not counted', () => {
    // TXN_080: Killer Kebab + Killer Falafel, both price 0, Kredit — staff meal.
    const staffMealRolls = fixtureLines.filter(l =>
      (String(l.productid) === PRODUCT_IDS.ROLL_KEBAB || String(l.productid) === PRODUCT_IDS.ROLL_FALAFEL)
      && l.price === 0
    );
    assert.equal(staffMealRolls.length, 2);  // two staff-meal roll lines
    const m = computeMetrics(staffMealRolls);
    assert.equal(m.rollUnits, 0);   // must be excluded
  });
});

describe('refunds subtract', () => {
  test('kombo refund (price < 0) subtracts from komboUnits', () => {
    const m = computeMetrics([
      { productid: PRODUCT_IDS.KOMBO_LAMB, count: 3, price:  447 },
      { productid: PRODUCT_IDS.KOMBO_LAMB, count: -1, price: -149 },
    ]);
    assert.equal(m.komboUnits, 2);
  });

  test('lemonade refund subtracts from lemUnits', () => {
    const m = computeMetrics([
      { productid: PRODUCT_IDS.LEM_STANDALONE, count: 2, price: 70 },
      { productid: PRODUCT_IDS.LEM_STANDALONE, count: -1, price: -35 },
    ]);
    assert.equal(m.lemUnits, 1);
  });
});

describe('no extra request needed — computeMetrics is a pure function', () => {
  test('computeMetrics takes a lines array and returns synchronously', () => {
    // It is a pure synchronous function — no I/O, no network, no extra HTTP call.
    const lines = [{ productid: PRODUCT_IDS.KOMBO_LAMB, count: 1, price: 149 }];
    const start = Date.now();
    const m     = computeMetrics(lines);
    const elapsed = Date.now() - start;
    assert.equal(m.komboUnits, 1);
    assert.ok(elapsed < 10, 'computeMetrics must be synchronous (< 10 ms)');
  });
});

describe('no fuzzy product-name classification remains in application code', () => {
  test('categorizeItems is not defined in index.html', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.ok(!html.includes('function categorizeItems'),
      'categorizeItems function must be removed from index.html');
  });

  test('no name-based kombo/combo regex in index.html', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    // The old pattern: /kombo|combo/.test(n)
    assert.ok(!/\/kombo\|combo\//.test(html),
      'fuzzy kombo/combo regex must not appear in index.html');
  });

  test('no name-based roll classification in index.html', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    // The old pattern: n.startsWith('killer') && isProtein
    // Test for the specific fuzzy startsWith pattern:
    assert.ok(!html.includes("n.startsWith('killer')"),
      "fuzzy 'killer' name prefix check must not appear in index.html");
  });

  test('no productname.includes(lemonade) in server.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(!src.includes("includes('lemonade')"),
      "fuzzy productname.includes('lemonade') must not appear in server.js");
  });
});

// ── Server integration: /js/product-metrics.js route ─────────────────────────

const TEST_USERNAME      = 'pm-int-testuser';
const TEST_PASSWORD      = 'pm-int-password';
const TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);

process.env.NODE_ENV          = 'test';
process.env.KK_USERNAME       = TEST_USERNAME;
process.env.KK_PASSWORD_HASH  = TEST_PASSWORD_HASH;
process.env.KK_SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.PLANDAY_APP_ID             = 'pm-planday-appid';
process.env.PLANDAY_REFRESH_TOKEN      = 'pm-planday-rt';
process.env.ONLINEPOS_TOKEN_INDRE_BY        = 'pm-tok-indre-by';
process.env.ONLINEPOS_TOKEN_VESTERBRO       = 'pm-tok-vesterbro';
process.env.ONLINEPOS_TOKEN_CHRISTIANSHAVN  = 'pm-tok-christianshavn';
process.env.ONLINEPOS_TOKEN_FISKETORVET     = 'pm-tok-fisketorvet';
process.env.ONLINEPOS_TOKEN_FREDERIKSBERG   = 'pm-tok-frederiksberg';
process.env.ONLINEPOS_TOKEN_NORREBRO        = 'pm-tok-norrebro';

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
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: axiosMock };

const app = require('../server');
let server, baseUrl;

before(() => new Promise(resolve => {
  server = app.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise(resolve => server.close(resolve)));

function reqGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: urlPath,
      method: 'GET',
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject).end();
  });
}

describe('/js/product-metrics.js route', () => {
  test('GET /js/product-metrics.js returns 200', async () => {
    const r = await reqGet('/js/product-metrics.js');
    assert.equal(r.status, 200);
  });

  test('Content-Type is application/javascript', async () => {
    const r = await reqGet('/js/product-metrics.js');
    assert.ok(r.headers['content-type'].includes('javascript'),
      `Expected javascript, got: ${r.headers['content-type']}`);
  });

  test('response body sets window.ProductMetrics in browser context', async () => {
    const r = await reqGet('/js/product-metrics.js');
    // Evaluate the UMD module in a minimal context that simulates the browser global
    const fakeGlobal = {};
    // eslint-disable-next-line no-new-func
    new Function('globalThis', r.body)(fakeGlobal);
    assert.ok(fakeGlobal.ProductMetrics, 'ProductMetrics must be set on globalThis');
    assert.equal(typeof fakeGlobal.ProductMetrics.computeMetrics, 'function');
  });

  test('browser-loaded computeMetrics produces correct fixture result', async () => {
    const r = await reqGet('/js/product-metrics.js');
    const fakeGlobal = {};
    // eslint-disable-next-line no-new-func
    new Function('globalThis', r.body)(fakeGlobal);
    const m = fakeGlobal.ProductMetrics.computeMetrics(fixtureLines);
    assert.equal(m.komboUnits, 66);
    assert.equal(m.rollUnits,  54);
    assert.equal(Math.round(m.komboPct * 10000) / 10000, 55.0);
    assert.equal(m.lemUnits,   20);
  });

  test('path traversal via route does not expose arbitrary files', async () => {
    // The route is hardcoded to lib/product-metrics.js.
    // Verify that sibling/parent paths are not served.
    const r = await reqGet('/js/../server.js');
    // Express normalizes the path, so this resolves to /server.js which has no route → 404
    assert.notEqual(r.status, 200, 'Traversal attempt must not return 200');
  });

  test('../../server.js path traversal attempt returns non-200', async () => {
    const r = await reqGet('/js/../../server.js');
    assert.notEqual(r.status, 200);
  });
});

describe('source-exposure protections still pass', () => {
  test('GET / returns 200 (index.html served)', async () => {
    const r = await reqGet('/');
    assert.equal(r.status, 200);
  });

  test('GET /server.js returns 404 (not served)', async () => {
    const r = await reqGet('/server.js');
    assert.equal(r.status, 404);
  });

  test('GET /package.json returns 404 (not served)', async () => {
    const r = await reqGet('/package.json');
    assert.equal(r.status, 404);
  });

  test('GET /lib/product-metrics.js returns 404 (only /js/ path is served)', async () => {
    const r = await reqGet('/lib/product-metrics.js');
    assert.equal(r.status, 404);
  });

  test('GET /lib/pos-fetcher.js returns 404', async () => {
    const r = await reqGet('/lib/pos-fetcher.js');
    assert.equal(r.status, 404);
  });
});
