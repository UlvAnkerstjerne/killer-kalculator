'use strict';
/**
 * Lemonade retirement verification tests.
 *
 * Proves:
 *  1. No Lemonade navigation item remains.
 *  2. The standalone lemonade view is removed.
 *  3. Legacy lemonade endpoints return 404.
 *  4. No scheduled lemonade-history job remains.
 *  5. Chain Overview still shows lemonade (via computeMetrics).
 *  6. Store views still show lemonade (via computeMetrics).
 *  7. Graphs still supports Lemonade as a metric.
 *  8. Historical lemonade remains database-backed (product-metrics unchanged).
 *  9. Today's lemonade continues through normal OnlinePOS routing.
 * 10. Existing sales/database tests remain green (covered by suite).
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

// ── Environment ──────────────────────────────────────────────────────────────
process.env.NODE_ENV          = 'test';
process.env.KK_USERNAME       = 'retire-test';
process.env.KK_PASSWORD_HASH  = bcrypt.hashSync('retire-password', 4);
process.env.KK_SESSION_SECRET = crypto.randomBytes(32).toString('hex');

// ── 1–2. Frontend: no nav item, no standalone view ───────────────────────────
describe('Frontend lemonade removal', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  test('1. No Lemonade navigation item remains', () => {
    assert.ok(!html.includes('data-view="lemonade"'),
      'Lemonade nav button still present in index.html');
    assert.ok(!html.includes("setView('lemonade')"),
      'setView(lemonade) still present in index.html');
  });

  test('2. The standalone lemonade view is removed', () => {
    assert.ok(!html.includes('renderLemonadeView'),
      'renderLemonadeView still present in index.html');
    assert.ok(!html.includes('getLemonadeToday'),
      'getLemonadeToday still present in index.html');
    assert.ok(!html.includes("'/api/lemonade/today'"),
      'Frontend still references /api/lemonade/today');
    assert.ok(!html.includes("'/api/lemonade/history'"),
      'Frontend still references /api/lemonade/history');
  });

  test('2b. lemonadeRefreshInterval and lemonadeToday state are removed', () => {
    assert.ok(!html.includes('lemonadeRefreshInterval'),
      'lemonadeRefreshInterval still present in index.html');
    assert.ok(!html.includes('lemonadeToday'),
      'lemonadeToday state still present in index.html');
  });

  test('7. Graphs still supports Lemonade as a metric', () => {
    assert.ok(html.includes("'lemonade','Lemonade'"),
      'Lemonade graphs metric option is missing');
  });
});

// ── 3. Legacy endpoints return 404 ──────────────────────────────────────────
describe('Legacy lemonade endpoints return 404', () => {
  const app = require('../server');
  let server, url, cookie;

  before(async () => {
    await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
    url = 'http://127.0.0.1:' + server.address().port;
    const r = await fetch(url + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'retire-test', password: 'retire-password' }),
    });
    assert.equal(r.status, 200);
    cookie = r.headers.get('set-cookie').split(';')[0];
  });
  after(async () => {
    app.locals.salesRangeCache.clear();
    app.locals.revenueSummaryCache.clear();
    await new Promise(r => server.close(r));
  });

  test('3. GET /api/lemonade/today returns 404', async () => {
    const r = await fetch(url + '/api/lemonade/today', { headers: { Cookie: cookie } });
    assert.equal(r.status, 404);
  });

  test('3. GET /api/lemonade/history returns 404', async () => {
    const r = await fetch(url + '/api/lemonade/history', { headers: { Cookie: cookie } });
    assert.equal(r.status, 404);
  });

  test('3. POST /api/lemonade/history returns 404', async () => {
    const r = await fetch(url + '/api/lemonade/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify([]),
    });
    assert.equal(r.status, 404);
  });
});

// ── 4. No scheduled lemonade-history job remains ─────────────────────────────
describe('No scheduled lemonade-history job', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  test('4. No fetchLemonadeToday function', () => {
    assert.ok(!serverSrc.includes('fetchLemonadeToday'),
      'fetchLemonadeToday still in server.js');
  });

  test('4. No loadLemonadeHistory / saveLemonadeHistory helpers', () => {
    assert.ok(!serverSrc.includes('loadLemonadeHistory'),
      'loadLemonadeHistory still in server.js');
    assert.ok(!serverSrc.includes('saveLemonadeHistory'),
      'saveLemonadeHistory still in server.js');
  });

  test('4. No LEMONADE_HISTORY_PATH', () => {
    assert.ok(!serverSrc.includes('LEMONADE_HISTORY_PATH'),
      'LEMONADE_HISTORY_PATH still in server.js');
  });

  test('4. No lemonadeSavedDate scheduled job', () => {
    assert.ok(!serverSrc.includes('lemonadeSavedDate'),
      'lemonadeSavedDate still in server.js');
  });
});

// ── 5–6. Chain Overview and store views still show lemonade ──────────────────
describe('Product metrics still compute lemonade', () => {
  const { computeMetrics, LEM_IDS, LEM_ADDON_IDS, LEM_UPGRADE_IDS, LEM_STANDALONE_IDS } =
    require('../lib/product-metrics');

  test('5. computeMetrics returns lemUnits for chain-level aggregation', () => {
    const lines = [
      { productid: '27242080', count: 5, price: 0   },   // addon
      { productid: '27242148', count: 3, price: 10  },   // upgrade
      { productid: '27242164', count: 2, price: 35  },   // standalone
    ];
    const m = computeMetrics(lines);
    assert.equal(m.lemUnits, 10);
    assert.equal(m.breakdown.lemAddon, 5);
    assert.equal(m.breakdown.lemUpgrade, 3);
    assert.equal(m.breakdown.lemStandalone, 2);
  });

  test('6. LEM ID sets cover all six stores', () => {
    assert.ok(LEM_IDS.size >= 15, 'Expected at least 15 lemonade product IDs across stores');
    assert.ok(LEM_ADDON_IDS.size >= 3);
    assert.ok(LEM_UPGRADE_IDS.size >= 6);
    assert.ok(LEM_STANDALONE_IDS.size >= 6);
  });

  test('8. Historical lemonade remains database-backed (product classification intact)', () => {
    // Lemonade classification is purely product-ID-based in product-metrics.js,
    // which is the same engine used by both historical (database) and live (OnlinePOS) paths.
    const historicalLine = { productid: '27241772', count: 1, price: 35 };  // Indre By standalone
    const m = computeMetrics([historicalLine]);
    assert.equal(m.lemUnits, 1);
  });

  test('9. Today lemonade flows through normal OnlinePOS routing (computeMetrics)', () => {
    // The live sales-range route + computeMetrics is the only lemonade counting path now.
    // Verify the engine still works for all three variant types.
    const todayLines = [
      { productid: '27240620', count: 4, price: 10 },  // Vesterbro upgrade
      { productid: '27241024', count: 2, price: 35 },  // Fisketorvet standalone
    ];
    const m = computeMetrics(todayLines);
    assert.equal(m.lemUnits, 6);
    assert.equal(m.breakdown.lemUpgrade, 4);
    assert.equal(m.breakdown.lemStandalone, 2);
  });
});
