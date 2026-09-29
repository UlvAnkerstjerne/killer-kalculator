'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { createDatabase } = require('../../lib/sales-db/database');
const { migrate } = require('../../lib/sales-db/migrate');
const { importHistory, withImportBatch } = require('../../lib/sales-sync/importer');
const { withImportOwner } = require('../../lib/sales-sync/owner');
const { createImportRepository } = require('../../lib/sales-sync/repository');
const { validateOptions } = require('../../lib/sales-sync/options');
const { normalizeLine } = require('../../lib/sales-sync/normalize');
const { parseLossless } = require('../../lib/sales-sync/parse');
const { disposableConfig } = require('../sales-sync/disposable');
const { main } = require('../../scripts/sales-sync');
const { STORES, identity, context, credentials, now, scope, row, body, worker } = require('./helpers');
const config = disposableConfig();
// Exercise the same privacy settings locally and in CI, including restricted-role connections.
process.env.PGOPTIONS = '-c log_min_messages=panic -c log_min_error_statement=panic';
const db = createDatabase(config);
const opts = change => ({ apply: true, enabled: true, scope: { ...scope, ...change } });
const plan = change => worker(config, { options: { ...opts(change), apply: false } });
const scalar = async sql => (await db.query(sql)).rows[0].n;
const counts = async () => {
  const value = {};
  for (const name of ['sales_line', 'sales_stage_line', 'sales_day_state', 'sales_import_scan', 'sales_import_bucket', 'sales_import_discrepancy', 'sales_sync_run']) {
    value[name] = await scalar('SELECT count(*)::int AS n FROM sales_foundation.' + name);
  }
  return value;
};
const snapshot = async () => JSON.stringify((await db.query(`SELECT row_to_json(t)::text AS row, xmin::text AS version
  FROM sales_foundation.sales_line t ORDER BY store_id, source_key`)).rows);
async function seed(store, start, end) {
  return importHistory({ config, context, apply: true, now, zeroDayPolicy: 'legacy', options: { storeSlug: store, start, end, companyId: credentials.get(store).companyId }, request: async () => body([]) });
}
before(async () => {
  assert.equal((await db.query("SELECT current_setting('server_version_num')::int AS n")).rows[0].n, 160015);
  console.log('Real PostgreSQL integration server: 16.15');
});
beforeEach(async () => {
  await db.query('DROP SCHEMA IF EXISTS sales_foundation CASCADE'); await migrate(db);
  await db.query('INSERT INTO sales_foundation.identity_key_check VALUES (true, $1, $2)', [identity.version, identity.check()]);
});
after(async () => db.close());

test('bounded multi-day batch refuses one empty day before publishing any day', async () => {
  await assert.rejects(withImportBatch({ config, context, requireNonEmpty: true }, ({ importOne }) => importOne({
    options: { storeSlug: 'norrebro', start: '2026-09-20', end: '2026-09-22', companyId: credentials.get('norrebro').companyId },
    now, request: async () => body([row('norrebro', '2026-09-20')]),
  })), { code: 'ZERO_FACT_DAY_REVIEW' });
  const state = await counts();
  assert.equal(state.sales_line, 0); assert.equal(state.sales_day_state, 0); assert.equal(state.sales_stage_line, 0);
  assert.deepEqual((await db.query('SELECT business_date::text AS date,line_count FROM sales_foundation.sales_import_day ORDER BY business_date')).rows,
    [{ date: '2026-09-20', line_count: 1 }, { date: '2026-09-21', line_count: 0 }]);
  assert.equal(await scalar("SELECT count(*)::int n FROM sales_foundation.sales_import_scan WHERE status='failed' AND error_code='INVALID_RUN' AND terminal"), 1);
});

test('bounded multi-day batch publishes all nonempty days and preserves existing facts', async () => {
  await worker(config); const before = await snapshot();
  const result = await withImportBatch({ config, context, requireNonEmpty: true }, ({ importOne }) => importOne({
    options: { storeSlug: 'vesterbro', start: '2026-09-20', end: '2026-09-22', companyId: credentials.get('vesterbro').companyId },
    now, request: async () => body([row('vesterbro', '2026-09-20'), row('vesterbro', '2026-09-21')]),
  }));
  assert.equal(result.status, 'published'); assert.equal((await counts()).sales_day_state, 3);
  assert.equal(JSON.stringify((await db.query(`SELECT row_to_json(t)::text AS row,xmin::text AS version
    FROM sales_foundation.sales_line t WHERE store_id=6 ORDER BY store_id,source_key`)).rows), before);
});

