'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path');
const { disposableConfig } = require('../sales-sync/disposable');
const { createDatabase } = require('../../lib/sales-db/database');
const { migrate } = require('../../lib/sales-db/migrate');
const { createRepository } = require('../../lib/sales-db/repository');
const { createDashboardReader } = require('../../lib/sales-db/dashboard');
const { parseRecordsQuestion, STORES } = require('../../lib/sales-db/records');
const { storeId } = require('../../lib/sales-db/values');
const { context, line } = require('./helpers');
const db = createDatabase(disposableConfig()), repo = createRepository(db, context);
const readonly = { transaction: work => db.transaction(async session => {
  await session.query('SET LOCAL ROLE records_period_reader_test'); return work(session);
}) };
const reader = createDashboardReader(readonly);
const next = date => new Date(Date.parse(date + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
const ask = (question, today = '2024-03-06') => reader.records(parseRecordsQuestion(question).query, today, Date.parse(today + 'T12:00:00Z'));
let sequence = 0;
function fact(slug, date, time, revenue, source = 'payment') {
  return line({ storeSlug: slug, sourceLineId: 'records-period-' + sequence++, businessDate: date,
    saleLocal: time === null ? null : `${date} ${time}`, timeSource: source,
    revenueIncl: String(revenue * 1.25), revenueExcl: String(revenue) });
}
async function publish(slug, start, end, lines) {
  const runId = randomUUID(), observedAt = next(end) + 'T10:00:00.000Z';
  await repo.publishCompletedRun({ runId, storeSlug: slug, start, end, observedAt, complete: true, expectedLineCount: lines.length, lines });
  return runId;
}
async function markZero(slug, date, status) {
  const id = storeId(slug);
  const { rows: [day] } = await db.query('SELECT published_run, source_observed_at FROM sales_foundation.sales_day_state WHERE store_id=$1 AND business_date=$2', [id, date]);
  await db.query(`INSERT INTO sales_foundation.sales_import_scan (run_id,store_id,status,terminal,scan_finished_at)
    VALUES ($1,$2,'published',true,$3) ON CONFLICT DO NOTHING`, [day.published_run, id, day.source_observed_at]);
  await db.query(`UPDATE sales_foundation.sales_day_state SET status=$3,evidence=$4,zero_observation_run=published_run,
    zero_reviewed_at=$5,zero_reviewed_by=$6 WHERE store_id=$1 AND business_date=$2`,
  [id, date, status, status === 'VERIFIED_CLOSED' ? 'verified-closed' : 'zero-observed',
    status === 'ZERO_OBSERVED_PENDING_REVIEW' ? null : day.source_observed_at, status === 'ZERO_OBSERVED_PENDING_REVIEW' ? null : 'ulv']);
}
const versions = async () => {
  const rows = [];
  for (const table of ['sales_line', 'sales_day_state']) rows.push((await db.query(`SELECT xmin::text,ctid::text FROM sales_foundation.${table} ORDER BY ctid`)).rows);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
};

before(async () => {
  await db.query('DROP SCHEMA IF EXISTS sales_foundation CASCADE'); await migrate(db);
  await db.query(fs.readFileSync(path.join(__dirname, '../../docs/operations/dashboard-reader-grants.sql'), 'utf8')
    .replaceAll('kk_sales_dashboard', 'records_period_reader_test').replace(' LOGIN ', ' NOLOGIN '));
  for (const { slug } of STORES) {
    for (const [start, end] of [['2024-01-01', '2024-02-01'], ['2024-02-01', '2024-03-01']]) {
      const lines = [];
      for (let date = start; date < end; date = next(date)) {
        if (slug === 'christianshavn' && date === '2024-02-06') continue; // Verified closure below.
        lines.push(fact(slug, date, '11:00:00', storeId(slug) * 10 + Number(date.slice(-2))),
          fact(slug, date, '15:59:59', 3), fact(slug, date, '15:00:00', -1),
          fact(slug, date, '16:00:00', 100), fact(slug, date, '19:00:00', 5));
        if (slug === 'frederiksberg' && date === '2024-02-24') lines.push(fact(slug, date, '13:00:00', 1000, 'fallback'));
        if (slug === 'frederiksberg' && date === '2024-02-25') lines.push(fact(slug, date, null, 0, 'missing'));
      }
      await publish(slug, start, end, lines);
    }
    await publish(slug, '2024-03-04', '2024-03-05', [fact(slug, '2024-03-04', '17:00:00', 100000)]);
  }
  await markZero('christianshavn', '2024-02-06', 'VERIFIED_CLOSED');
  // A missing state with real facts must never be interpreted as an eligible zero.
  await db.query("DELETE FROM sales_foundation.sales_day_state WHERE store_id=2 AND business_date='2024-01-15'");
  await publish('frederiksberg', '2023-10-29', '2023-10-30', [fact('frederiksberg', '2023-10-29', '02:30:00', 100000)]);
  await publish('vesterbro', '2023-10-29', '2023-10-30', [fact('vesterbro', '2023-10-29', '02:30:00', 100000, 'fallback')]);
  await publish('frederiksberg', '2024-03-31', '2024-04-01', [fact('frederiksberg', '2024-03-31', '03:30:00', 90), fact('frederiksberg', '2024-03-31', '16:00:00', 10)]);
});
after(async () => { try { await db.query('DROP OWNED BY records_period_reader_test; DROP ROLE records_period_reader_test'); } finally { await db.close(); } });

test('daily, weekly and monthly store/chain queries reconcile to transaction facts without changing row versions', async () => {
  const before = await versions();
  for (const question of ['Best day in Vesterbro', 'Best Friday across the chain', 'Best week in Vesterbro',
    'Top 5 weeks across the chain', 'Top 10 months in Nørrebro', 'Best month ever across the chain']) {
    const response = await ask(question);
    assert(response.results.length > 0, question);
    for (const result of response.results) {
      let total = 0;
      for (const store of result.stores) {
        const { rows: [sum] } = await db.query(`SELECT coalesce(sum(revenue_excl),0)::text AS revenue
          FROM sales_foundation.sales_line WHERE store_id=$1 AND business_date BETWEEN $2 AND $3`, [storeId(store.slug), result.periodStart, result.periodEnd]);
        assert.equal(store.revenueExVat, Number(sum.revenue), question);
        total += store.revenueExVat;
      }
      assert.equal(result.revenueExVat, total);
      if (question.includes('chain')) assert.equal(result.stores.length, 6);
    }
  }
  assert.equal(await versions(), before);
});

test('chain months reject the missing January store-day and include all 29 February dates and a verified closure', async () => {
  const response = await ask('Best month ever across the chain');
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].periodStart, '2024-02-01'); assert.equal(response.results[0].periodEnd, '2024-02-29');
  assert.equal(response.coverage.cutoffExclusive, '2024-03-01');
  assert(response.coverage.excludedExamples.some(p => p.periodStart === '2024-01-01' && p.reasons.some(r => r.code === 'missingCoverage')));
  const store = await ask('Top 10 months in Nørrebro');
  assert.deepEqual(store.results.map(r => r.periodStart), ['2024-01-01', '2024-02-01']);
});

