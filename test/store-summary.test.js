'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { buildStoreSummaryMetrics, publicSource } = require('../lib/store-summary');
const { computeMetrics } = require('../lib/product-metrics');

process.env.NODE_ENV = 'test';
process.env.KK_USERNAME = 'summary-test';
process.env.KK_PASSWORD_HASH = bcrypt.hashSync('synthetic-password', 4);
process.env.KK_SESSION_SECRET = 'synthetic-session-only';
process.env.PLANDAY_APP_ID = 'synthetic-planday-app';
process.env.PLANDAY_REFRESH_TOKEN = 'SYNTHETIC_PLANDAY_REFRESH';
for (const id of ['INDRE_BY', 'VESTERBRO', 'CHRISTIANSHAVN', 'FISKETORVET', 'FREDERIKSBERG', 'NORREBRO']) {
  process.env['ONLINEPOS_TOKEN_' + id] = 'SYNTHETIC_POS_TOKEN_' + id;
}
const TOKEN = 'k'.repeat(48);
process.env.KOCKPIT_READ_TOKEN = TOKEN;

// ── Synthetic data (Nørrebro product IDs) ────────────────────────────────────
const ROLL = '27242336', KOMBO = '27242208', LEM = '27242164', OTHER = '99999999';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const next = d => new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10);
const prev = d => new Date(Date.parse(d) - 86400000).toISOString().slice(0, 10);
const dates = (s, e) => { const out = []; for (let d = s; d < e; d = next(d)) out.push(d); return out; };

// Stored day: 2 rolls (76 ex VAT each), 1 kombo (100), 1 lemonade (28).
const storedLines = date => [
  { productid: ROLL, productname: 'Killer Kebab', productgroupid: '1', productgroup: 'Rolls', count: 2, price: 190, priceexclvat: 152, paymenttype: 'Kontant', paymenttypecode: null, date, hour: 12, secondOfDay: 43200 },
  { productid: KOMBO, productname: 'Kombo', productgroupid: '2', productgroup: 'Kombo', count: 1, price: 125, priceexclvat: 100, paymenttype: 'Kontant', paymenttypecode: null, date, hour: 12, secondOfDay: 43300 },
  { productid: LEM, productname: 'Killer Lemonade', productgroupid: '3', productgroup: 'Drinks', count: 1, price: 35, priceexclvat: 28, paymenttype: 'Kontant', paymenttypecode: null, date, hour: 12, secondOfDay: 43400 },
];
// Provider (open day): 1 kombo, 1 staff-meal kombo (price 0), 1 roll + its refund.
const providerRows = date => [
  { orderlineid: 'p1', productid: KOMBO, productname: 'Kombo', productgroupid: 2, productgroup: 'Kombo', count: 1, price: 125, priceexclvat: 100, paymenttype: 'Kort', cardnumber: 'PRIVATE_CARD', clerk: 'PRIVATE_CLERK', timestamp_pay: date + ' 11:00:00' },
  { orderlineid: 'p2', productid: KOMBO, productname: 'Kombo', productgroupid: 2, productgroup: 'Kombo', count: 1, price: 0, priceexclvat: 0, paymenttype: 'Personale', timestamp_pay: date + ' 11:05:00' },
  { orderlineid: 'p3', productid: ROLL, productname: 'Killer Kebab', productgroupid: 1, productgroup: 'Rolls', count: 1, price: 95, priceexclvat: 76, paymenttype: 'Kort', timestamp_pay: date + ' 11:10:00' },
  { orderlineid: 'p4', productid: ROLL, productname: 'Killer Kebab', productgroupid: 1, productgroup: 'Rolls', count: -1, price: -95, priceexclvat: -76, paymenttype: 'Kort', timestamp_pay: date + ' 11:15:00' },
];

