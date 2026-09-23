'use strict';

// Deterministic end-to-end benchmark: delayed mocked OnlinePOS, real Express
// routes, caches, and JSON serialization. No production service is used.
// Usage: node scripts/benchmark-sales-cache.js [mock-delay-ms]

const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const delayMs = Number(process.argv[2] || 250);
const linesPerDay = 80;
const stores = ['indre-by', 'vesterbro', 'christianshavn', 'fisketorvet', 'frederiksberg', 'norrebro'];
let upstreamCalls = 0;

function offsetDate(dateStr, days) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function cphDateFromUnix(unixSeconds) {
  return new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Copenhagen' })
    .format(new Date(unixSeconds * 1000));
}

function currentRanges(today) {
  const date = new Date(today + 'T12:00:00Z');
  const weekday = date.getUTCDay();
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
  const tomorrow = offsetDate(today, 1);
  return {
    Today: { start: today, end: tomorrow },
    'This Week': { start: monday.toISOString().slice(0, 10), end: tomorrow },
    'This Month': { start: today.slice(0, 7) + '-01', end: tomorrow },
  };
}

function makeExportLines(start, token) {
  const lines = [];
  for (let day = 0; day < 32; day++) {
    const date = offsetDate(start, day);
    for (let index = 0; index < linesPerDay; index++) {
      const second = 8 * 3600 + index * 480;
      const hour = String(Math.floor(second / 3600)).padStart(2, '0');
      const minute = String(Math.floor(second % 3600 / 60)).padStart(2, '0');
      const sec = String(second % 60).padStart(2, '0');
      lines.push({
        orderlineid: `${token}-${date}-${index}`,
        timestamp_pay: `${date} ${hour}:${minute}:${sec}`,
        productid: 27242336 + index % 7,
        productname: `Benchmark product ${index % 7}`,
        productgroupid: 5,
        productgroup: 'Rolls',
        count: index % 19 === 0 ? -1 : 1,
        price: 89,
        priceexclvat: index % 19 === 0 ? -71.2 : 71.2,
        paymenttype: index % 4 === 0 ? 'Wolt' : 'Dankort',
        paymenttypecode: index % 4 === 0 ? 'WOLT' : 'DANKORT',
        clerk: 'must-not-reach-browser',
        cardnumber: 'must-not-reach-browser',
      });
    }
  }
  return lines;
}

const today = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Copenhagen' }).format(new Date());
const ranges = currentRanges(today);

