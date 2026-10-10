'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { disposableConfig } = require('../sales-sync/disposable');
const { createDatabase } = require('../../lib/sales-db/database');
const { migrate } = require('../../lib/sales-db/migrate');
const { createDashboardReader } = require('../../lib/sales-db/dashboard');
const { parseRecordsQuestion, STORES } = require('../../lib/sales-db/records');
const { storeId } = require('../../lib/sales-db/values');

// This suite can only mutate the explicitly named localhost disposable database.
const db = createDatabase(disposableConfig());
const readonly = {
  transaction: work => db.transaction(async session => {
    await session.query('SET LOCAL ROLE records_reader_test');
    return work(session);
  }),
};
const reader = createDashboardReader(readonly);
const today = '2026-09-28';
const ask = question => reader.records(parseRecordsQuestion(question).query, today);
const emptyDigest = createHash('sha256').update('').digest();
const fridayDates = ['2026-07-24', '2026-07-31', '2026-08-07', '2026-08-14',
  '2026-08-21', '2026-08-28', '2026-09-04', '2026-09-11'];
let beforeVersions;
const versions = async () => (await db.query(`SELECT store_id, business_date::text,
  xmin::text, ctid::text FROM sales_foundation.sales_day_state ORDER BY store_id, business_date`)).rows;

// Synthetic summary fixtures obey the real migration constraints. No provider calls.
async function day(slug, date, revenue, status = 'complete', evidence = 'complete-single-pass') {
  const id = storeId(slug), run = randomUUID();
  const count = status === 'complete' && evidence !== 'verified-empty' ? 1 : 0;
  await db.query(`INSERT INTO sales_foundation.sales_sync_run
    (run_id, store_id, start_date, end_date, observed_at, state, published_at, line_count, content_digest)
    VALUES ($1,$2,$3::date,$3::date+1,'2026-10-01T12:00:00Z','published','2026-10-01T12:00:00Z',$4,$5)`,
  [run, id, date, count, emptyDigest]);
  const zeroReview = status !== 'complete';
  const verified = ['independently-verified', 'verified-empty'].includes(evidence);
  if (zeroReview || verified) {
    await db.query(`INSERT INTO sales_foundation.sales_import_scan
      (run_id, store_id, status, terminal, scan_finished_at)
      VALUES ($1,$2,'published',true,'2026-10-01T12:00:00Z')`, [run, id]);
  }
  const reviewed = ['VERIFIED_CLOSED', 'RETRY_REQUIRED'].includes(status);
  await db.query(`INSERT INTO sales_foundation.sales_day_state
    (store_id, business_date, published_run, verified_at, source_observed_at, status, evidence,
     line_count, revenue_incl, revenue_excl, content_digest, verification_run,
     zero_observation_run, zero_reviewed_at, zero_reviewed_by)
    VALUES ($1,$2,$3,'2026-10-01T12:00:00Z','2026-10-01T12:00:00Z',$4,$5,$6,$7,$7,$8,$9,$10,$11,$12)`,
  [id, date, run, status, evidence, count, revenue, emptyDigest, verified ? run : null,
    zeroReview ? run : null, reviewed ? '2026-10-01T12:00:00Z' : null, reviewed ? 'ulv' : null]);
}

before(async () => {
  await db.query('DROP SCHEMA IF EXISTS sales_foundation CASCADE');
  await migrate(db);
  await db.query(fs.readFileSync(path.join(__dirname, '../../docs/operations/dashboard-reader-grants.sql'), 'utf8')
    .replaceAll('kk_sales_dashboard', 'records_reader_test').replace(' LOGIN ', ' NOLOGIN '));
  for (const { slug } of STORES) {
    const id = storeId(slug);
    for (const [index, date] of fridayDates.entries()) await day(slug, date, (index + 1) * 10 + id);
    await day(slug, '2026-08-03', id * 100);
    if (id !== 6) await day(slug, '2026-08-10', 10000); // One missing store disqualifies the date.
    for (const [date, status] of [['2026-08-17', 'ZERO_OBSERVED_PENDING_REVIEW'], ['2026-08-24', 'RETRY_REQUIRED']]) {
      await day(slug, date, id === 6 ? 0 : 10000, id === 6 ? status : 'complete', id === 6 ? 'zero-observed' : 'complete-single-pass');
    }
    await day(slug, '2026-08-31', id === 6 ? 0 : 500, id === 6 ? 'VERIFIED_CLOSED' : 'complete', id === 6 ? 'verified-closed' : 'complete-single-pass');
    await day(slug, '2026-09-07', id === 6 ? 0 : 400, 'complete', id === 6 ? 'verified-empty' : 'complete-single-pass');
    await day(slug, '2026-09-14', id * 100, 'complete', 'independently-verified');
    await day(slug, '2026-09-22', id * 1000);
    await day(slug, '2026-09-23', id === 6 ? -50 : id * 10);
    await day(slug, today, 100000);
    await day(slug, '2026-09-29', 200000);
  }
  beforeVersions = await versions();
});

