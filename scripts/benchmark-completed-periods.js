'use strict';
// Real Express routes with deterministic delayed providers; never production.
// Measures API readiness/serialization. Separate Chromium render measurements are in docs.
// node scripts/benchmark-completed-periods.js [delay-ms=250] [lines/day=80]
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const RealDate = Date;
const fixedNow = RealDate.parse('2026-09-23T12:00:00Z');
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [fixedNow])); }
  static now() { return fixedNow; }
};
const delayMs = Number(process.argv[2] || 250);
const linesPerDay = Number(process.argv[3] || 80);
const fixture = require('../test/fixtures/norrebro-2026-09-20.fixture.json').lines;
const stores = ['indre-by', 'vesterbro', 'christianshavn', 'fisketorvet', 'frederiksberg', 'norrebro'];
const periods = ['yesterday', 'last-week', 'last-month'];
const offset = (date, n) => new Date(new Date(date + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const cphDate = ts => new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Copenhagen' }).format(new Date(ts));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exportsLog = [];
let active = 0, maxActive = 0;
process.env.NODE_ENV = 'test';
process.env.KK_USERNAME = 'benchmark';
process.env.KK_PASSWORD_HASH = bcrypt.hashSync('benchmark', 4);
process.env.KK_SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.PLANDAY_APP_ID = 'mock';
process.env.PLANDAY_REFRESH_TOKEN = 'mock';
for (const store of stores) process.env['ONLINEPOS_TOKEN_' + store.toUpperCase().replaceAll('-', '_')] = store;
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: {
  post: async () => ({ data: { access_token: 'mock', expires_in: 3600 } }),
  get: async (url, config) => {
    if (!url.includes('api.onlinepos.dk')) {
      await sleep(delayMs * 4); // Deliberately slower salary: proves it cannot gate KPI rendering.
      return { data: { data: [], paging: { total: 0 } } };
    }
    const start = cphDate(Number(new URL(url).pathname.split('/').pop()) * 1000);
    exportsLog.push({ store: config.headers.token, start, at: performance.now() });
    maxActive = Math.max(maxActive, ++active);
    try {
      await sleep(delayMs);
      const data = [];
      for (let day = 0; day < 32; day++) {
        const date = offset(start, day);
        for (let i = 0; i < linesPerDay; i++) {
          const original = fixture[i % fixture.length];
          data.push({ ...original, orderlineid: `${date}-${i}`,
            timestamp_pay: `${date} 12:${String(i % 60).padStart(2, '0')}:00`,
            clerk: 'raw-private-sentinel', cardnumber: 'raw-private-sentinel' });
        }
      }
      return { data: { data, current_page: 1, next_page_url: null } };
    } finally { active--; }
  },
} };
const app = require('../server');
const cacheStats = () => ({ sales: app.locals.salesRangeCache.stats(), ly: app.locals.revenueSummaryCache.stats() });
const clear = () => { app.locals.salesRangeCache.clear(); app.locals.revenueSummaryCache.clear(); };
const duplicateCount = calls => calls.length - new Set(calls.map(c => `${c.store}:${c.start}`)).size;
async function main() {
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const ranges = {
    yesterday: { start: '2026-09-22', end: '2026-09-23' },
    'last-week': { start: '2026-09-14', end: '2026-09-21' },
    'last-month': { start: '2026-08-01', end: '2026-09-01' },
    today: { start: '2026-09-23', end: '2026-09-24' },
    'this-week': { start: '2026-09-21', end: '2026-09-24' },
  };
  const report = { kind: 'deterministic delayed mock; HTTP measurements, not browser or production', fixedNow: new Date().toISOString(), delayMs, linesPerDay, cold: {}, warm: {}, repeat: {} };
  try {
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'benchmark', password: 'benchmark' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    async function visit(range) {
      const started = performance.now();
      const before = exportsLog.length;
      const responseBytes = { current: 0, ly: 0, salary: 0 };
      const request = async (route, kind) => {
        const response = await fetch(base + route, { headers: { Cookie: cookie } });
        const text = await response.text();
        assert.equal(response.status, 200);
        assert.ok(!text.includes('raw-private-sentinel'));
        responseBytes[kind] += Buffer.byteLength(text);
        return JSON.parse(text);
      };
      const current = Promise.all(stores.map(store => request(`/api/sales-range/${store}/${range.start}/${range.end}`, 'current'))).then(bodies => ({
        ms: performance.now() - started,
        value: bodies.reduce((sum, body) => sum + body.lines.reduce((sum, line) => sum + (line.priceexclvat || 0), 0), 0),
      }));
      const ly = Promise.all(stores.map(store => request(`/api/revenue-summary/${store}/${offset(range.start, -364)}/${offset(range.end, -364)}`, 'ly'))).then(bodies => ({
        ms: performance.now() - started,
        value: bodies.reduce((sum, body) => sum + body.summary.completeRevenue, 0),
      }));
      const salary = request(`/api/planday/salaries/${range.start}/${offset(range.end, -1)}`, 'salary').then(() => performance.now() - started);
      const [revenue, comparison, salaryMs] = await Promise.all([current, ly, salary]);
      const calls = exportsLog.slice(before);
      return { currentRevenueMs: revenue.ms, lyResponseMs: comparison.ms,
        lyComparisonReadyMs: Math.max(revenue.ms, comparison.ms), budgetReadyMs: Math.max(revenue.ms, comparison.ms), salaryMs,
        revenue: revenue.value, ly: comparison.value, budget: comparison.value * 1.10,
        exports: calls.length, duplicates: duplicateCount(calls), responseBytes };
    }
    for (const period of periods) { clear(); report.cold[period] = await visit(ranges[period]); }
    clear();
    const before = exportsLog.length;
    const warming = app.locals.warmStartupData();
    const healthStart = performance.now();
    const health = await fetch(base + '/api/health');
    report.readiness = { status: health.status, ms: performance.now() - healthStart };
    report.startup = await warming;
    report.startup.exports = exportsLog.length - before;
    report.startup.duplicates = duplicateCount(exportsLog.slice(before));
    report.afterWarming = cacheStats();
    report.highPriorityEvicted = !stores.every(storeId => ['today', 'this-week'].every(period => app.locals.salesRangeCache.inspect({ storeId, ...ranges[period] })));
    for (const period of periods) {
      report.warm[period] = await visit(ranges[period]);
      report.repeat[period] = await visit(ranges[period]);
      for (const metric of ['revenue', 'ly', 'budget']) {
        assert.ok(Math.abs(report.warm[period][metric] - report.cold[period][metric]) < 1e-6,
          `${period} ${metric} unchanged (floating-point summation tolerance)`);
      }
    }
    report.finalCaches = cacheStats();
    report.highPriorityEvictedAfterVisits = !stores.every(storeId => ['today', 'this-week'].every(period => app.locals.salesRangeCache.inspect({ storeId, ...ranges[period] })));
    report.maxOnlineposConcurrency = maxActive;
    assert.ok(maxActive <= 2);
    assert.equal(report.highPriorityEvicted, false);
    assert.equal(report.highPriorityEvictedAfterVisits, false);
    assert.ok(report.afterWarming.sales.estimatedBytes <= report.afterWarming.sales.maxBytes);
    console.log('BENCHMARK_JSON\n' + JSON.stringify(report, null, 2));
  } finally {
    await new Promise(resolve => server.close(resolve));
    clear();
  }
}
main().catch(error => { console.error(error); process.exit(1); });