test('lunch uses line times before 16:00, retains refunds and rejects fallback, missing and DST-ambiguous dates', async () => {
  for (const question of ['Best lunch ever in Frederiksberg', 'Best Friday lunch across the chain']) {
    const response = await ask(question);
    assert.equal(response.results.length, 1);
    for (const store of response.results[0].stores) {
      const { rows: [sum] } = await db.query(`SELECT sum(revenue_excl)::text AS revenue FROM sales_foundation.sales_line
        WHERE store_id=$1 AND business_date=$2 AND sale_local::time < time '16:00'`, [storeId(store.slug), response.results[0].date]);
      assert.equal(store.revenueExVat, Number(sum.revenue));
      assert.equal(store.revenueExVat, storeId(store.slug) * 10 + Number(response.results[0].date.slice(-2)) + 2);
    }
  }
  const all = await ask('Top 10 lunch days in Frederiksberg');
  assert.equal(all.results.length, 10);
  assert.equal(all.coverage.exclusions.timestampUncertainty.periods, 3);
  assert.equal(all.coverage.timing.missingLines, 1); assert.equal(all.coverage.timing.fallbackLines, 1);
  assert.equal(all.coverage.timing.ambiguousLines, 1);
  assert(!all.results.some(r => ['2023-10-29', '2024-02-24', '2024-02-25'].includes(r.date)));
  const fallbackAmbiguous = await ask('Best Sunday lunch in Vesterbro');
  assert.equal(fallbackAmbiguous.coverage.timing.fallbackLines, 1);
  assert.equal(fallbackAmbiguous.coverage.timing.ambiguousLines, 1);
});

test('spring DST valid local timestamps are assignable; nonexistent local times are rejected', async () => {
  assert.throws(() => fact('frederiksberg', '2024-03-31', '02:30:00', 100));
  const result = await ask('Best Sunday lunch in Frederiksberg', '2024-04-03');
  assert.equal(result.results[0].date, '2024-03-31'); assert.equal(result.results[0].revenueExVat, 90);
});

test('pending and retry closures exclude the whole week/month/chain lunch and restore safely to verified closure', async () => {
  for (const status of ['ZERO_OBSERVED_PENDING_REVIEW', 'RETRY_REQUIRED']) {
    try {
      await markZero('christianshavn', '2024-02-06', status);
      for (const question of ['Best month across the chain', 'Best week across the chain', 'Best Tuesday lunch across the chain']) {
        const response = await ask(question);
        assert.equal(response.coverage.exclusions.unverifiedCoverage.storeDays, 1);
        assert(!response.results.some(r => r.periodStart <= '2024-02-06' && r.periodEnd >= '2024-02-06'));
      }
    } finally { await markZero('christianshavn', '2024-02-06', 'VERIFIED_CLOSED'); }
  }
});

test('a line-count or amount mismatch excludes lunch, instead of returning a plausible partial total', async () => {
  try {
    await db.query("UPDATE sales_foundation.sales_day_state SET line_count=line_count+1 WHERE store_id=5 AND business_date='2024-01-31'");
    const response = await ask('Best lunch in Frederiksberg');
    assert.equal(response.coverage.exclusions.factsMismatch.storeDays, 1);
    assert.notEqual(response.results[0].date, '2024-01-31');
  } finally { await db.query("UPDATE sales_foundation.sales_day_state SET line_count=line_count-1 WHERE store_id=5 AND business_date='2024-01-31'"); }
  await assert.rejects(readonly.transaction(s => s.query('SELECT source_key FROM sales_foundation.sales_line')));
  await assert.rejects(readonly.transaction(s => s.query('SELECT slug FROM sales_foundation.sales_store')));
  await assert.rejects(readonly.transaction(s => s.query('UPDATE sales_foundation.sales_day_state SET line_count=0')));
});