let mode = 'normal', provider = 0, reads = 0, planday = 0;
require.cache[require.resolve('../lib/sales-read-source')] = { exports: { createSalesReadSource: () => ({
  policy: 'covered-history',
  async ready() { return { ready: true, source: 'database' }; },
  async read({ storeSlug, start, end }) {
    reads++;
    if (mode === 'db-error') throw Error('PRIVATE_DATABASE_DETAIL');
    const days = dates(start, end).map(date => ({ date, status: 'complete' }));
    return { lines: dates(start, end).flatMap(storedLines), meta: { source: 'database', complete: true, storeId: storeSlug, start, end, coverage: { complete: true, days } } };
  },
}) } };
require.cache[require.resolve('axios')] = { exports: {
  async post() { return { data: { access_token: 'PRIVATE_PLANDAY_ACCESS', expires_in: 3600 } }; },
  async get(url) {
    if (url.startsWith('https://openapi.planday.com')) {
      planday++;
      if (mode === 'planday-error') throw Error('PRIVATE_PLANDAY_DETAIL');
      if (url.includes('/payroll/')) return { data: { data: [{ employeeId: 7, totalCost: 456 }] } };
      return { data: { data: mode === 'no-salary' ? [] : [{ employeeId: 7, departmentId: 149700, startDateTime: '2026-10-01T10:00:00Z', endDateTime: '2026-10-01T14:00:00Z' }], paging: { total: 1 } } };
    }
    provider++;
    if (mode === 'provider-error') throw Error('PRIVATE_PROVIDER_DETAIL');
    return { status: 200, data: { current_page: 1, next_page_url: null, data: mode === 'empty-today' ? [] : providerRows(today) } };
  },
} };

const app = require('../server');
let server, url;
before(async () => { await new Promise(r => { server = app.listen(0, '127.0.0.1', r); }); url = 'http://127.0.0.1:' + server.address().port; });
beforeEach(() => { mode = 'normal'; provider = reads = planday = 0; app.locals.salesRangeCache.clear(); app.locals.salarySummaryCache.clear(); process.env.KOCKPIT_READ_TOKEN = TOKEN; });
after(async () => { app.locals.salesRangeCache.clear(); app.locals.revenueSummaryCache.clear(); await new Promise(r => server.close(r)); });

const call = async (path, { token = TOKEN, method = 'GET', headers = {} } = {}) => {
  const h = { ...headers };
  if (token !== null) h.Authorization = 'Bearer ' + token;
  const r = await fetch(url + path, { method, headers: h });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  return { status: r.status, body, text, cacheControl: r.headers.get('cache-control') };
};
const yday = prev(today);
const summaryPath = (store, s, e) => `/api/internal/store-summary/${store}/${s}/${e}`;

// ── Pure metric derivation ───────────────────────────────────────────────────
test('metrics reuse canonical computeMetrics exactly', () => {
  const lines = [...storedLines(yday), { productid: OTHER, count: 3, price: 30, priceexclvat: 24 }];
  const m = buildStoreSummaryMetrics(lines, 1000);
  const c = computeMetrics(lines);
  assert.equal(m.rollUnits, c.rollUnits);
  assert.equal(m.komboUnits, c.komboUnits);
  assert.equal(m.lemonadeUnits, c.lemUnits);
  assert.equal(m.komboPct, Math.round(c.komboPct * 100) / 100);
  assert.equal(m.revenueExVat, 152 + 100 + 28 + 24);
  assert.equal(m.salaryPct, Math.round(1000 / 304 * 100 * 100) / 100);
});
test('zero kombo denominator yields null, zero lemonades stay 0', () => {
  const m = buildStoreSummaryMetrics([{ productid: OTHER, count: 1, price: 50, priceexclvat: 40 }], 500);
  assert.equal(m.komboPct, null);
  assert.equal(m.rollUnits, 0);
  assert.equal(m.lemonadeUnits, 0);
});
test('0% kombo is valid when rolls exist and kombos are zero', () => {
  const m = buildStoreSummaryMetrics([{ productid: ROLL, count: 2, price: 190, priceexclvat: 152 }], null);
  assert.equal(m.komboPct, 0);
});
test('salary unavailable or zero is null, never 0%', () => {
  for (const salary of [null, undefined, 0, NaN]) {
    const m = buildStoreSummaryMetrics(storedLines(yday), salary);
    assert.equal(m.salaryCost, null);
    assert.equal(m.salaryPct, null);
  }
  assert.equal(buildStoreSummaryMetrics([], 500).salaryPct, null, 'zero revenue → null salary %');
});
test('public source vocabulary hides provider names', () => {
  assert.equal(publicSource('onlinepos'), 'provider');
  assert.equal(publicSource('database'), 'database');
  assert.equal(publicSource('hybrid'), 'hybrid');
});

