'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { parseLeaderboardsRequest, parseRecordsQuestion } = require('../lib/sales-db/records');
const { buildRanking, queryLeaderboards, periodStart, periodNext } = require('../lib/sales-db/records-query');
const { BOARDS, href, parseHash, createClient } = require('../lib/records-leaderboards');
const now = Date.parse('2026-11-20T12:00:00Z');
const day = (date, storeId = 5, more = {}) => ({ date, storeId, status: 'complete', evidence: 'complete-single-pass',
  observedAt: periodNext(date, 'day') + 'T12:00:00Z', revenueExVat: '100', revenueIncl: '125', lineCount: 1, ...more });
const query = (store = 'all') => ({ ...parseLeaderboardsRequest({ store }).scope, period: 'weekend', limit: 5 });

test('structured scope is allowlisted and the manifest has twelve stable leaderboard IDs', () => {
  for (const store of ['all', 'indre-by', 'vesterbro', 'christianshavn', 'fisketorvet', 'frederiksberg', 'norrebro']) assert(parseLeaderboardsRequest({ store }).ok);
  for (const request of [{ store: "x';drop table sales_line" }, { store: ['all'] }, { group: ['lunch'] }, { group: 'anything' }]) assert.equal(parseLeaderboardsRequest(request).ok, false);
  assert.equal(BOARDS.length, 12); assert.equal(new Set(BOARDS.map(b => b.id)).size, 12);
  assert.deepEqual(BOARDS.filter(b => b.weekday).map(b => b.weekday.iso), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(parseRecordsQuestion('Top 5 weekends across the chain').query.period, 'weekend');
});

test('weekends include only Saturday/Sunday and become eligible on Monday, including year and DST boundaries', () => {
  for (const [sat, sun, mon] of [['2022-12-31', '2023-01-01', '2023-01-02'], ['2026-03-28', '2026-03-29', '2026-03-30'], ['2026-10-24', '2026-10-25', '2026-10-26']]) {
    const rows = [day(sat), day(sun), day(periodNext(sun, 'day'), 5, { revenueExVat: '99999' })];
    for (const today of [sat, sun]) assert.deepEqual(buildRanking(rows, [], query('frederiksberg'), today, now).results, []);
    const monday = buildRanking(rows, [], query('frederiksberg'), mon, now);
    assert.equal(monday.results[0].periodStart, sat); assert.equal(monday.results[0].periodEnd, sun);
    assert.equal(monday.results[0].revenueExVat, 200);
    assert.equal(buildRanking(rows, [], query('frederiksberg'), periodNext(mon, 'day'), now).results[0].revenueExVat, 200);
  }
  assert.equal(periodStart('2026-09-01', 'weekend'), '2026-09-05');
  assert.equal(periodStart('2026-09-06', 'weekend'), '2026-09-05');
});

test('missing, pending or uncertain coverage excludes the whole chain weekend; verified closures count as zero', () => {
  const rows = [1, 2, 3, 4, 5, 6].flatMap(id => [day('2026-09-05', id), day('2026-09-06', id)]);
  assert.equal(buildRanking(rows, [], query(), '2026-09-07', now).results[0].revenueExVat, 1200);
  for (const replacement of [null, { ...rows[0], status: 'ZERO_OBSERVED_PENDING_REVIEW' }, { ...rows[0], observedAt: '2026-09-05T12:00:00Z' }]) {
    const result = buildRanking([...rows.slice(1), ...(replacement ? [replacement] : [])], [], query(), '2026-09-07', now);
    assert.deepEqual(result.results, []); assert.equal(result.coverage.excludedPeriods, 1);
  }
  const closed = { ...rows[0], lineCount: 0, status: 'VERIFIED_CLOSED', evidence: 'verified-closed', revenueExVat: '0', revenueIncl: '0' };
  assert.equal(buildRanking([closed, ...rows.slice(1)], [], query(), '2026-09-07', now).results[0].revenueExVat, 1100);
  const sundayOnly = buildRanking([day('2026-09-06')], [], query('frederiksberg'), '2026-09-07', now);
  assert.equal(sundayOnly.coverage.exclusions.missingCoverage.storeDays, 1);
});

test('eleven standard boards use one history read; lunch uses only one extra fact aggregation', async () => {
  const states = [];
  for (let date = '2026-07-01'; date < '2026-10-01'; date = periodNext(date, 'day')) for (let id = 1; id <= 6; id++) states.push(day(date, id));
  const facts = states.map(s => ({ ...s, lunchRevenue: '40', uncertainCount: 0 }));
  let calls = [];
  const session = { query: async sql => { calls.push(sql); return { rows: sql.includes('sales_day_state') ? states : facts }; } };
  const standard = await queryLeaderboards(session, query(), 'standard', '2026-10-01', now);
  assert.equal(calls.length, 1); assert.equal(standard.boards.length, 11);
  for (const board of standard.boards) {
    assert.equal(board.results.length, board.id === 'months' ? 3 : 5);
    for (const record of board.results) {
      assert.equal(record.stores.length, 6);
      if (board.query.weekday) assert.equal(record.weekdayIso, board.query.weekday.iso);
    }
  }
  calls = [];
  const lunch = await queryLeaderboards(session, query(), 'lunch', '2026-10-01', now);
  assert.equal(calls.length, 2); assert.equal(lunch.boards.length, 1);
  assert.equal(lunch.boards[0].results[0].revenueExVat, 240);
  calls = [];
  const empty = await queryLeaderboards({ query: async () => { calls.push(1); return { rows: [] }; } }, query(), 'lunch', '2026-10-01', now);
  assert.equal(calls.length, 1); assert.equal(empty.boards[0].coverage.historyFrom, null);
});

test('stable deep links round-trip scope, category and period, safely normalizing unknown values', () => {
  for (const board of BOARDS) {
    const link = href('norrebro', board.id, '2026-09-05');
    assert.deepEqual(parseHash(link), { store: 'norrebro', board: board.id, date: '2026-09-05' });
  }
  assert.deepEqual(parseHash('#records?store=evil&board=bad&date=2026-02-30'), { store: 'all', board: 'days', date: null });
  assert.equal(parseHash('#elsewhere'), null);
  assert.equal(parseHash('#records-not-a-route'), null);
  assert.equal(href('all', 'weekends', '<script>'), '#records?store=all&board=weekends');
});

test('client coalesces batches, reuses store results and expires at the Copenhagen date boundary or TTL', async () => {
  let calls = 0, clock = 0, today = '2026-09-06';
  const client = createClient({ fetchBatch: async () => ({ sequence: ++calls }), session: () => 1, today: () => today, now: () => clock, ttlMs: 100 });
  await Promise.all([client.load('all', 'standard'), client.load('all', 'standard')]); assert.equal(calls, 1);
  await client.load('vesterbro', 'standard'); await client.load('all', 'standard'); assert.equal(calls, 2);
  await client.load('all', 'lunch'); assert.equal(calls, 3);
  clock = 101; await client.load('all', 'standard'); assert.equal(calls, 4);
  today = '2026-09-07'; await client.load('all', 'standard'); assert.equal(calls, 5);
});

test('failed batches are retryable and stale requests cannot fill a new session or refreshed cache', async () => {
  let calls = 0, session = 1, release;
  const client = createClient({ session: () => session, today: () => '2026-09-06', fetchBatch: async () => {
    calls++; if (calls === 1) throw new Error('offline'); return new Promise(r => { release = r; });
  } });
  await assert.rejects(client.load('all', 'standard'));
  const old = client.load('all', 'standard'); client.clear(); session = 2; release({ old: true });
  assert.equal(await old, null); assert.equal(client.peek('all', 'standard'), null);
  session = null; assert.equal(await client.load('all', 'standard'), null);
  assert.equal(calls, 2);
});

test('client keeps at most fourteen scope/group results and does not persist business data', async () => {
  let today = '2026-09-01';
  const client = createClient({ session: () => 1, today: () => today, fetchBatch: async () => ({ ok: true }) });
  for (let n = 1; n <= 15; n++) { today = `2026-09-${String(n).padStart(2, '0')}`; await client.load('all', 'standard'); }
  today = '2026-09-01'; assert.equal(client.peek('all', 'standard'), null);
  today = '2026-09-15'; assert.deepEqual(client.peek('all', 'standard'), { ok: true });
});
