'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDatabase } = require('../../lib/sales-db/database');
const { migrate, MIGRATION_LOCK } = require('../../lib/sales-db/migrate');
const { createRepository } = require('../../lib/sales-db/repository');
const { createIdentity } = require('../../lib/sales-db/identity');
const { createSafeLine, createReviewedCatalog } = require('../../lib/sales-db/facts');
const { computeMetrics } = require('../../lib/product-metrics');
const { context, line, run, request } = require('./helpers');

// Destructive schema resets are allowed ONLY on this explicit disposable target.
// No fallback to production DATABASE_URL, no skipped/mock integration suite.
const connectionString = process.env.KK_TEST_DATABASE_URL;
let target;
try { target = new URL(connectionString); } catch { throw new Error('Disposable PostgreSQL test URL required'); }
if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/kk_foundation_test' ||
    target.username !== 'foundation_test' || target.search || !['postgres:', 'postgresql:'].includes(target.protocol)) {
  throw new Error('Refusing non-disposable PostgreSQL target');
}
const config = { enabled: true, connectionString };
const db = createDatabase(config);
const independent = createDatabase(config);
const repository = createRepository(db, context);
const migrationDir = path.join(__dirname, '../../migrations/sales-db');
const rejected = promise => assert.rejects(promise, { name: 'FoundationError' });
async function count(table) {
  const allowed = ['sales_store', 'sales_line', 'sales_sync_run', 'sales_stage_line', 'sales_day_state', 'schema_migration', 'identity_key_check'];
  assert.ok(allowed.includes(table));
  return Number((await db.query(`SELECT count(*)::text AS count FROM sales_foundation.${table}`)).rows[0].count);
}
before(async () => {
  const { rows } = await db.query("SELECT current_setting('server_version') AS version, current_setting('server_version_num')::int AS number");
  assert.ok(rows[0].number >= 160000 && rows[0].number < 170000, 'PostgreSQL 16 required');
  console.log(`Real PostgreSQL integration server: ${rows[0].version}`);
  if (process.env.CI) {
    const logging = await db.query("SELECT current_setting('log_min_messages') AS messages, current_setting('log_min_error_statement') AS statements");
    assert.equal(logging.rows[0].messages, 'panic');
    assert.equal(logging.rows[0].statements, 'panic');
  }
});
beforeEach(async () => {
  await db.query('DROP SCHEMA IF EXISTS sales_foundation CASCADE');
  await migrate(db);
});
after(async () => {
  await Promise.all([db.close(), independent.close()]);
  assert.equal(db.health().total, 0); assert.equal(independent.health().total, 0);
});