// ── Authentication ──────────────────────────────────────────────────────────
test('missing token is rejected', async () => {
  const r = await call(summaryPath('norrebro', yday, today), { token: null });
  assert.equal(r.status, 401); assert.equal(reads + provider + planday, 0);
});
test('wrong token and wrong-length token are rejected', async () => {
  for (const token of ['x'.repeat(48), TOKEN.slice(1), TOKEN + 'x', '']) {
    const r = await call(summaryPath('norrebro', yday, today), { token });
    assert.equal(r.status, 401);
  }
  const basic = await call(summaryPath('norrebro', yday, today), { token: null, headers: { Authorization: 'Basic ' + TOKEN } });
  assert.equal(basic.status, 401);
  assert.equal(reads + provider + planday, 0);
});
test('unconfigured or short token disables the endpoint', async () => {
  delete process.env.KOCKPIT_READ_TOKEN;
  assert.equal((await call(summaryPath('norrebro', yday, today), { token: '' })).status, 503);
  process.env.KOCKPIT_READ_TOKEN = 'short';
  assert.equal((await call(summaryPath('norrebro', yday, today), { token: 'short' })).status, 503);
});
test('browser session is not accepted as the integration credential', async () => {
  const login = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'summary-test', password: 'synthetic-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const r = await call(summaryPath('norrebro', yday, today), { token: null, headers: { Cookie: cookie } });
  assert.equal(r.status, 401);
});
test('read only: non-GET methods are not routed', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const r = await call(summaryPath('norrebro', yday, today), { method });
    assert.equal(r.status, 404);
  }
});

// ── Validation ───────────────────────────────────────────────────────────────
test('unsupported or non-canonical store is rejected', async () => {
  for (const store of ['airport', 'parken', 'nørrebro', 'NORREBRO', '__proto__', 'constructor']) {
    const r = await call(summaryPath(encodeURIComponent(store), yday, today));
    assert.equal(r.status, 404, store);
  }
  assert.equal(reads + provider + planday, 0);
});
test('invalid date ranges are rejected', async () => {
  const cases = [['2026-13-01', '2026-13-02'], [today, today], [today, yday], ['2026-01-01', '2026-03-01'], [next(today), next(next(today))], ['x', today]];
  for (const [s, e] of cases) assert.equal((await call(summaryPath('norrebro', s, e))).status, 400, s + '→' + e);
});