test('read-only plan has zero provider/audit writes, is deterministic and bounds all six stores', async () => {
  const beforeState = await counts();
  const a = await plan({ stores: STORES, maxDays: 7, end: '2026-09-23' });
  const b = await plan({ stores: [...STORES].reverse(), maxDays: 7, end: '2026-09-23' });
  assert.equal(a.status, 'planned'); assert.equal(a.planned, 7); assert.equal(a.hasMore, true);
  assert.deepEqual(a.plan, b.plan); assert.deepEqual(a.plan.slice(0, 6).map(x => x.store), STORES);
  assert.equal(a.plan[6].start, '2026-09-21'); assert.equal(a.attempted, 0);
  assert.deepEqual(await counts(), beforeState);
});
test('oldest internal gap beats newer dates; complete dates remain no-ops', async () => {
  await seed('norrebro', '2026-09-20', '2026-09-21'); await seed('norrebro', '2026-09-22', '2026-09-23');
  const a = await plan({ start: undefined, end: '2026-09-25', maxDays: 2 });
  assert.deepEqual(a.plan.map(x => x.start), ['2026-09-21', '2026-09-23']); assert.equal(a.noOp, 2); assert.equal(a.hasMore, true);
});
test('no explicit start and no store anchor fails closed, including partially anchored selections', async () => {
  assert.equal((await plan({ start: undefined })).code, 'INVALID_OPTIONS');
  await seed('norrebro', '2026-09-20', '2026-09-21');
  assert.equal((await plan({ stores: ['norrebro', 'vesterbro'], start: undefined })).code, 'INVALID_OPTIONS');
});
for (const [start, end] of [['2026-03-28', '2026-03-31'], ['2026-10-24', '2026-10-27']]) {
  test('SQL calendar planning crosses Copenhagen DST: ' + start, async () => {
    const a = await worker(config, { options: { ...opts({ start, end, maxDays: 7 }), apply: false }, now: () => new Date('2026-10-27T12:00:00Z') });
    assert.equal(a.planned, 3); assert.equal(a.plan[0].start, start); assert.equal(a.plan.at(-1).end, end);
  });
}
test('exclusive bound and maximum one date leave later gaps for a later run', async () => {
  const result = await worker(config, { options: opts({ end: '2026-09-23' }) });
  assert.equal(result.published, 1); assert.equal(result.hasMore, true);
  const later = await plan({ end: '2026-09-23' }); assert.equal(later.plan[0].start, '2026-09-21');
});
test('all six store credentials are selected separately and one store/day finishes before the next', async () => {
  let active = 0, peak = 0; const seen = [];
  const result = await worker(config, { options: opts({ stores: STORES, maxDays: 7 }), requestFor: (store, credential) => {
    assert.equal(credential, credentials.get(store)); assert.deepEqual(Object.keys(credential), ['token', 'companyId']);
    return async () => { active++; peak = Math.max(peak, active); seen.push(store); await Promise.resolve(); active--; return body([row(store)]); };
  } });
  assert.equal(result.status, 'complete'); assert.equal(result.published, 6); assert.deepEqual(seen, STORES); assert.equal(peak, 1);
  assert.equal((await counts()).sales_line, 6); assert.equal((await counts()).sales_stage_line, 0);
});
test('terminal pagination retains a later older row without early exit and preserves exact decimals', async () => {
  let calls = 0;
  const result = await worker(config, { requestFor: () => async url => {
    calls++;
    if (calls === 1) return body([row('norrebro', '2026-09-21', { productname: 'unreviewed but outside', price: 'not money' })], 1, url + '?page=2');
    return body([row('norrebro', '2026-09-20', { price: '10.123456789012345678', priceexclvat: '8.000000000000000001', count: '1.25' })], 2);
  } });
  assert.equal(result.status, 'complete'); assert.equal(result.pages, 2); assert.equal(result.rows, 2); assert.equal(result.logicalRows, 1);
  const fact = (await db.query('SELECT revenue_incl::text, revenue_excl::text, quantity::text FROM sales_foundation.sales_line')).rows[0];
  assert.equal(fact.revenue_incl, '10.123456789012345678'); assert.equal(fact.revenue_excl, '8.000000000000000001'); assert.equal(fact.quantity, '1.25');
});
test('contradictory declared total rejects the complete candidate without publication', async () => {
  const result = await worker(config, { requestFor: () => async () => body([row()]).replace('"current_page":1', '"total":2,"current_page":1') });
  assert.equal(result.code, 'INVALID_PAGE'); assert.equal(result.failed, 1); assert.equal((await counts()).sales_line, 0);
});
test('exact reviewed Frederiksberg empty label is stored and independently verifies without fact writes', async () => {
  const result = await worker(config, { options: opts({ stores: ['frederiksberg'] }), requestFor: () => async () => body([row('frederiksberg')]) });
  assert.equal(result.published, 1);
  const label = (await db.query('SELECT product_label, group_label FROM sales_foundation.sales_line')).rows[0];
  assert.equal(label.product_label, ''); assert.equal(label.group_label, 'Drinks ');
  const beforeState = await snapshot();
  const id = (await db.query('SELECT run_id FROM sales_foundation.sales_import_scan')).rows[0].run_id;
  const verified = await importHistory({ config, context, apply: true,
    options: { storeSlug: 'frederiksberg', start: scope.start, end: scope.end, companyId: credentials.get('frederiksberg').companyId, verificationOf: id },
    request: async () => body([row('frederiksberg')]) });
  assert.equal(verified.status, 'verified'); assert.ok(await snapshot() === beforeState);
  const rerun = await worker(config, { options: opts({ stores: ['frederiksberg'] }), requestFor: () => { throw Error('No repeat provider call'); } });
  assert.equal(rerun.noOp, 1); assert.equal(rerun.attempted, 0); assert.ok(await snapshot() === beforeState);
});
test('unknown catalogue and mixed candidates quarantine without partial facts and remain a planned gap', async () => {
  const result = await worker(config, { requestFor: () => async () => body([row(), row('norrebro', scope.start, { orderlineid: 'synthetic-unknown', productname: 'Unreviewed synthetic item' })]) });
  assert.equal(result.quarantined, 1); assert.equal(result.code, 'CATALOG_REVIEW'); assert.equal(result.pages, 1);
  assert.equal((await counts()).sales_line, 0); assert.equal((await counts()).sales_stage_line, 0);
  const next = await plan({}); assert.equal(next.planned, 1); assert.equal(next.noOp, 0);
});
test('provider failure has no internal retry and does not advance past the oldest gap', async () => {
  let calls = 0;
  const result = await worker(config, { options: opts({ maxDays: 3, end: '2026-09-23' }), requestFor: () => async () => { calls++; throw Error('untrusted upstream detail'); } });
  assert.equal(calls, 1); assert.equal(result.attempted, 1); assert.equal(result.failed, 1); assert.equal(result.code, 'UPSTREAM_FAILED');
  assert.equal(result.countsComplete, false); assert.equal((await counts()).sales_line, 0);
  assert.equal((await worker(config)).published, 1); // Separate later invocation, not an internal retry.
});
test('later failure preserves completed work and every existing fact xmin', async () => {
  await worker(config); const prior = await snapshot(); let beforeFailure;
  let calls = 0;
  const result = await worker(config, { options: opts({ stores: ['norrebro', 'vesterbro'], end: '2026-09-23', maxDays: 4 }),
    requestFor: store => async () => { calls++; if (calls === 2) { beforeFailure = await snapshot(); throw Error('failure'); } return body([row(store)]); } });
  assert.equal(result.published, 1); assert.equal(result.failed, 1); assert.equal(result.attempted, 2); assert.ok(await snapshot() === beforeFailure);
  const original = (await db.query(`SELECT row_to_json(t)::text AS row, xmin::text AS version
    FROM sales_foundation.sales_line t WHERE store_id = 6 ORDER BY store_id, source_key`)).rows;
  assert.equal(JSON.stringify(original), prior);
  assert.equal((await counts()).sales_day_state, 2);
});
test('successful restart and duplicate invocation use durable coverage and do not rewrite facts/audit', async () => {
  await worker(config); const prior = await snapshot(), audit = await counts(); let calls = 0;
  const second = await worker(config, { requestFor: () => { calls++; throw Error('no provider'); } });
  assert.equal(second.status, 'complete'); assert.equal(second.attempted, 0); assert.equal(second.noOp, 1); assert.equal(calls, 0);
  assert.deepEqual(await counts(), audit); assert.ok(await snapshot() === prior);
});
test('worker refuses other worker and manual importer ownership with no provider/audit writes', async () => {
  let release, ready; const readyPromise = new Promise(r => { ready = r; });
  const hold = new Promise(r => { release = r; });
  const first = worker(config, { requestFor: () => async () => { ready(); await hold; return body([row()]); } });
  await readyPromise; const audit = await counts();
  try {
    const second = await worker(config, { requestFor: () => { throw Error('No second provider'); } });
    assert.equal(second.status, 'busy'); assert.equal(second.attempted, 0); assert.deepEqual(await counts(), audit);
    assert.equal((await plan({})).status, 'busy');
    await assert.rejects(withImportOwner(config, async () => {}), { code: 'IMPORTER_BUSY' });
  } finally { release(); }
  assert.equal((await first).published, 1); assert.equal((await plan({})).status, 'planned');
});
test('lock release after failure and database disconnect fences the old worker', async () => {
  const result = await worker(config, { requestFor: () => async () => {
    const pid = (await db.query("SELECT pid FROM pg_stat_activity WHERE application_name = 'kk-sales-backfill'")).rows[0].pid;
    await db.query('SELECT pg_terminate_backend($1)', [pid]);
    await new Promise(r => setTimeout(r, 30)); return body([row()]);
  } });
  assert.equal(result.status, 'incomplete'); assert.equal(result.published, 0); assert.equal((await counts()).sales_line, 0);
  assert.equal((await worker(config)).published, 1);
});
test('interruption during pagination leaves no publication and later run begins from page one', async () => {
  const controller = new AbortController(); let calls = 0;
  const result = await worker(config, { signal: controller.signal, requestFor: () => async url => {
    calls++; if (calls === 1) return body([row()], 1, url + '?page=2'); controller.abort(); return body([], 2);
  } });
  assert.equal(result.code, 'INTERRUPTED'); assert.equal(calls, 2); assert.equal((await counts()).sales_line, 0);
  let restartCalls = 0;
  const next = await worker(config, { requestFor: () => async url => { restartCalls++; assert.equal(new URL(url).search, ''); return body([row()]); } });
  assert.equal(next.published, 1); assert.equal(restartCalls, 1);
});
test('crash after terminal staging before publication is recovered by the existing audit path', async () => {
  await withImportOwner(config, async session => {
    const repository = createImportRepository(session, context);
    const params = validateOptions({ storeSlug: 'norrebro', start: scope.start, end: scope.end }, now());
    const run = await repository.begin(params);
    const raw = parseLossless(body([row()])).data[0];
    await repository.stage(run, [{ line: normalizeLine(raw, { storeSlug: 'norrebro', companyId: credentials.get('norrebro').companyId, context }), page: 1, position: 0 }]);
    await repository.finishScan(run, { terminal: true });
    // Session closes before preflight/publication, leaving durable staged data.
  });
  assert.equal((await counts()).sales_stage_line, 1);
  assert.equal((await worker(config)).published, 1);
  assert.equal(await scalar("SELECT count(*)::int AS n FROM sales_foundation.sales_import_scan WHERE status = 'interrupted'"), 1);
  assert.equal((await counts()).sales_stage_line, 0);
});
for (const phase of ['stage', 'publication']) test('atomic ' + phase + ' failure and safe restart from durable state', async () => {
  const table = phase === 'stage' ? 'sales_stage_line' : 'sales_day_state';
  await db.query(`CREATE FUNCTION sales_foundation.reject_synthetic() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
    CREATE TRIGGER reject_synthetic BEFORE INSERT ON sales_foundation.${table} FOR EACH ROW EXECUTE FUNCTION sales_foundation.reject_synthetic()`);
  const failed = await worker(config); assert.equal(failed.failed, 1); assert.equal((await counts()).sales_line, 0); assert.equal((await counts()).sales_day_state, 0);
  await db.query(`DROP TRIGGER reject_synthetic ON sales_foundation.${table}`);
  if (phase === 'stage') assert.equal((await worker(config)).published, 1);
  else {
    const audit = await counts(); let calls = 0;
    const blocked = await worker(config, { requestFor: () => { calls++; throw Error('must not fetch'); } });
    assert.equal(blocked.code, 'PUBLICATION_PENDING'); assert.equal(blocked.attempted, 0); assert.equal(calls, 0); assert.deepEqual(await counts(), audit);
    assert.equal((await plan({})).code, 'PUBLICATION_PENDING');
    const id = (await db.query("SELECT run_id FROM sales_foundation.sales_import_scan WHERE status = 'publication-pending'")).rows[0].run_id;
    await importHistory({ config, context, apply: true, now, options: { storeSlug: 'norrebro', start: scope.start, end: scope.end, resumePublication: id }, request: async () => { throw Error('no provider resume'); } });
    assert.equal((await worker(config)).attempted, 0);
  }
});
test('post-commit staging cleanup failure reports durable publication; restart purges without traversal', async () => {
  await db.query(`CREATE FUNCTION sales_foundation.reject_purge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
    CREATE TRIGGER reject_purge BEFORE DELETE ON sales_foundation.sales_stage_line FOR EACH ROW EXECUTE FUNCTION sales_foundation.reject_purge()`);
  const first = await worker(config); assert.equal(first.published, 1); assert.equal(first.failed, 1); assert.equal(first.coverage[0].evidence, 'complete-single-pass');
  const prior = await snapshot(); assert.equal((await counts()).sales_stage_line, 1);
  await db.query('DROP TRIGGER reject_purge ON sales_foundation.sales_stage_line');
  const next = await worker(config, { requestFor: () => { throw Error('no provider'); } });
  assert.equal(next.attempted, 0); assert.equal(next.noOp, 1); assert.equal((await counts()).sales_stage_line, 0); assert.ok(await snapshot() === prior);
});
test('wrong identity or incomplete migration ledger fails before provider/audit writes', async () => {
  await db.query('UPDATE sales_foundation.identity_key_check SET check_digest = $1', [Buffer.alloc(32)]);
  const audit = await counts(); const result = await worker(config);
  assert.equal(result.code, 'IDENTITY_MISMATCH'); assert.equal(result.attempted, 0); assert.deepEqual(await counts(), audit);
  await db.query("DELETE FROM sales_foundation.schema_migration WHERE version = '004_empty_product_labels.sql'");
  assert.equal((await plan({})).code, 'INVALID_CONFIG');
});
test('summary privacy excludes raw payload, protected IDs, catalogue values and arbitrary errors', async () => {
  const canary = ['SYNTHETIC', 'PRIVATE', 'IMPORTER', 'CANARY'].join('_');
  const result = await worker(config, { requestFor: () => async () => body([row('norrebro', scope.start, { customer: canary, clerk: canary, card: canary })]) });
  const text = JSON.stringify(result);
  assert.ok(!text.includes(canary)); assert.ok(!text.includes(row().productname));
  assert.equal(/sourceKey|fingerprint|runId|orderlineid|postgres:|token/.test(text), false);
  assert.ok(!/[a-f0-9]{64}/.test(text));
});
test('century-wide planning returns a bounded plan independent of date history length', async () => {
  const result = await plan({ stores: STORES, start: '2000-01-01', end: '2099-12-31', maxDays: 7 });
  assert.equal(result.code, 'INVALID_OPTIONS'); // Future dates cannot be planned.
  const { runWorker } = require('../../lib/sales-worker/worker');
  const wide = await runWorker({ config, options: { apply: false, scope: { stores: STORES, start: '2000-01-01', end: '2099-12-31', maxDays: 7 } }, now: () => new Date('2099-12-31T12:00:00Z') });
  assert.equal(wide.planned, 7); assert.equal(wide.plan[0].start, '2000-01-01'); assert.equal(wide.hasMore, true);
  assert.ok(Buffer.byteLength(JSON.stringify(wide)) < 3000);
});
test('worker crash by SIGKILL releases session ownership and restart recovers staging', { timeout: 20000 }, async () => {
  const child = fork(require.resolve('./worker-child'), [], { env: { PATH: process.env.PATH, PGOPTIONS: process.env.PGOPTIONS, KK_TEST_DATABASE_URL: process.env.KK_TEST_DATABASE_URL },
    execArgv: ['--require', require.resolve('../sales-sync/network-guard')], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await Promise.race([once(child, 'message'), new Promise((_, reject) => { const t = setTimeout(() => reject(Error('Synthetic child timeout')), 10000); t.unref(); })]);
    assert.equal((await worker(config)).status, 'busy');
  } finally { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  assert.equal((await worker(config)).published, 1); assert.equal((await counts()).sales_stage_line, 0);
});
test('plan CLI needs no identity/provider secrets and never writes', async () => {
  const beforeState = await counts(); const output = [];
  const env = { KK_SALES_DB_ENABLED: 'true', KK_SALES_DB_URL: config.connectionString };
  assert.equal(await main(['--plan', '--store', 'norrebro', '--from', scope.start, '--through', scope.end], env, x => output.push(JSON.parse(x)), { now }), 0);
  assert.equal(output[0].status, 'planned'); assert.deepEqual(await counts(), beforeState);
});

test('a full seven-unit run releases each day before fetching the next and retains a bounded plan', async () => {
  let calls = 0;
  const result = await worker(config, { options: opts({ end: '2026-09-27', maxDays: 7 }), requestFor: () => async () => {
    assert.equal((await counts()).sales_stage_line, 0);
    const day = '2026-09-' + (20 + calls++);
    return body(Array.from({ length: 300 }, (_, i) => row('norrebro', day, { orderlineid: 'synthetic-bounded-' + day + '-' + i })));
  } });
  assert.equal(result.status, 'complete'); assert.equal(calls, 7); assert.equal(result.published, 7); assert.equal(result.logicalRows, 2100);
  assert.equal(result.plan.length, 7); assert.equal(result.coverage.length, 7); assert.equal((await counts()).sales_stage_line, 0);
  console.log('Synthetic worker memory result: ' + JSON.stringify({ units: 7, rowsPerUnit: 300, logicalRows: 2100, stagedRowsBeforeNextUnit: 0, maxPlanUnits: 7, maxPlannerCandidates: 48 }));
});
test('narrow writer role needs no schema ownership, fact UPDATE/DELETE or migration privileges', async () => {
  // Public disposable test password, matching CI's SCRAM authentication.
  await db.query("CREATE ROLE kk_worker_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD 'disposable_test_only'");
  try {
    await db.query(`GRANT SET ON PARAMETER log_min_messages, log_min_error_statement TO kk_worker_test;
      GRANT USAGE ON SCHEMA sales_foundation TO kk_worker_test;
      GRANT SELECT ON ALL TABLES IN SCHEMA sales_foundation TO kk_worker_test;
      GRANT INSERT ON sales_foundation.identity_key_check, sales_foundation.sales_sync_run,
        sales_foundation.sales_import_scan, sales_foundation.sales_stage_line, sales_foundation.sales_import_day,
        sales_foundation.sales_line, sales_foundation.sales_day_state, sales_foundation.sales_import_bucket,
        sales_foundation.sales_import_discrepancy TO kk_worker_test;
      GRANT UPDATE ON sales_foundation.sales_sync_run, sales_foundation.sales_import_scan,
        sales_foundation.sales_day_state TO kk_worker_test;
      GRANT DELETE ON sales_foundation.sales_stage_line TO kk_worker_test`);
    const target = new URL(config.connectionString); target.username = 'kk_worker_test'; target.password = 'disposable_test_only';
    const restricted = { enabled: true, connectionString: target.href };
    assert.equal((await worker(restricted)).published, 1);
    const rights = (await db.query(`SELECT has_table_privilege('kk_worker_test', 'sales_foundation.sales_line', 'UPDATE') AS update,
      has_table_privilege('kk_worker_test', 'sales_foundation.sales_line', 'DELETE') AS delete,
      has_schema_privilege('kk_worker_test', 'sales_foundation', 'CREATE') AS create`)).rows[0];
    assert.equal(rights.update || rights.delete || rights.create, false);
  } finally { await db.query('DROP OWNED BY kk_worker_test; DROP ROLE kk_worker_test'); }
});
test('plan-only works with SELECT privileges and no worker write grants', async () => {
  await db.query("CREATE ROLE kk_plan_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD 'disposable_test_only'");
  try {
    await db.query(`GRANT SET ON PARAMETER log_min_messages, log_min_error_statement TO kk_plan_test;
      GRANT USAGE ON SCHEMA sales_foundation TO kk_plan_test;
      GRANT SELECT ON ALL TABLES IN SCHEMA sales_foundation TO kk_plan_test`);
    const target = new URL(config.connectionString); target.username = 'kk_plan_test'; target.password = 'disposable_test_only';
    const result = await worker({ enabled: true, connectionString: target.href }, { options: { ...opts({}), apply: false } });
    assert.equal(result.status, 'planned'); assert.equal(result.planned, 1); assert.equal(result.attempted, 0);
  } finally { await db.query('DROP OWNED BY kk_plan_test; DROP ROLE kk_plan_test'); }
});
test('crash after bucket commit blocks new traversals until explicit checkpoint resume', async () => {
  await db.query(`CREATE FUNCTION sales_foundation.reject_finalization() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.status = 'published' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_finalization BEFORE UPDATE ON sales_foundation.sales_import_scan FOR EACH ROW EXECUTE FUNCTION sales_foundation.reject_finalization()`);
  const first = await worker(config); assert.equal(first.published, 1); assert.equal(first.failed, 1);
  const prior = await snapshot(), audit = await counts();
  const restart = await worker(config, { requestFor: () => { throw Error('No duplicate traversal'); } });
  assert.equal(restart.code, 'PUBLICATION_PENDING'); assert.equal(restart.attempted, 0); assert.deepEqual(await counts(), audit); assert.ok(await snapshot() === prior);
  await db.query('DROP TRIGGER reject_finalization ON sales_foundation.sales_import_scan');
  const id = (await db.query("SELECT run_id FROM sales_foundation.sales_import_scan WHERE status = 'publication-pending'")).rows[0].run_id;
  await importHistory({ config, context, apply: true, now, options: { storeSlug: 'norrebro', start: scope.start, end: scope.end, resumePublication: id }, request: async () => { throw Error('No provider during resume'); } });
  assert.equal((await worker(config)).attempted, 0); assert.ok(await snapshot() === prior);
});
test('batch import handle rejects overlapping calls and cannot outlive its lock session', async () => {
  let escaped;
  await withImportBatch({ config, context }, async ({ importOne }) => {
    escaped = importOne;
    let release, ready; const hold = new Promise(r => { release = r; }), started = new Promise(r => { ready = r; });
    const args = { options: { storeSlug: 'norrebro', start: scope.start, end: scope.end, companyId: credentials.get('norrebro').companyId }, now,
      request: async () => { ready(); await hold; return body([row()]); } };
    const first = importOne(args); await started;
    try { await assert.rejects(importOne(args), { code: 'IMPORTER_BUSY' }); } finally { release(); }
    assert.equal((await first).status, 'published');
  });
  await assert.rejects(escaped({}), { code: 'LOCK_LOST' });
});

test('batch callback exit cancels and drains an unawaited import before releasing ownership', async () => {
  let unfinished, requests = 0;
  await withImportBatch({ config, context }, async ({ importOne }) => {
    unfinished = importOne({ options: { storeSlug: 'norrebro', start: scope.start, end: scope.end, companyId: credentials.get('norrebro').companyId }, now,
      request: async () => { requests++; return body([row()]); } });
    unfinished.catch(() => {});
  });
  await assert.rejects(unfinished, { code: 'INTERRUPTED' });
  assert.equal(requests, 0); assert.equal((await counts()).sales_line, 0);
  assert.equal((await worker(config)).published, 1);
});

test('six-unit empty-first reproduction stops before publication or the next traversal', async () => {
  let calls = 0;
  const result = await worker(config, { options: opts({ start: '2026-09-21', end: '2026-09-27', maxDays: 6 }),
    requestFor: () => async () => { calls++; return body([]); } });
  assert.equal(calls, 1); assert.equal(result.planned, 6); assert.equal(result.attempted, 1);
  assert.equal(result.status, 'incomplete'); assert.equal(result.code, 'ZERO_FACT_DAY_REVIEW');
  assert.equal(result.published, 0); assert.equal(result.failed, 1); assert.equal(result.logicalRows, 0);
  assert.deepEqual(await counts(), { sales_line: 0, sales_stage_line: 0, sales_day_state: 0,
    sales_import_scan: 1, sales_import_bucket: 0, sales_import_discrepancy: 0, sales_sync_run: 1 });
  const scan = (await db.query('SELECT status, error_code, terminal, logical_count FROM sales_foundation.sales_import_scan')).rows[0];
  assert.deepEqual(scan, { status: 'failed', error_code: 'INVALID_RUN', terminal: true, logical_count: 0 });
});

test('middle empty unit preserves prior committed facts and stops before later dates', async () => {
  let calls = 0, committed;
  const result = await worker(config, { options: opts({ end: '2026-09-23', maxDays: 3 }), requestFor: () => async () => {
    calls++;
    if (calls === 1) return body([row()]);
    committed = await snapshot(); return body([]);
  } });
  assert.equal(calls, 2); assert.equal(result.code, 'ZERO_FACT_DAY_REVIEW');
  assert.equal(result.published, 1); assert.equal(result.attempted, 2); assert.equal(result.failed, 1);
  assert.ok(await snapshot() === committed);
  const state = await counts(); assert.equal(state.sales_line, 1); assert.equal(state.sales_day_state, 1);
  assert.equal(state.sales_import_bucket, 1); assert.equal(state.sales_stage_line, 0);
  const next = await plan({ end: '2026-09-23', maxDays: 3 });
  assert.deepEqual(next.plan.map(unit => unit.start), ['2026-09-21', '2026-09-22']);
});

for (const outside of [false, true]) test('empty guard waits for terminal pagination with ' + (outside ? 'out-of-range provider rows' : 'empty source pages'), async () => {
  let calls = 0;
  const result = await worker(config, { requestFor: () => async url => {
    calls++;
    const rows = outside ? [row('norrebro', calls === 1 ? '2026-09-19' : '2026-09-21',
      { productname: 'unreviewed outside the day', price: 'not-money' })] : [];
    return body(rows, calls, calls === 1 ? url + '?page=2' : null);
  } });
  assert.equal(calls, 2); assert.equal(result.pages, 2); assert.equal(result.rows, outside ? 2 : 0);
  assert.equal(result.code, 'ZERO_FACT_DAY_REVIEW'); assert.equal(result.published, 0);
  assert.equal((await counts()).sales_stage_line, 0); assert.equal((await counts()).sales_day_state, 0);
});

test('empty first page does not reject a later nonempty in-range terminal page', async () => {
  let calls = 0;
  const result = await worker(config, { requestFor: () => async url => ++calls === 1
    ? body([], 1, url + '?page=2') : body([row()], 2) });
  assert.equal(calls, 2); assert.equal(result.status, 'complete'); assert.equal(result.logicalRows, 1);
  assert.equal(result.published, 1);
});

for (const kind of ['zero-net', 'refund-only', 'zero-price']) test('nonempty ' + kind + ' day does not trigger the zero-fact guard', async () => {
  const rows = kind === 'zero-net'
    ? [row(), row('norrebro', scope.start, { orderlineid: 'synthetic-refund', price: '-10', priceexclvat: '-8', count: '-1' })]
    : [row('norrebro', scope.start, { price: kind === 'refund-only' ? '-10' : '0', priceexclvat: kind === 'refund-only' ? '-8' : '0', count: kind === 'refund-only' ? '-1' : '1' })];
  const result = await worker(config, { requestFor: () => async () => body(rows) });
  assert.equal(result.status, 'complete'); assert.equal(result.published, 1); assert.equal(result.logicalRows, rows.length);
  assert.equal((await counts()).sales_line, rows.length); assert.equal((await counts()).sales_stage_line, 0);
});

test('empty rejection releases ownership and a separate operator run can reassess the missing day', async () => {
  let calls = 0;
  const rejected = await worker(config, { requestFor: () => async () => { calls++; return body([]); } });
  assert.equal(rejected.code, 'ZERO_FACT_DAY_REVIEW'); assert.equal(calls, 1);
  await withImportOwner(config, async () => {});
  const audit = await counts(); const next = await plan({});
  assert.equal(next.planned, 1); assert.equal(next.noOp, 0); assert.deepEqual(await counts(), audit);
  assert.equal(next.plan[0].start, scope.start);
  const later = await worker(config); assert.equal(later.published, 1); assert.equal((await counts()).sales_stage_line, 0);
});

test('terminal total validation and catalogue quarantine take precedence over empty guard', async () => {
  const invalid = await worker(config, { requestFor: () => async () => body([]).replace('"current_page":1', '"total":1,"current_page":1') });
  assert.equal(invalid.code, 'INVALID_PAGE'); assert.equal(invalid.published, 0);
  const quarantine = await worker(config, { requestFor: () => async () => body([row('norrebro', scope.start, { productname: 'unreviewed synthetic' })]) });
  assert.equal(quarantine.code, 'CATALOG_REVIEW'); assert.equal(quarantine.quarantined, 1);
  assert.equal((await counts()).sales_line, 0); assert.equal((await counts()).sales_stage_line, 0);
});

test('empty guard CLI output is fixed and omits provider fields, catalogue values and credentials', async () => {
  const canary = ['SYNTHETIC', 'PRIVATE', 'IMPORTER', 'CANARY'].join('_');
  const output = []; let calls = 0;
  const env = { KK_SALES_SYNC_ENABLED: 'true', KK_SALES_DB_ENABLED: 'true', KK_SALES_DB_URL: config.connectionString,
    KK_SALES_IDENTITY_KEY_HEX: '07'.repeat(32), KK_SALES_IDENTITY_KEY_VERSION: '1',
    KK_SYNC_TOKEN_NORREBRO: canary, KK_SYNC_COMPANY_ID_NORREBRO: credentials.get('norrebro').companyId };
  const exitCode = await main(['--apply', '--store', 'norrebro', '--from', scope.start, '--through', scope.end], env, line => output.push(line), {
    now, requestFor: () => async () => { calls++; return body([row('norrebro', scope.end,
      { orderlineid: canary, customer: canary, clerk: canary, card: canary, productname: canary })]); },
  });
  assert.equal(exitCode, 1); assert.equal(calls, 1); assert.equal(output.length, 1);
  assert.equal(JSON.parse(output[0]).code, 'ZERO_FACT_DAY_REVIEW');
  assert.ok(!output[0].includes(canary)); assert.ok(!output[0].includes(row().productname));
  assert.equal(/sourceKey|fingerprint|runId|orderlineid|postgres:|token|[a-f0-9]{64}/.test(output[0]), false);
});

test('legacy empty snapshot remains independently verifiable', async () => {
  const published = await seed('norrebro', scope.start, scope.end); assert.equal(published.status, 'published');
  const beforeState = await snapshot();
  const id = (await db.query("SELECT run_id FROM sales_foundation.sales_import_scan WHERE status = 'published'")).rows[0].run_id;
  const verified = await withImportBatch({ config, context, requireNonEmpty: true }, ({ importOne }) => importOne({
    options: { storeSlug: 'norrebro', start: scope.start, end: scope.end, companyId: credentials.get('norrebro').companyId, verificationOf: id },
    now, request: async () => body([]),
  }));
  assert.equal(verified.status, 'verified'); assert.ok(await snapshot() === beforeState);
  const noop = await worker(config, { requestFor: () => { throw Error('No worker rescan of verified empty coverage'); } });
  assert.equal(noop.attempted, 0); assert.equal(noop.noOp, 1); assert.equal((await counts()).sales_stage_line, 0);
  assert.equal((await db.query('SELECT evidence FROM sales_foundation.sales_day_state')).rows[0].evidence, 'verified-empty');
});

test('worker retains bounded encoded review on quarantine without a second request',async()=>{
 let requests=0;
 const result=await worker(config,{requestFor:()=>async()=>{requests++;return body([row('norrebro',scope.start,{productid:'new-synthetic',productname:'<b>inert</b>'})]);}});
 assert.equal(requests,1);assert.equal(result.quarantined,1);assert.equal(result.code,'CATALOG_REVIEW');assert.equal(result.published,0);
 const decoded=require('../../lib/sales-sync/catalog-encoded').decodeReview(result.catalogReview);assert.equal(decoded.products[0].productLabel,'<b>inert</b>');assert.equal(result.catalogReview.traversal.requests,1);assert(result.catalogReview.traversal.terminal);
 assert(!JSON.stringify(result).includes('<b>inert</b>'));const c=await counts();assert.equal(c.sales_line,0);assert.equal(c.sales_stage_line,0);assert.equal(c.sales_day_state,0);assert.equal(c.sales_import_discrepancy,0);
});
