'use strict';

// Deterministic local benchmark: no credentials and no network calls.
// Usage: node scripts/benchmark-sales-cache.js [mock-delay-ms]

const { performance } = require('node:perf_hooks');
const { createSalesRangeCache } = require('../lib/sales-range-cache');

const delayMs = Number(process.argv[2] || 250);
const stores = ['indre-by', 'vesterbro', 'christianshavn', 'fisketorvet', 'frederiksberg', 'norrebro'];

function nextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

const today = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Copenhagen' }).format(new Date());
const tomorrow = nextDay(today);
const todayDate = new Date(today + 'T12:00:00Z');
const weekday = todayDate.getUTCDay();
const mondayDate = new Date(todayDate);
mondayDate.setUTCDate(todayDate.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
const monday = mondayDate.toISOString().slice(0, 10);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const resultFor = (start, end) => ({
  lines: [{ priceexclvat: 100 }],
  meta: {
    complete: true, pages: 1, rawLineCount: 1, processedLineCount: 1,
    conflicts: [], start, end,
  },
});

function makeUpstream() {
  let calls = 0;
  return {
    fetch: async ({ start, end }) => {
      calls++;
      await sleep(delayMs);
      return resultFor(start, end);
    },
    calls: () => calls,
  };
}

async function timed(fn) {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

async function runScenario(useCache, steps) {
  const upstream = makeUpstream();
  const cache = useCache ? createSalesRangeCache({ fetchRange: upstream.fetch }) : null;
  const get = args => cache ? cache.get(args) : upstream.fetch(args);
  const times = [];
  for (const step of steps) times.push(await timed(() => step(get)));
  return { times, calls: upstream.calls() };
}

const allStores = (start, end) => get => Promise.all(
  stores.map(storeId => get({ storeId, store: {}, start, end }))
);
const oneStore = (storeId, start, end) => get => get({ storeId, store: {}, start, end });
const concurrentSame = get => Promise.all(
  Array.from({ length: 5 }, () => get({ storeId: 'norrebro', store: {}, start: today, end: tomorrow }))
);

async function compare(name, steps, labels) {
  const before = await runScenario(false, steps);
  const after = await runScenario(true, steps);
  const fmt = values => values.map((v, i) => `${labels[i]}=${v.toFixed(1)}ms`).join(', ');
  console.log(`${name}\n  before: ${fmt(before.times)}; upstream calls=${before.calls}`);
  console.log(`  after:  ${fmt(after.times)}; upstream calls=${after.calls}`);
}

async function main() {
  console.log(`Mock OnlinePOS delay: ${delayMs}ms per range`);
  await compare('Cold initial view', [allStores(today, tomorrow)], ['cold']);
  await compare('Repeated same view', [allStores(today, tomorrow), allStores(today, tomorrow)], ['cold', 'repeat']);
  await compare('Today → This Week → Today', [
    allStores(today, tomorrow), allStores(monday, tomorrow), allStores(today, tomorrow),
  ], ['today', 'week', 'today-again']);
  await compare('Switch stores and return', [
    oneStore('norrebro', today, tomorrow),
    oneStore('vesterbro', today, tomorrow),
    oneStore('norrebro', today, tomorrow),
  ], ['norrebro', 'vesterbro', 'norrebro-again']);
  await compare('Simultaneous identical requests', [concurrentSame], ['five-call burst']);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