process.env.NODE_ENV = 'test';
process.env.KK_USERNAME = 'benchmark-user';
process.env.KK_PASSWORD_HASH = bcrypt.hashSync('benchmark-password', 4);
process.env.KK_SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.PLANDAY_APP_ID = 'benchmark-planday';
process.env.PLANDAY_REFRESH_TOKEN = 'benchmark-refresh';
for (const store of stores) {
  process.env['ONLINEPOS_TOKEN_' + store.toUpperCase().replace(/-/g, '_')] = `benchmark-${store}`;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const axiosMock = {
  get: async (url, config) => {
    upstreamCalls++;
    await sleep(delayMs);
    const startUnix = Number(new URL(url).pathname.split('/').pop());
    const start = cphDateFromUnix(startUnix);
    const token = config?.headers?.token || 'unknown';
    return {
      status: 200,
      data: {
        current_page: 1,
        next_page_url: null,
        data: makeExportLines(start, token),
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
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1');
    instance.once('listening', () => resolve(instance));
    instance.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const startupWarm = timed(() => app.locals.warmStartupData());
    const health = await timed(async () => {
      const response = await fetch(base + '/api/health');
      return response.status;
    });
    const warmed = await startupWarm;
    const startupCalls = upstreamCalls;

    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'benchmark-user', password: 'benchmark-password' }),
    });
    if (!login.ok) throw new Error(`login returned ${login.status}`);
    const cookie = login.headers.get('set-cookie').split(';')[0];

    async function load(kind, range, selectedStores = stores) {
      const before = upstreamCalls;
      const measured = await timed(async () => {
        let responseBytes = 0;
        let pages = 0;
        let rawLines = 0;
        const cacheStatuses = {};
        const bodies = await Promise.all(selectedStores.map(async store => {
          const lyStart = offsetDate(range.start, -364);
          const lyEnd = offsetDate(range.end, -364);
          const boundary = offsetDate(today, -364);
          const route = kind === 'current'
            ? `/api/sales-range/${store}/${range.start}/${range.end}`
            : kind === 'legacy-ly'
              ? `/api/sales-range/${store}/${lyStart}/${lyEnd}`
              : `/api/revenue-summary/${store}/${lyStart}/${lyEnd}?boundary=${boundary}`;
          const response = await fetch(base + route, { headers: { Cookie: cookie } });
          const text = await response.text();
          responseBytes += Buffer.byteLength(text);
          if (!response.ok) throw new Error(`${route} returned ${response.status}`);
          const body = JSON.parse(text);
          pages += body.meta.pages;
          rawLines += body.meta.rawLineCount;
          cacheStatuses[body.meta.cacheStatus] = (cacheStatuses[body.meta.cacheStatus] || 0) + 1;
          return body;
        }));

        const processingStart = performance.now();
        let revenue = 0;
        let completeRevenue = 0;
        const boundary = offsetDate(today, -364);
        let cutoff = null;
        if (kind !== 'current') {
          const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit', second: '2-digit',
            hourCycle: 'h23',
          }).formatToParts(new Date()).reduce((out, part) => {
            if (part.type !== 'literal') out[part.type] = Number(part.value);
            return out;
          }, {});
          cutoff = parts.hour * 3600 + parts.minute * 60 + parts.second;
        }
        if (kind === 'summary') {
          for (const body of bodies) {
            completeRevenue += body.summary.completeRevenue;
            revenue += body.summary.dailyRevenue
              .filter(day => day.date < boundary)
              .reduce((sum, day) => sum + day.revenue, 0);
            revenue += body.summary.boundary.seconds
              .filter(([second]) => second <= cutoff)
              .reduce((sum, pair) => sum + pair[1], 0);
          }
        } else if (kind === 'legacy-ly') {
          for (const body of bodies) {
            completeRevenue += body.lines.reduce(
              (total, line) => total + (line.priceexclvat || 0), 0
            );
            revenue += body.lines.reduce((total, line) => {
              if (line.date < boundary) return total + (line.priceexclvat || 0);
              if (line.date > boundary) return total;
              return line.secondOfDay != null && line.secondOfDay <= cutoff
                ? total + (line.priceexclvat || 0) : total;
            }, 0);
          }
        } else {
          for (const body of bodies) {
            const sum = body.lines.reduce((total, line) => total + (line.priceexclvat || 0), 0);
            revenue += sum;
            completeRevenue += sum;
          }
        }
        return {
          responseBytes, pages, rawLines, cacheStatuses,
          revenue, budget: completeRevenue * 1.10,
          browserProcessingMs: performance.now() - processingStart,
        };
      });
      return { ...measured.value, ms: measured.ms, upstreamRequests: upstreamCalls - before };
    }

    const warmSnapshots = {};
    for (const [name, range] of Object.entries(ranges)) {
      warmSnapshots[name] = {
        current: await load('current', range),
        summary: await load('summary', range),
      };
    }

    const report = {};
    for (const [name, range] of Object.entries(ranges)) {
      app.locals.salesRangeCache.clear();
      const coldCurrent = await load('current', range);
      app.locals.salesRangeCache.clear();
      const legacyLy = await load('legacy-ly', range);
      app.locals.revenueSummaryCache.clear();
      const coldSummary = await load('summary', range);
      const repeatSummary = await load('summary', range);

      report[name] = {
        coldCurrent,
        beforeFullLineLy: legacyLy,
        afterColdSummary: coldSummary,
        afterWarmCurrent: warmSnapshots[name].current,
        afterWarmLyAndBudget: warmSnapshots[name].summary,
        repeatedSummary: repeatSummary,
      };
    }

    app.locals.salesRangeCache.clear();
    app.locals.revenueSummaryCache.clear();
    const singleCurrent = await load('current', ranges.Today, ['norrebro']);
    const singleSummary = await load('summary', ranges.Today, ['norrebro']);

    const payloadRatios = Object.fromEntries(Object.entries(report).map(([name, item]) => [
      name,
      1 - item.afterColdSummary.responseBytes / item.beforeFullLineLy.responseBytes,
    ]));

    console.log(JSON.stringify({
      kind: 'deterministic-mocked-onlinepos',
      mockDelayMs: delayMs,
      linesPerExport: 32 * linesPerDay,
      healthWhileWarmingMs: health.ms,
      healthStatus: health.value,
      startupWarmMs: warmed.ms,
      startupUpstreamRequests: startupCalls,
      chain: report,
      singleStoreToday: { current: singleCurrent, lyAndBudget: singleSummary },
      payloadReductionRatios: payloadRatios,
      caches: {
        fullSales: app.locals.salesRangeCache.stats(),
        revenueSummary: app.locals.revenueSummaryCache.stats(),
      },
    }, null, 2));
  } finally {
    await new Promise(resolve => server.close(resolve));
    app.locals.salesRangeCache.clear();
    app.locals.revenueSummaryCache.clear();
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