// ── Source routing ───────────────────────────────────────────────────────────
test('completed day reads the database only', async () => {
  const r = await call(summaryPath('norrebro', yday, today));
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'database');
  assert.equal(r.body.complete, true);
  assert.equal(provider, 0);
  assert.deepEqual(r.body.metrics, { revenueExVat: 280, salaryCost: 456, salaryPct: Math.round(456 / 280 * 10000) / 100,
    rollUnits: 2, komboUnits: 1, komboPct: Math.round(1 / 3 * 10000) / 100, lemonadeUnits: 1 });
  assert.equal(r.cacheControl, 'no-store');
});
test('today reads the provider; staff meals excluded, refunds net out', async () => {
  const r = await call(summaryPath('norrebro', today, next(today)));
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'provider');
  assert.equal(reads, 0);
  assert.equal(r.body.metrics.komboUnits, 1);
  assert.equal(r.body.metrics.rollUnits, 0);
  assert.equal(r.body.metrics.komboPct, 100);
  assert.equal(r.body.metrics.lemonadeUnits, 0);
  assert.equal(r.body.metrics.revenueExVat, 100);
});
test('range spanning history and today is hybrid', async () => {
  const r = await call(summaryPath('norrebro', prev(yday), next(today)));
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'hybrid');
  assert.equal(r.body.metrics.revenueExVat, 280 * 2 + 100);
  assert.equal(r.body.metrics.komboUnits, 3);
  assert.equal(r.body.metrics.rollUnits, 4);
  assert.equal(r.body.metrics.lemonadeUnits, 2);
});
test('summary equals what the dashboard derives from /api/sales-range', async () => {
  const login = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'summary-test', password: 'synthetic-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const start = prev(yday), end = next(today);
  const dash = await (await fetch(url + `/api/sales-range/norrebro/${start}/${end}`, { headers: { Cookie: cookie } })).json();
  const c = computeMetrics(dash.lines);
  const r = await call(summaryPath('norrebro', start, end));
  assert.equal(r.body.metrics.revenueExVat, Math.round(dash.lines.reduce((s, l) => s + (l.priceexclvat || 0), 0) * 100) / 100);
  assert.equal(r.body.metrics.komboUnits, c.komboUnits);
  assert.equal(r.body.metrics.rollUnits, c.rollUnits);
  assert.equal(r.body.metrics.lemonadeUnits, c.lemUnits);
});
test('empty open day: zero units, null kombo %, null salary %', async () => {
  mode = 'empty-today';
  const r = await call(summaryPath('norrebro', today, next(today)));
  assert.equal(r.status, 200);
  assert.equal(r.body.metrics.lemonadeUnits, 0);
  assert.equal(r.body.metrics.komboPct, null);
  assert.equal(r.body.metrics.salaryPct, null);
});

// ── Failure and leakage ──────────────────────────────────────────────────────
test('Planday failure leaves sales metrics intact with null salary', async () => {
  mode = 'planday-error';
  const r = await call(summaryPath('norrebro', yday, today));
  assert.equal(r.status, 200);
  assert.equal(r.body.metrics.salaryCost, null);
  assert.equal(r.body.metrics.salaryPct, null);
  assert.equal(r.body.metrics.revenueExVat, 280);
  assert(!r.text.includes('PRIVATE_PLANDAY'));
});
test('store without Planday cost gets null salary', async () => {
  const r = await call(summaryPath('vesterbro', yday, today));
  assert.equal(r.body.metrics.salaryCost, null);
});
test('sales unavailable → 503, complete:false, metrics null, no internals', async () => {
  mode = 'db-error';
  const db = await call(summaryPath('norrebro', yday, today));
  assert.equal(db.status, 503); assert.equal(db.body.complete, false); assert.equal(db.body.metrics, null);
  assert(!db.text.includes('PRIVATE_DATABASE_DETAIL'));
  mode = 'provider-error';
  const pr = await call(summaryPath('norrebro', today, next(today)));
  assert.equal(pr.status, 503); assert.equal(pr.body.metrics, null);
  assert(!pr.text.includes('PRIVATE_PROVIDER_DETAIL'));
});
test('response contains only normalized KPIs — no lines or secrets', async () => {
  const r = await call(summaryPath('norrebro', prev(yday), next(today)));
  assert.deepEqual(Object.keys(r.body).sort(), ['complete', 'end', 'metrics', 'source', 'start', 'storeId']);
  assert.deepEqual(Object.keys(r.body.metrics).sort(), ['komboPct', 'komboUnits', 'lemonadeUnits', 'revenueExVat', 'rollUnits', 'salaryCost', 'salaryPct']);
  for (const secret of ['SYNTHETIC_POS_TOKEN', 'SYNTHETIC_PLANDAY_REFRESH', 'PRIVATE_PLANDAY_ACCESS', 'PRIVATE_CARD', 'PRIVATE_CLERK', TOKEN, 'productid', 'orderlineid', 'firmaid', 'lines']) {
    assert(!r.text.includes(secret), secret);
  }
});
test('one Planday fetch is shared across stores for the same period', async () => {
  await call(summaryPath('norrebro', yday, today));
  const after1 = planday;
  await call(summaryPath('vesterbro', yday, today));
  assert.equal(planday, after1);
});