test('empty bootstrap creates six stores and three exact checksum-ledger entries', async () => {
  assert.equal(await count('sales_store'), 6);
  assert.deepEqual((await db.query('SELECT version, checksum FROM sales_foundation.schema_migration ORDER BY version')).rows,
    require('./migration-checksums.json'));
  for (const table of ['sales_line', 'sales_stage_line', 'sales_day_state', 'sales_sync_run', 'identity_key_check']) assert.equal(await count(table), 0);
});
test('repeated migrations are an exact no-op', async () => {
  const before = (await db.query('SELECT * FROM sales_foundation.schema_migration ORDER BY version')).rows;
  assert.deepEqual(await migrate(db), { applied: 0, total: 3 });
  assert.deepEqual((await db.query('SELECT * FROM sales_foundation.schema_migration ORDER BY version')).rows, before);
});
test('migration 003 widens only payment-code validation and preserves existing facts and staging', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-migration-upgrade-'));
  try {
    for (const name of ['001_foundation.sql', '002_backfill.sql']) {
      await fs.copyFile(path.join(migrationDir, name), path.join(temp, name));
    }
    await db.query('DROP SCHEMA sales_foundation CASCADE');
    assert.deepEqual(await migrate(db, temp), { applied: 2, total: 2 });
    const published = run(); await repository.publishCompletedRun(published);
    await db.query('INSERT INTO sales_foundation.sales_stage_line SELECT l.*, $1::uuid, 1, 0 FROM sales_foundation.sales_line l', [published.runId]);
    const snapshot = async () => ({
      facts: (await db.query('SELECT * FROM sales_foundation.sales_line')).rows,
      staging: (await db.query('SELECT * FROM sales_foundation.sales_stage_line')).rows,
      coverage: (await db.query('SELECT * FROM sales_foundation.sales_day_state')).rows,
    });
    const before = await snapshot();
    for (const table of ['sales_line', 'sales_stage_line']) {
      await rejected(db.query(`UPDATE sales_foundation.${table} SET payment_code = $1`, ['mixed 1']));
    }
    assert.deepEqual(await migrate(db), { applied: 1, total: 3 });
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await migrate(db), { applied: 0, total: 3 });
    assert.deepEqual(await snapshot(), before);
    for (const table of ['sales_line', 'sales_stage_line']) {
      await db.query(`UPDATE sales_foundation.${table} SET payment_code = $1`, ['mixed 1']);
      assert.equal((await db.query(`SELECT payment_code FROM sales_foundation.${table}`)).rows[0].payment_code, 'mixed 1');
      for (const invalid of ['', 'x'.repeat(65), 'mixed\t1', 'mixed\n1', 'mixed/1', 'mixed\u00a01']) {
        await rejected(db.query(`UPDATE sales_foundation.${table} SET payment_code = $1`, [invalid]));
      }
    }
  } finally { await fs.rm(temp, { recursive: true }); }
});
test('reviewed spaced payment codes round-trip through foundation publication unchanged', async () => {
  const ctx = { identity: context.identity, catalog: createReviewedCatalog({
    products: [{ storeSlug: 'norrebro', productId: 'synthetic-product', productLabel: 'Synthetic product',
      groupId: 'synthetic-group', groupLabel: 'Synthetic group' }],
    payments: [{ paymentType: 'Synthetic payment', paymentCode: 'mixed 1' }],
  }) };
  const repo = createRepository(db, ctx);
  await repo.publishCompletedRun(run([line({ paymentCode: 'mixed 1' }, ctx)]));
  const saved = (await repo.lines(request)).lines;
  assert.equal(saved.length, 1); assert.equal(saved[0].paymentCode, 'mixed 1');
  assert.equal(saved[0].revenueExcl, '8');
});
test('concurrent independent migration sessions serialize empty bootstrap', async () => {
  await db.query('DROP SCHEMA sales_foundation CASCADE');
  const results = await Promise.all([migrate(db), migrate(independent)]);
  assert.equal(results.reduce((sum, r) => sum + r.applied, 0), 3);
  assert.equal(await count('sales_store'), 6);
});
test('migration runner waits on the real advisory lock and releases it at commit', async () => {
  let unblock;
  let locked;
  const acquired = new Promise(resolve => { locked = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  const holder = db.transaction(async session => {
    await session.query('SELECT pg_advisory_xact_lock($1, $2)', MIGRATION_LOCK);
    locked(); await gate;
  });
  await acquired;
  let finished = false;
  const waiting = migrate(independent).then(result => { finished = true; return result; });
  try {
    let observedWait = false;
    for (let i = 0; i < 30 && !observedWait; i++) {
      const { rows } = await db.query(`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event = 'advisory' AND pid <> pg_backend_pid()`);
      observedWait = rows[0].count > 0;
      if (!observedWait) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(observedWait, true); assert.equal(finished, false);
  } finally { unblock(); await holder; await waiting; }
  const result = await independent.transaction(session => session.query('SELECT pg_try_advisory_xact_lock($1, $2) AS acquired', MIGRATION_LOCK));
  assert.equal(result.rows[0].acquired, true);
});
test('changed applied migration checksum fails closed', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-migration-check-'));
  try {
    const name = '001_foundation.sql';
    await fs.writeFile(path.join(temp, name), await fs.readFile(path.join(migrationDir, name), 'utf8') + '\n-- changed\n');
    await assert.rejects(migrate(db, temp), { code: 'MIGRATION_MISMATCH' });
    assert.equal(await count('schema_migration'), 3);
  } finally { await fs.rm(temp, { recursive: true }); }
});
test('failed migration rolls back schema and ledger and frees migration lock', async () => {
  await db.query('DROP SCHEMA sales_foundation CASCADE');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-migration-fail-'));
  try {
    await fs.writeFile(path.join(temp, '001_failure.sql'), 'CREATE TABLE sales_foundation.transient (id int); SELECT missing_synthetic_function();');
    await rejected(migrate(db, temp));
    assert.equal((await db.query("SELECT to_regnamespace('sales_foundation') IS NULL AS absent")).rows[0].absent, true);
    assert.equal((await migrate(independent)).applied, 3);
  } finally { await fs.rm(temp, { recursive: true }); }
});
test('PK, FK, typed state, bounds and fact check constraints are enforced', async () => {
  const published = run(); await repository.publishCompletedRun(published);
  const mutations = [
    'INSERT INTO sales_foundation.sales_line SELECT * FROM sales_foundation.sales_line',
    'UPDATE sales_foundation.sales_line SET store_id = 99',
    'UPDATE sales_foundation.sales_line SET store_id = 5',
    "UPDATE sales_foundation.sales_line SET source_key = decode('01', 'hex')",
    'UPDATE sales_foundation.sales_line SET key_version = 0',
    'UPDATE sales_foundation.sales_line SET revenue_excl = NULL',
    'UPDATE sales_foundation.sales_line SET second_of_day = 86400',
    "UPDATE sales_foundation.sales_line SET business_date = '1999-01-01'",
    "UPDATE sales_foundation.sales_line SET business_date = '2026-09-19'",
    "UPDATE sales_foundation.sales_line SET time_quality = 'invented'",
    "UPDATE sales_foundation.sales_line SET reconciliation_state = 'deleted'",
    'UPDATE sales_foundation.sales_sync_run SET end_date = start_date',
    "UPDATE sales_foundation.sales_sync_run SET state = 'published', published_at = NULL",
    'UPDATE sales_foundation.sales_day_state SET published_run = gen_random_uuid()',
  ];
  for (const sql of mutations) await rejected(db.query(sql));
  assert.equal(await count('sales_line'), 1);
});
for (const value of ['NaN', 'Infinity', '-Infinity', '100000000000000000000', '0.0000000000000000001']) {
  test('PostgreSQL rejects unsupported numeric values without rounding', async () => {
    await rejected(db.query('SELECT $1::sales_foundation.exact_amount', [value]));
  });
}
test('numeric, fractional-øre and signed quantity round trips remain exact strings', async () => {
  await repository.publishCompletedRun(run([line({ quantity: '-3.125', revenueIncl: '-12.123456789012345678', revenueExcl: '-8.004' })]));
  const result = await repository.lines(request);
  assert.equal(result.lines[0].quantity, '-3.125');
  assert.equal(result.lines[0].revenueIncl, '-12.123456789012345678');
  assert.equal(result.lines[0].revenueExcl, '-8.004');
  assert.equal((await repository.summary(request)).revenueExcl, '-8.004');
});
test('same protected source identity is isolated between stores', async () => {
  await repository.publishCompletedRun(run());
  await repository.publishCompletedRun(run([line({ storeSlug: 'vesterbro', revenueExcl: '99' })], { storeSlug: 'vesterbro' }));
  assert.equal((await repository.summary(request)).revenueExcl, '8');
  assert.equal((await repository.summary({ ...request, storeSlug: 'vesterbro' })).revenueExcl, '99');
  assert.equal(await count('sales_line'), 2);
});
test('distinct identities preserve independent identical-looking purchases', async () => {
  await repository.publishCompletedRun(run([line(), line({ sourceLineId: 'synthetic-line-2' })]));
  const result = await repository.summary(request);
  assert.equal(result.lineCount, '2'); assert.equal(result.revenueExcl, '16');
});
test('same-run and overlapping completed-run publication are idempotent', async () => {
  const first = run();
  assert.equal((await repository.publishCompletedRun(first)).published, true);
  assert.equal((await repository.publishCompletedRun(first)).published, false);
  const before = (await db.query('SELECT xmin::text FROM sales_foundation.sales_line')).rows[0].xmin;
  await repository.publishCompletedRun(run());
  assert.equal(await count('sales_line'), 1); assert.equal(await count('sales_stage_line'), 0);
  assert.equal((await db.query('SELECT xmin::text FROM sales_foundation.sales_line')).rows[0].xmin, before);
});
test('same-ID copies deduplicate only when safe contents match', async () => {
  await repository.publishCompletedRun(run([line(), line()], { expectedLineCount: 1 }));
  assert.equal(await count('sales_line'), 1);
  await assert.rejects(repository.publishCompletedRun(run([line(), line({ revenueExcl: '9' })])), { code: 'SOURCE_CONFLICT' });
  assert.equal(await count('sales_sync_run'), 1);
});
test('changed prior identity and missing old identities cannot silently reconcile', async () => {
  await repository.publishCompletedRun(run());
  await assert.rejects(repository.publishCompletedRun(run([line({ revenueExcl: '9' })])), { code: 'RECONCILIATION_REQUIRED' });
  await assert.rejects(repository.publishCompletedRun(run([])), { code: 'INCOMPLETE_PUBLICATION' });
  assert.equal((await repository.summary(request)).revenueExcl, '8');
});
test('concurrent independent publications keep facts and coverage consistent', async () => {
  const other = createRepository(independent, context);
  const results = await Promise.allSettled([repository.publishCompletedRun(run()), other.publishCompletedRun(run())]);
  assert.ok(results.every(result => result.status === 'fulfilled' && result.value.published));
  assert.equal(await count('sales_line'), 1);
  assert.equal(await count('sales_sync_run'), 2);
  assert.equal((await repository.summary(request)).revenueExcl, '8');
});

test('run UUID reuse with different contents fails closed', async () => {
  const first = run(); await repository.publishCompletedRun(first);
  await assert.rejects(repository.publishCompletedRun({ ...first, lines: [line({ revenueExcl: '9' })] }), { code: 'RUN_CONFLICT' });
});
test('incomplete, mismatched-count, wrong-store, invalid-date and open-day runs cannot publish', async () => {
  const cases = [run([], { complete: false }), run([], { expectedLineCount: 1 }),
    run([line({ storeSlug: 'vesterbro' })]), run([], { start: '2026-02-30' }),
    run([], { observedAt: '2026-09-20T12:00:00.000Z' })];
  for (const invalid of cases) await rejected(repository.publishCompletedRun(invalid));
  assert.equal(await count('sales_sync_run'), 0); assert.equal(await count('sales_day_state'), 0);
});
test('staging failure atomically rolls back facts, coverage, metadata and key binding', async () => {
  await db.query(`CREATE FUNCTION sales_foundation.reject_stage() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'SYNTHETIC_PRIVATE_CANARY'; END $$;
    CREATE TRIGGER reject_stage BEFORE INSERT ON sales_foundation.sales_stage_line
    FOR EACH ROW EXECUTE FUNCTION sales_foundation.reject_stage()`);
  await assert.rejects(repository.publishCompletedRun(run()), { code: 'DB_OPERATION_FAILED', message: 'DB_OPERATION_FAILED' });
  for (const table of ['sales_line', 'sales_stage_line', 'sales_day_state', 'sales_sync_run', 'identity_key_check']) assert.equal(await count(table), 0);
});
test('late coverage failure rolls back already inserted facts and preserves previous snapshot', async () => {
  await repository.publishCompletedRun(run());
  await db.query(`CREATE FUNCTION sales_foundation.reject_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'SYNTHETIC_PRIVATE_CANARY'; END $$;
    CREATE TRIGGER reject_coverage BEFORE INSERT OR UPDATE ON sales_foundation.sales_day_state
    FOR EACH ROW EXECUTE FUNCTION sales_foundation.reject_coverage()`);
  await rejected(repository.publishCompletedRun(run([line(), line({ sourceLineId: 'synthetic-line-2' })])));
  assert.equal(await count('sales_line'), 1); assert.equal(await count('sales_sync_run'), 1);
  assert.equal(await count('sales_stage_line'), 0);
  assert.equal((await repository.summary(request)).revenueExcl, '8');
});
test('complete-empty coverage yields exact zero; never-synchronized coverage yields null', async () => {
  const missing = await repository.summary(request);
  assert.equal(missing.revenueExcl, null); assert.equal(missing.coverage.complete, false);
  assert.equal(missing.coverage.days[0].status, 'never-synchronized');
  await repository.publishCompletedRun(run([]));
  const empty = await repository.summary(request);
  assert.equal(empty.revenueExcl, '0'); assert.equal(empty.lineCount, '0'); assert.equal(empty.coverage.complete, true);
  assert.equal((await repository.summary({ ...request, end: '2026-09-22' })).revenueExcl, null);
});
test('identity key or version changes reject reads and publication without duplicate facts', async () => {
  await repository.publishCompletedRun(run());
  for (const identity of [createIdentity({ key: Buffer.alloc(32, 8), version: 1 }), createIdentity({ key: Buffer.alloc(32, 7), version: 2 })]) {
    const changed = { ...context, identity };
    const other = createRepository(independent, changed);
    await assert.rejects(other.summary(request), { code: 'IDENTITY_MISMATCH' });
    await assert.rejects(other.publishCompletedRun(run([line({}, changed)])), { code: 'IDENTITY_MISMATCH' });
  }
  assert.equal(await count('sales_line'), 1);
});
test('bounded safe reads expose coverage and pagination without protected identities', async () => {
  await repository.publishCompletedRun(run([line(), line({ sourceLineId: 'synthetic-line-2' })]));
  const result = await repository.lines({ ...request, limit: 1 });
  assert.equal(result.hasMore, true); assert.equal(result.lines.length, 1);
  assert.equal((await repository.lines({ ...request, limit: 1, offset: 1 })).hasMore, false);
  for (const field of ['sourceKey', 'sourceLineId', 'keyVersion', 'fingerprint', 'lastSeenRun']) assert.equal(Object.hasOwn(result.lines[0], field), false);
  await rejected(repository.lines({ ...request, limit: 1001 }));
});
test('Copenhagen DST ambiguity, midnight and missing-time semantics survive PostgreSQL', async () => {
  // Use a completed past transition day; no clock override is needed.
  const past = '2025-10-26';
  const lines = [line({ businessDate: past, saleLocal: `${past} 02:30:00` }),
    line({ sourceLineId: 'synthetic-midnight', businessDate: past, saleLocal: `${past} 00:00:00` }),
    line({ sourceLineId: 'synthetic-missing', businessDate: past, saleLocal: null, timeSource: 'missing' })];
  await repository.publishCompletedRun(run(lines, { start: past, end: '2025-10-27', observedAt: '2025-10-27T12:00:00.000Z' }));
  const result = await repository.lines({ storeSlug: 'norrebro', start: past, end: '2025-10-27' });
  assert.equal(result.lines.filter(l => l.timeQuality === 'payment_ambiguous').length, 1);
  assert.equal(result.lines.filter(l => l.secondOfDay === 0).length, 1);
  assert.equal(result.lines.filter(l => l.timeQuality === 'missing').length, 1);
  await rejected(db.query(`UPDATE sales_foundation.sales_line SET sale_local = '2025-03-30 02:30:00',
    business_date = '2025-03-30', second_of_day = 9000, time_quality = 'payment'`));
});
test('prohibited-field canaries never persist or appear in public serialization or errors', async () => {
  const fields = ['customer', 'card', 'clerk', 'employee', 'account', 'order', 'orderlineid', 'rawResponse', 'credentials', 'freeText'];
  for (const field of fields) {
    await rejected(repository.publishCompletedRun(run([{ ...line(), [field]: 'SYNTHETIC_PRIVATE_CANARY' }])));
  }
  await repository.publishCompletedRun(run([line({ sourceLineId: 'SYNTHETIC_PRIVATE_CANARY' })]));
  const serialized = JSON.stringify(await repository.lines(request));
  assert.ok(!serialized.includes('SYNTHETIC_PRIVATE_CANARY'));
  for (const table of ['sales_line', 'sales_stage_line', 'sales_sync_run', 'sales_day_state']) {
    const result = await db.query(`SELECT coalesce(bool_or(row_to_json(t)::text LIKE $1), false) AS leaked
      FROM sales_foundation.${table} t`, ['%SYNTHETIC_PRIVATE_CANARY%']);
    assert.equal(result.rows[0].leaked, false);
  }
  const columns = await db.query(`SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'sales_foundation'`);
  assert.ok(columns.rows.every(row => !['json', 'jsonb'].includes(row.data_type)));
  assert.ok(columns.rows.every(row => !/customer|card|clerk|employee|account|order|credential|password|raw_response/.test(row.column_name)));
});
test('independent sessions and pool cleanup release connections after failures', async () => {
  const one = createDatabase(config); const two = createDatabase(config);
  let pid1; let pid2;
  try {
    await Promise.all([
      one.withSession(async session => { pid1 = (await session.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; }),
      two.withSession(async session => { pid2 = (await session.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; }),
    ]);
    assert.notEqual(pid1, pid2);
    await rejected(one.transaction(session => session.query('SELECT missing_synthetic_function()')));
    assert.equal((await one.query('SELECT 1 AS n')).rows[0].n, 1);
    assert.equal(one.health().waiting, 0); assert.ok(one.health().total <= 2);
  } finally { await Promise.all([one.close(), two.close()]); }
  const result = await db.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = ANY($1::int[])', [[pid1, pid2]]);
  assert.equal(result.rows[0].count, 0);
  await assert.rejects(one.query('SELECT 1'), { code: 'DB_UNAVAILABLE' });
});

test('unchanged anonymized reference fixture preserves exact totals and canonical product metrics', async () => {
  const fixture = require('../fixtures/norrebro-2026-09-20.fixture.json');
  // Checked-in, explicitly reviewed fixture catalog. Never learn labels from input.
  const reviewed = require('./reviewed-fixture-catalog.json');
  const ctx = { identity: context.identity, catalog: createReviewedCatalog(reviewed) };
  const repo = createRepository(db, ctx);
  const lines = fixture.lines.map(item => createSafeLine({
    storeSlug: 'norrebro', sourceLineId: item.line_id, businessDate: item.date,
    saleLocal: null, timeSource: 'missing', productId: String(item.productid), productLabel: item.productname,
    groupId: null, groupLabel: item.productgroup, quantity: String(item.count), revenueIncl: String(item.price),
    revenueExcl: String(item.priceexclvat), paymentType: item.paymenttype, paymentCode: null,
  }, ctx));
  await repo.publishCompletedRun(run(lines));
  const summary = await repo.summary(request);
  assert.equal(summary.lineCount, '466'); assert.equal(summary.revenueExcl, '13143.68');
  const wolt = await db.query(`SELECT sum(revenue_excl)::text AS total FROM sales_foundation.sales_line
    WHERE store_id = $1 AND payment_type = $2`, [6, 'Wolt']);
  assert.equal(wolt.rows[0].total, '2120.48');
  const safe = (await repo.lines({ ...request, limit: 1000 })).lines;
  const metrics = computeMetrics(safe.map(item => ({ productid: item.productId, productname: item.productLabel,
    count: Number(item.quantity), price: Number(item.revenueIncl), priceexclvat: Number(item.revenueExcl) })));
  assert.equal(metrics.komboUnits, 66); assert.equal(metrics.rollUnits, 54);
  assert.equal(metrics.komboPct, computeMetrics(fixture.lines).komboPct);
  assert.equal(Math.round(metrics.komboPct * 10000) / 10000, 55);
  assert.equal(metrics.lemUnits, 20);
});