after(async () => {
  try {
    if (beforeVersions) assert.deepEqual(await versions(), beforeVersions);
    await db.query('DROP OWNED BY records_reader_test; DROP ROLE records_reader_test');
  } finally { await db.close(); }
});

test('Records work with exact dashboard grants while sales_store remains inaccessible', async () => {
  await assert.rejects(readonly.transaction(s => s.query('SELECT slug FROM sales_foundation.sales_store')));
  assert.equal((await reader.ready()).ready, true);
  const [result] = await ask('Best day ever in Frederiksberg');
  assert.equal(result.date, '2026-08-10');
  assert.equal(result.revenueExVat, 10000); // Store queries do not require other stores' coverage.
  assert.deepEqual(result.stores, [{ slug: 'frederiksberg', name: 'Frederiksberg', revenueExVat: 10000 }]);
});

test('best Monday includes approved closure and excludes missing, pending, retry and open days', async () => {
  const [result] = await ask('Best Monday across the chain');
  assert.equal(result.date, '2026-08-31');
  assert.equal(result.weekdayIso, 1);
  assert.equal(result.revenueExVat, 2500);
  assert.equal(result.stores.find(s => s.slug === 'norrebro').revenueExVat, 0);
  const rows = await ask('Top 10 Mondays across the chain');
  assert.deepEqual(rows.map(r => r.date), ['2026-08-31', '2026-08-03', '2026-09-14', '2026-09-07']);
});

test('top five Fridays aggregate exactly six stores on each date with correct ID mapping', async () => {
  const rows = await ask('Top 5 Fridays across the chain');
  assert.deepEqual(rows.map(r => r.date), fridayDates.slice(-5).reverse());
  for (const row of rows) {
    assert.equal(row.weekdayIso, 5);
    assert.deepEqual(row.stores.map(s => s.slug), STORES.map(s => s.slug).sort());
    const base = (fridayDates.indexOf(row.date) + 1) * 10;
    for (const store of row.stores) assert.equal(store.revenueExVat, base + storeId(store.slug));
    assert.equal(row.revenueExVat, row.stores.reduce((sum, store) => sum + store.revenueExVat, 0));
  }
});

test('top ten Nørrebro days respect limit, revenue order, tie order and open-day exclusion', async () => {
  const rows = await ask('Top 10 days in Nørrebro');
  assert.deepEqual(rows.map(r => r.date), ['2026-09-22', '2026-08-03', '2026-09-14', ...fridayDates.slice(1).reverse()]);
  assert(rows.every(r => r.stores.length === 1 && r.stores[0].slug === 'norrebro' && r.date < today));
});

test('refund totals stay signed and an unsupported weekday returns no invented records', async () => {
  const [result] = await ask('Best Wednesday across the chain');
  assert.equal(result.revenueExVat, 100);
  assert.equal(result.stores.find(s => s.slug === 'norrebro').revenueExVat, -50);
  assert.deepEqual(await ask('Best Thursday across the chain'), []);
});

test('Records still reject privileged roles and mismatched migration history', async () => {
  const query = parseRecordsQuestion('Best Monday across the chain').query;
  // Inspect readiness failures inside the session, before the database wrapper
  // deliberately sanitizes them to DB_OPERATION_FAILED at the public boundary.
  await db.transaction(async session => {
    const direct = createDashboardReader({ transaction: work => work(session) });
    await assert.rejects(direct.records(query, today), { code: 'DB_READ_ROLE_REQUIRED' });
  });
  const { rows: [migration] } = await db.query("SELECT checksum FROM sales_foundation.schema_migration WHERE version='001_foundation.sql'");
  try {
    await db.query("UPDATE sales_foundation.schema_migration SET checksum=repeat('0',64) WHERE version='001_foundation.sql'");
    await readonly.transaction(async session => {
      const direct = createDashboardReader({ transaction: work => work(session) });
      await assert.rejects(direct.records(query, today), { code: 'DB_SCHEMA_NOT_READY' });
    });
  } finally {
    await db.query("UPDATE sales_foundation.schema_migration SET checksum=$1 WHERE version='001_foundation.sql'", [migration.checksum]);
  }
});
