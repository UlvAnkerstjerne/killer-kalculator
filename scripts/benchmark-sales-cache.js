'use strict';

// Deterministic end-to-end benchmark: mocked OnlinePOS, real Express routes.
// Usage: node scripts/benchmark-sales-cache.js [mock-delay-ms]

const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const delayMs = Number(process.argv[2] || 250);
const stores = ['indre-by', 'vesterbro', 'christianshavn', 'fisketorvet', 'frederiksberg', 'norrebro'];
const tokens = Object.fromEntries(stores.map(store => [store, `benchmark-${store}`]));
let upstreamCalls = 0;

function nextDay(dateStr, offset = 1) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}

const today = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Copenhagen' }).format(new Date());
const tomorrow = nextDay(today);
const yesterday = nextDay(today, -1);
const todayDate = new Date(today + 'T12:00:00Z');
const weekday = todayDate.getUTCDay();
const mondayDate = new Date(todayDate);
mondayDate.setUTCDate(todayDate.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
const monday = mondayDate.toISOString().slice(0, 10);

process.env.NODE_ENV = 'test';
process.env.KK_USERNAME = 'benchmark-user';
process.env.KK_PASSWORD_HASH = bcrypt.hashSync('benchmark-password', 4);
process.env.KK_SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.PLANDAY_APP_ID = 'benchmark-planday';
process.env.PLANDAY_REFRESH_TOKEN = 'benchmark-refresh';
for (const store of stores) {
  const envName = 'ONLINEPOS_TOKEN_' + store.toUpperCase().replace(/-/g, '_');
  process.env[envName] = tokens[store];
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const axiosMock = {
  get: async (_url, config) => {
    upstreamCalls++;
    await sleep(delayMs);
    const token = config?.headers?.token || 'unknown';
    return {
      status: 200,
      data: {
        current_page: 1,
        next_page_url: null,
        data: [{
          orderlineid: `line-${token}`,
          timestamp_pay: `${today} 12:00:00`,
          productid: 27242336,
          productname: 'Killer Kebab',
          count: 1,
          price: 89,
          priceexclvat: 71.2,
          paymenttype: 'Dankort',
        }],
      },
    };
  },
  post: async () => ({ status: 200, data: { access_token: 'benchmark', expires_in: 3600 } }),
  create() { return this; },
  defaults: { headers: { common: {} } },
};
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: axiosMock };

const app = require('../server');

async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

async function main() {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const warming = timed(() => app.locals.warmCurrentSalesRanges());
    const health = await timed(async () => {
      const response = await fetch(base + '/api/health');
      if (!response.ok) throw new Error(`health returned ${response.status}`);
      return response.json();
    });
    const warm = await warming;
    const warmingCalls = upstreamCalls;
    const warmStats = app.locals.salesRangeCache.stats();

    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'benchmark-user', password: 'benchmark-password' }),
    });
    if (!login.ok) throw new Error(`login returned ${login.status}`);
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const loadRange = (start, end) => Promise.all(stores.map(async store => {
      const response = await fetch(`${base}/api/sales-range/${store}/${start}/${end}`, {
        headers: { Cookie: cookie },
      });
      if (!response.ok) throw new Error(`${store} returned ${response.status}`);
      return response.json();
    }));

    const todayView = await timed(() => loadRange(today, tomorrow));
    const weekView = await timed(() => loadRange(monday, tomorrow));
    const unseen = await timed(() => loadRange(yesterday, today));
    const repeat = await timed(() => loadRange(today, tomorrow));

    console.log(`Mock OnlinePOS delay: ${delayMs}ms per export`);
    console.log(`Health while warming: ${health.ms.toFixed(1)}ms (HTTP 200)`);
    console.log(`Startup warming: ${warm.ms.toFixed(1)}ms`);
    console.log(`Startup upstream requests: ${warmingCalls}`);
    console.log(`First Today view after warming: ${todayView.ms.toFixed(1)}ms`);
    console.log(`First This Week view after warming: ${weekView.ms.toFixed(1)}ms`);
    console.log(`First unseen range: ${unseen.ms.toFixed(1)}ms`);
    console.log(`Repeat navigation: ${repeat.ms.toFixed(1)}ms`);
    console.log(`Cache after warming: ${warmStats.entries} entries, ${warmStats.estimatedBytes} estimated bytes`);
    console.log(`Total upstream requests after all scenarios: ${upstreamCalls}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    app.locals.salesRangeCache.clear();
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
