'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { createDatabase } = require('../../lib/sales-db/database');
const { migrate } = require('../../lib/sales-db/migrate');
const { createRepository } = require('../../lib/sales-db/repository');
const { createReviewedCatalog, publicLine } = require('../../lib/sales-db/facts');
const { createIdentity } = require('../../lib/sales-db/identity');
const { computeMetrics } = require('../../lib/product-metrics');
const { importHistory } = require('../../lib/sales-sync/importer');
const { createImportRepository } = require('../../lib/sales-sync/repository');
const { withImportOwner, IMPORT_LOCK } = require('../../lib/sales-sync/owner');
const { normalizeLine } = require('../../lib/sales-sync/normalize');
const { parseLossless } = require('../../lib/sales-sync/parse');
const { ImportError } = require('../../lib/sales-sync/errors');
const { simulate } = require('../../scripts/simulate-sales-backfill');
const { main } = require('../../scripts/sales-backfill');
const { disposableConfig } = require('./disposable');
const { context, start, end, initial, CANARY, raw, body, provider, options } = require('./helpers');
const config = disposableConfig();
const db = createDatabase(config);
const scan = (pages = [[raw()]], extra = {}) => importHistory({ config, context, options, apply: true, request: provider(pages).request, ...extra });
const count = async name => {
  assert.ok(['sales_line', 'sales_stage_line', 'sales_day_state', 'sales_import_scan', 'sales_import_bucket', 'sales_import_discrepancy'].includes(name));
  return (await db.query(`SELECT count(*)::int AS n FROM sales_foundation.${name}`)).rows[0].n;
};
const state = async () => (await db.query(`SELECT i.status, i.error_code, i.pages, i.review_count, i.terminal,
  r.line_count FROM sales_foundation.sales_import_scan i JOIN sales_foundation.sales_sync_run r USING (run_id)
  ORDER BY r.observed_at DESC LIMIT 1`)).rows[0];
const covered = (storeSlug = 'norrebro') => withImportOwner(config, session => createImportRepository(session, context).coverage({ storeSlug, start, end }));
const noPublished = async () => { for (const name of ['sales_line', 'sales_day_state', 'sales_import_bucket']) assert.equal(await count(name), 0); };
before(async () => {
  const version = (await db.query("SELECT current_setting('server_version_num')::int AS version")).rows[0].version;
  assert.equal(version, 160015, 'Pinned PostgreSQL 16.15 required');
  if (process.env.CI) {
    const log = (await db.query("SELECT current_setting('log_min_messages') AS messages, current_setting('log_min_error_statement') AS statements")).rows[0];
    assert.equal(log.messages, 'panic'); assert.equal(log.statements, 'panic');
  }
});
beforeEach(async () => { await db.query('DROP SCHEMA IF EXISTS sales_foundation CASCADE'); await migrate(db); });
after(async () => { await db.close(); assert.equal(db.health().total, 0); });

test('real multi-page terminal traversal publishes complete single-pass coverage', async () => {
  const mock = provider([[raw()], [raw({ orderlineid: 'synthetic-two' })]]);
  const result = await scan(undefined, { request: mock.request });
  assert.equal(result.status, 'published'); assert.equal(result.lineCount, 2); assert.equal(mock.calls.length, 2);
  assert.equal((await state()).terminal, true); assert.equal(await count('sales_stage_line'), 0);
  const coverage = await covered(); assert.ok(coverage.days.every(day => day.status === 'complete-single-pass'));
});
test('reviewed spaced payment codes stage, publish and independently verify without duplicate facts', async () => {
  const ctx = { identity: context.identity, catalog: createReviewedCatalog({
    products: [{ storeSlug: 'norrebro', productId: 'synthetic-product', productLabel: 'Synthetic product',
      groupId: 'synthetic-group', groupLabel: 'Synthetic group' }],
    payments: [{ paymentType: 'Synthetic payment', paymentCode: 'mixed 1' }],
  }) };
  const pages = [[raw({ paymenttypecode: 'mixed 1' })]];
  const first = await scan(pages, { context: ctx });
  assert.equal(first.status, 'published'); assert.equal(first.verified, false);
  const factBefore = (await db.query('SELECT xmin::text, * FROM sales_foundation.sales_line')).rows;
  const coverageBefore = (await db.query('SELECT published_run, source_observed_at FROM sales_foundation.sales_day_state')).rows;
  const bucketsBefore = await count('sales_import_bucket');
  await db.query(`CREATE FUNCTION sales_foundation.forbid_fact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'verification attempted fact mutation'; END $$;
    CREATE TRIGGER forbid_fact_mutation BEFORE INSERT OR UPDATE OR DELETE ON sales_foundation.sales_line
      FOR EACH STATEMENT EXECUTE FUNCTION sales_foundation.forbid_fact_mutation()`);
  const second = await scan(pages, { context: ctx, options: { ...options, verificationOf: first.runId } });
  assert.equal(second.status, 'verified'); assert.equal(second.verified, true);
  assert.equal(await count('sales_line'), 1); assert.equal(await count('sales_stage_line'), 0);
  assert.deepEqual((await db.query('SELECT xmin::text, * FROM sales_foundation.sales_line')).rows, factBefore);
  assert.deepEqual((await db.query('SELECT published_run, source_observed_at FROM sales_foundation.sales_day_state')).rows, coverageBefore);
  assert.equal(await count('sales_import_bucket'), bucketsBefore, 'verification must not create publication buckets');
  assert.equal(await count('sales_import_discrepancy'), 0);
  assert.equal((await db.query('SELECT payment_code FROM sales_foundation.sales_line')).rows[0].payment_code, 'mixed 1');
  assert.ok((await covered()).days.every(day => day.status === 'independently-verified' || day.status === 'verified-empty'));
  const verificationAudit = (await db.query(`SELECT i.status, i.verified, i.verification_of,
    r.store_id, r.start_date::text, r.end_date::text, r.observed_at
    FROM sales_foundation.sales_import_scan i JOIN sales_foundation.sales_sync_run r USING (run_id, store_id)
    WHERE i.run_id = $1`, [second.runId])).rows[0];
  assert.deepEqual({ status: verificationAudit.status, verified: verificationAudit.verified,
    verificationOf: verificationAudit.verification_of },
  { status: 'published', verified: true, verificationOf: first.runId });
  const auditCount = (await db.query('SELECT count(*)::int AS count FROM sales_foundation.sales_import_scan')).rows[0].count;
  await withImportOwner(config, session => createImportRepository(session, ctx).verify({
    id: second.runId, store: verificationAudit.store_id, start: verificationAudit.start_date,
    end: verificationAudit.end_date, observedAt: verificationAudit.observed_at.toISOString(), verificationOf: first.runId,
  }));
  assert.equal((await db.query('SELECT count(*)::int AS count FROM sales_foundation.sales_import_scan')).rows[0].count, auditCount,
    'metadata finalization is idempotent');
});
test('later older in-range dates survive newer pages and logical filtering happens after termination', async () => {
  const pages = [[raw({ orderlineid: 'synthetic-newer', timestamp_pay: '2025-02-20 12:00:00' })],
    [raw({ orderlineid: 'synthetic-older', timestamp_pay: '2025-01-01 00:00:00' })]];
  const result = await scan(pages);
  assert.equal(result.sanitizedRows, 2); assert.equal(result.lineCount, 1);
  assert.equal((await db.query('SELECT business_date::text AS date FROM sales_foundation.sales_line')).rows[0].date, start);
});
for (const [mode, expected] of [['missing-data', 'INVALID_PAGE'], ['non-array', 'INVALID_PAGE'],
  ['missing-terminal', 'INVALID_PAGE'], ['unsafe', 'UNSAFE_CONTINUATION'], ['loop', 'PAGINATION_LOOP'], ['stalled', 'INVALID_PAGE']]) {
  test('invalid continuation or envelope leaves prior facts and coverage unchanged', async () => {
    await scan();
    const prior = await db.query('SELECT published_run, source_observed_at FROM sales_foundation.sales_day_state ORDER BY business_date');
    let page = 0;
    const request = async () => {
      if (++page === 1) return body([raw({ orderlineid: 'synthetic-unpublished' })], 1, initial + '?page=2');
      if (mode === 'missing-data') return '{"current_page":2,"next_page_url":null}';
      if (mode === 'non-array') return '{"data":{},"current_page":2,"next_page_url":null}';
      if (mode === 'missing-terminal') return '{"data":[],"current_page":2}';
      if (mode === 'unsafe') return body([], 2, 'https://example.invalid/?page=3');
      if (mode === 'loop') return body([], 2, initial);
      return body([], 1, null);
    };
    await assert.rejects(scan(undefined, { request }), { code: expected });
    assert.equal(await count('sales_line'), 1); assert.equal(await count('sales_stage_line'), 0);
    assert.deepEqual((await db.query('SELECT published_run, source_observed_at FROM sales_foundation.sales_day_state ORDER BY business_date')).rows, prior.rows);
    assert.equal((await state()).status, 'failed');
  });
}
test('page and row safety ceilings fail without advancing coverage', async () => {
  await assert.rejects(scan([[raw()], []], { limits: { maxPages: 1 } }), { code: 'PAGE_LIMIT' });
  await noPublished();
  await assert.rejects(scan([[raw(), raw()]], { limits: { maxRows: 1 } }), { code: 'ROW_LIMIT' });
  await noPublished(); assert.equal(await count('sales_stage_line'), 0);
});
test('a terminal page with contradictory declared count cannot publish', async () => {
  await assert.rejects(scan(undefined, { request: async () => '{"data":[],"current_page":1,"next_page_url":null,"total":1}' }), { code: 'INVALID_PAGE' });
  await noPublished();
});
test('interrupted scan is discarded and a retry begins at page one', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(scan(undefined, { signal: controller.signal, request: async () => {
    if (++calls === 1) return body([raw()], 1, initial + '?page=2');
    controller.abort(); throw new Error(CANARY);
  } }), { code: 'INTERRUPTED' });
  assert.equal((await state()).status, 'interrupted'); await noPublished();
  const mock = provider([[raw()], [raw({ orderlineid: 'synthetic-two' })]]);
  await scan(undefined, { request: mock.request }); assert.equal(mock.calls[0], initial);
  assert.equal(await count('sales_line'), 2); assert.equal(await count('sales_stage_line'), 0);
});
test('staging batch errors roll back that entire batch and no publication occurs', async () => {
  await db.query(`CREATE FUNCTION sales_foundation.fail_stage() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
    CREATE TRIGGER fail_stage BEFORE INSERT ON sales_foundation.sales_stage_line FOR EACH ROW EXECUTE FUNCTION sales_foundation.fail_stage()`);
  await assert.rejects(scan(), { code: 'DB_OPERATION_FAILED' }); await noPublished();
  assert.equal(await count('sales_stage_line'), 0); assert.equal((await state()).status, 'failed');
});
test('late publication error rolls back facts, day coverage and bucket checkpoint atomically', async () => {
  await db.query(`CREATE FUNCTION sales_foundation.fail_day() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
    CREATE TRIGGER fail_day BEFORE INSERT ON sales_foundation.sales_day_state FOR EACH ROW EXECUTE FUNCTION sales_foundation.fail_day()`);
  await assert.rejects(scan(), { code: 'DB_OPERATION_FAILED' }); await noPublished();
  assert.equal((await state()).status, 'publication-pending');
  const id = (await db.query('SELECT run_id FROM sales_foundation.sales_import_scan')).rows[0].run_id;
  await db.query('DROP TRIGGER fail_day ON sales_foundation.sales_day_state');
  let requested = false;
  const result = await scan(undefined, { options: { ...options, resumePublication: id }, request: async () => { requested = true; throw new Error('No fetch during publication resume'); } });
  assert.equal(result.status, 'published'); assert.equal(requested, false); assert.equal(await count('sales_line'), 1);
});
test('durable monthly checkpoints preserve committed buckets across interrupted publication', async () => {
  const wider = { ...options, end: '2025-03-01' };
  await db.query(`CREATE FUNCTION sales_foundation.fail_later_day() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.business_date >= DATE '2025-02-01' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_later_day BEFORE INSERT ON sales_foundation.sales_day_state FOR EACH ROW EXECUTE FUNCTION sales_foundation.fail_later_day()`);
  await assert.rejects(scan([[raw(), raw({ orderlineid: 'synthetic-feb', timestamp_pay: '2025-02-10 12:00:00' })]], { options: wider }), { code: 'DB_OPERATION_FAILED' });
  assert.equal(await count('sales_line'), 1); assert.equal(await count('sales_import_bucket'), 1);
  const id = (await db.query('SELECT run_id FROM sales_foundation.sales_import_scan')).rows[0].run_id;
  const old = (await db.query('SELECT published_run FROM sales_foundation.sales_import_bucket')).rows[0].published_run;
  await db.query('DROP TRIGGER fail_later_day ON sales_foundation.sales_day_state');
  await scan(undefined, { options: { ...wider, resumePublication: id }, request: async () => { throw new Error('Must not request'); } });
  assert.equal(await count('sales_line'), 2); assert.equal(await count('sales_import_bucket'), 2);
  assert.equal((await db.query('SELECT published_run FROM sales_foundation.sales_import_bucket WHERE start_date = $1', [start])).rows[0].published_run, old);
});
test('actual SQL staging inserts are bounded to configured batches', async () => {
  await db.query(`CREATE TABLE sales_foundation.synthetic_batch_audit (size integer);
    CREATE FUNCTION sales_foundation.observe_batch() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO sales_foundation.synthetic_batch_audit SELECT count(*) FROM new_rows; RETURN NULL; END $$;
    CREATE TRIGGER observe_batch AFTER INSERT ON sales_foundation.sales_stage_line REFERENCING NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION sales_foundation.observe_batch()`);
  await scan([Array.from({ length: 601 }, (_, i) => raw({ orderlineid: 'synthetic-' + i }))]);
  assert.deepEqual((await db.query('SELECT size FROM sales_foundation.synthetic_batch_audit')).rows.map(row => row.size), [250, 250, 101]);
});
test('fractional ore, signed quantity and very large numeric identity survive parsing and PostgreSQL exactly', async () => {
  const id = '900719925474099312345678901234567890';
  await scan([[raw({ orderlineid: id, price: '-12.123456789012345678', priceexclvat: '-8.004', count: '-3.125' })]]);
  const line = (await db.query('SELECT source_key, revenue_incl::text AS incl, revenue_excl::text AS excl, quantity::text FROM sales_foundation.sales_line')).rows[0];
  assert.ok(line.source_key.equals(context.identity.protect('norrebro', id)));
  assert.equal(line.incl, '-12.123456789012345678'); assert.equal(line.excl, '-8.004'); assert.equal(line.quantity, '-3.125');
  const totals = (await db.query('SELECT negative_price_count, negative_quantity_count, refund_excl::text FROM sales_foundation.sales_import_scan')).rows[0];
  assert.equal(totals.negative_price_count, 1); assert.equal(totals.negative_quantity_count, 1); assert.equal(totals.refund_excl, '-8.004');
});
test('count greater than one never multiplies signed line totals', async () => {
  const result = await scan([[raw({ count: '3', price: '10.111', priceexclvat: '7.004' })]]);
  assert.equal(result.revenueIncl, '10.111'); assert.equal(result.revenueExcl, '7.004');
});
test('missing stable identity quarantines fresh coverage without publishing facts', async () => {
  for (const orderlineid of [undefined, null]) {
    await assert.rejects(scan([[raw({ orderlineid })]]), { code: 'INVALID_LINE' });
    assert.equal((await state()).status, 'quarantined');
    assert.equal((await state()).error_code, 'INVALID_LINE');
    const coverage = await covered();
    assert.equal(coverage.latestAttempt, 'quarantined');
    assert.ok(coverage.days.every(day => day.status === 'conflict-quarantine' && day.lineCount === null));
    await noPublished(); assert.equal(await count('sales_stage_line'), 0);
  }
});
test('malformed stable identities quarantine the candidate rather than report never synchronized', async () => {
  for (const orderlineid of ['', '01', '-1', 'synthetic invalid id']) {
    await assert.rejects(scan([[raw({ orderlineid })]]), { code: 'INVALID_LINE' });
    assert.equal((await state()).status, 'quarantined');
    assert.ok((await covered()).days.every(day => day.status === 'conflict-quarantine'));
    await noPublished(); assert.equal(await count('sales_stage_line'), 0);
  }
});
test('an invalid identity after a staged valid page quarantines the whole mixed candidate', async () => {
  let page = 0;
  await assert.rejects(scan(undefined, { request: async () => {
    if (++page === 1) return body([raw()], 1, initial + '?page=2');
    assert.equal(await count('sales_stage_line'), 1);
    return body([raw({ orderlineid: null })], 2);
  } }), { code: 'INVALID_LINE' });
  assert.equal(page, 2); assert.equal((await state()).status, 'quarantined');
  assert.equal(await count('sales_stage_line'), 0); await noPublished();
  assert.ok((await covered()).days.every(day => day.status === 'conflict-quarantine'));
});
test('identity quarantine preserves an existing published snapshot and its coverage', async () => {
  await scan();
  const priorFacts = (await db.query('SELECT xmin::text, * FROM sales_foundation.sales_line')).rows;
  const priorDays = (await db.query('SELECT * FROM sales_foundation.sales_day_state ORDER BY business_date')).rows;
  const priorCoverage = await covered();
  await assert.rejects(scan([[raw({ price: '99' }), raw({ orderlineid: 'synthetic-new' })],
    [raw({ orderlineid: null })]]), { code: 'INVALID_LINE' });
  assert.equal((await state()).status, 'quarantined');
  assert.deepEqual((await db.query('SELECT xmin::text, * FROM sales_foundation.sales_line')).rows, priorFacts);
  assert.deepEqual((await db.query('SELECT * FROM sales_foundation.sales_day_state ORDER BY business_date')).rows, priorDays);
  const coverage = await covered();
  assert.equal(coverage.latestAttempt, 'quarantined'); assert.deepEqual(coverage.days, priorCoverage.days);
  assert.equal(await count('sales_line'), 1); assert.equal(await count('sales_import_bucket'), 1);
  assert.equal(await count('sales_stage_line'), 0);
});
test('repeated identity quarantine leaves no duplicate data state and failure finalization is idempotent', async () => {
  const pages = [[raw()], [raw({ orderlineid: null })]];
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(scan(pages), { code: 'INVALID_LINE' });
    await noPublished(); assert.equal(await count('sales_stage_line'), 0);
    assert.equal(await count('sales_import_discrepancy'), 0);
    assert.ok((await covered()).days.every(day => day.status === 'conflict-quarantine'));
  }
  // Each page-one traversal keeps its own audit run, never duplicate facts or
  // coverage. Re-finalizing the same run must not create another audit record.
  const attempts = (await db.query('SELECT run_id, status, error_code FROM sales_foundation.sales_import_scan ORDER BY run_id')).rows;
  assert.equal(attempts.length, 2); assert.notEqual(attempts[0].run_id, attempts[1].run_id);
  assert.ok(attempts.every(row => row.status === 'quarantined' && row.error_code === 'INVALID_LINE'));
  await withImportOwner(config, async session => {
    const repo = createImportRepository(session, context), run = { id: attempts[0].run_id };
    await repo.failed(run, 'INVALID_LINE'); await repo.failed(run, 'INVALID_LINE');
  });
  assert.deepEqual((await db.query('SELECT run_id, status, error_code FROM sales_foundation.sales_import_scan ORDER BY run_id')).rows, attempts);
  await noPublished(); assert.equal(await count('sales_stage_line'), 0);
});
test('a clean retry after identity quarantine publishes and independently verifies normally', async () => {
  await assert.rejects(scan([[raw({ orderlineid: null })]]), { code: 'INVALID_LINE' });
  const rejectedId = (await db.query('SELECT run_id FROM sales_foundation.sales_import_scan')).rows[0].run_id;
  await assert.rejects(scan(undefined, { options: { ...options, verificationOf: rejectedId } }), { code: 'INVALID_RUN' });
  await noPublished();
  const clean = await scan();
  assert.equal(clean.status, 'published'); assert.equal(clean.verified, false);
  assert.ok((await covered()).days.every(day => day.status === 'complete-single-pass'));
  const verified = await scan(undefined, { options: { ...options, verificationOf: clean.runId } });
  assert.equal(verified.status, 'verified'); assert.equal(verified.verified, true);
  const coverage = await covered(); assert.equal(coverage.latestAttempt, 'published');
  assert.ok(coverage.days.every(day => day.status === (day.date === '2025-01-10' ? 'independently-verified' : 'verified-empty')));
  assert.equal(await count('sales_line'), 1); assert.equal(await count('sales_stage_line'), 0);
  assert.equal((await db.query('SELECT status FROM sales_foundation.sales_import_scan WHERE run_id = $1', [rejectedId])).rows[0].status, 'quarantined');
});
test('provider failures stay operational failures rather than data quarantine', async () => {
  for (const failure of [new Error(CANARY), new ImportError('UPSTREAM_RATE_LIMIT')]) {
    await assert.rejects(scan(undefined, { request: async () => { throw failure; } }),
      { code: failure.code || 'UPSTREAM_FAILED' });
    assert.equal((await state()).status, 'failed');
    assert.equal((await covered()).latestAttempt, 'failed');
    await noPublished(); assert.equal(await count('sales_stage_line'), 0);
  }
});
test('identity quarantine retains only safe metadata and fixed errors without private identifiers or payloads', async () => {
  const reports = [], invalidId = CANARY + ' invalid', validId = 'synthetic-private-source-id';
  const candidate = raw({ orderlineid: invalidId, customer: CANARY, credentials: CANARY, rawResponse: CANARY });
  await assert.rejects(scan([[raw({ orderlineid: validId })], [candidate]], { report: value => reports.push(value) }), error => {
    assert.equal(error.code, 'INVALID_LINE'); assert.equal(error.message, 'INVALID_LINE');
    assert.ok(!String(error.stack).includes(CANARY)); assert.ok(!JSON.stringify(error).includes(CANARY));
    return true;
  });
  assert.equal((await state()).status, 'quarantined');
  for (const table of ['sales_line', 'sales_stage_line', 'sales_sync_run', 'sales_day_state', 'sales_import_scan',
    'sales_import_day', 'sales_import_bucket', 'sales_import_discrepancy', 'identity_key_check']) {
    const result = await db.query(`SELECT coalesce(bool_or(row_to_json(t)::text LIKE $1 OR row_to_json(t)::text LIKE $2), false) AS leaked
      FROM sales_foundation.${table} t`, ['%' + CANARY + '%', '%' + validId + '%']);
    assert.equal(result.rows[0].leaked, false, 'quarantine metadata privacy scan');
  }
  const serialized = JSON.stringify(reports);
  assert.ok(!serialized.includes(CANARY) && !serialized.includes(validId), 'quarantine report privacy scan');
  assert.ok(!serialized.includes(context.identity.protect(options.storeSlug, validId).toString('hex')), 'protected identity report scan');
  assert.ok(!reports.some(row => row.status === 'published'));
  await noPublished(); assert.equal(await count('sales_stage_line'), 0);
});
test('same-ID identical replay deduplicates and repeated publications do not rewrite facts', async () => {
  await scan([[raw(), raw({ customer: CANARY })]]);
  const xmin = (await db.query('SELECT xmin::text FROM sales_foundation.sales_line')).rows[0].xmin;
  await scan(); assert.equal(await count('sales_line'), 1);
  assert.equal((await db.query('SELECT xmin::text FROM sales_foundation.sales_line')).rows[0].xmin, xmin);
});
test('same-ID content conflict in different pages quarantines the whole scan', async () => {
  await assert.rejects(scan([[raw()], [raw({ priceexclvat: '9' })]]), { code: 'SOURCE_CONFLICT' });
  assert.equal((await state()).status, 'quarantined'); await noPublished();
  assert.equal((await covered()).days[0].status, 'conflict-quarantine');
});
test('changed safe content is a correction candidate and preserves the prior published snapshot', async () => {
  await scan();
  await assert.rejects(scan([[raw({ priceexclvat: '9' })]]), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal((await db.query('SELECT revenue_excl::text AS value FROM sales_foundation.sales_line')).rows[0].value, '8');
  assert.equal(await count('sales_import_discrepancy'), 1); assert.equal((await state()).status, 'quarantined');
});
test('changed business date preserves both old and new affected-date provenance', async () => {
  await scan();
  await assert.rejects(scan([[raw({ timestamp_pay: '2025-01-11 12:00:00' })]]), { code: 'RECONCILIATION_REQUIRED' });
  const row = (await db.query('SELECT old_date::text, new_date::text, kind FROM sales_foundation.sales_import_discrepancy')).rows[0];
  assert.deepEqual(row, { old_date: '2025-01-10', new_date: '2025-01-11', kind: 'changed' });
});
test('different protected identities preserve otherwise identical purchases', async () => {
  const result = await scan([[raw(), raw({ orderlineid: 'synthetic-distinct' })]]);
  assert.equal(result.lineCount, 2); assert.equal(result.revenueExcl, '16');
});
test('a single absence creates a discrepancy and never deletes or deactivates a fact', async () => {
  await scan(); const before = await covered();
  await assert.rejects(scan([[]]), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(await count('sales_line'), 1);
  assert.deepEqual((await covered()).days, before.days);
  assert.equal((await db.query('SELECT kind FROM sales_foundation.sales_import_discrepancy')).rows[0].kind, 'missing');
  assert.equal((await db.query('SELECT reconciliation_state FROM sales_foundation.sales_line')).rows[0].reconciliation_state, 'active');
});
test('never synchronized, staged, single-pass empty and independently verified empty are distinct', async () => {
  assert.equal((await covered()).days[0].status, 'never-synchronized');
  const first = await scan([[]], { request: async () => {
    const view = await createImportRepository({ query: (...args) => db.query(...args) }, context).coverage({ storeSlug: 'norrebro', start, end });
    assert.equal(view.days[0].status, 'staged'); return body([]);
  } });
  assert.equal((await covered()).days[0].status, 'complete-single-pass');
  await scan([[]], { options: { ...options, verificationOf: first.runId } });
  const view = await covered(); assert.ok(view.days.every(day => day.status === 'verified-empty' && day.lineCount === 0));
});
test('store-scoped identities and coverage are isolated', async () => {
  await scan(); await scan([[raw({ priceexclvat: '99' })]], { options: { ...options, storeSlug: 'vesterbro' } });
  const totals = (await db.query('SELECT store_id, sum(revenue_excl)::text AS value FROM sales_foundation.sales_line GROUP BY store_id ORDER BY store_id')).rows;
  assert.deepEqual(totals, [{ store_id: 2, value: '99' }, { store_id: 6, value: '8' }]);
  assert.ok((await covered('fisketorvet')).days.every(day => day.status === 'never-synchronized'));
  await assert.rejects(scan([[raw({ firmaid: '54321' })]]), { code: 'STORE_MISMATCH' });
});
test('independent verification matches sorted content despite page order and private field changes', async () => {
  const a = raw(), b = raw({ orderlineid: 'synthetic-two' });
  const first = await scan([[a], [b]]);
  const second = await scan([[{ ...b, customer: CANARY }, a]], { options: { ...options, verificationOf: first.runId } });
  assert.equal(second.status, 'verified'); assert.equal(second.verified, true);
  assert.equal((await covered()).days.find(day => day.date === '2025-01-10').status, 'independently-verified');
});
test('independent verification detects an added zero-value identity despite unchanged revenue', async () => {
  const first = await scan();
  // Addition instead of replacement avoids the earlier conservative absence gate.
  await assert.rejects(scan([[raw(), raw({ orderlineid: 'synthetic-zero', price: '0', priceexclvat: '0', count: '0' })]],
    { options: { ...options, verificationOf: first.runId } }), { code: 'VERIFICATION_MISMATCH' });
  assert.equal(await count('sales_line'), 1); assert.equal((await state()).status, 'quarantined');
});
test('independent per-date checksum mismatch rejects equal count and exact totals', async () => {
  const first = await scan();
  await db.query('UPDATE sales_foundation.sales_import_day SET content_digest = $2 WHERE run_id = $1', [first.runId, Buffer.alloc(32, 9)]);
  await assert.rejects(scan(undefined, { options: { ...options, verificationOf: first.runId } }), { code: 'VERIFICATION_MISMATCH' });
  assert.equal(await count('sales_line'), 1); assert.equal((await state()).status, 'quarantined');
});
test('tampered durable staging summaries cannot certify publication on resume', async () => {
  await withImportOwner(config, async session => {
    const repo = createImportRepository(session, context);
    const run = await repo.begin({ ...options, observedAt: new Date().toISOString() });
    await repo.stage(run, [{ line: normalizeLine(raw(), { ...options, context }), page: 1, position: 0 }]);
    await repo.progress(run, { pages: 1, rows: 1, reviewCount: 0 });
    await repo.finishScan(run, { terminal: true });
    await session.query('UPDATE sales_foundation.sales_import_day SET revenue_excl = 0 WHERE run_id = $1', [run.id]);
    await assert.rejects(repo.preflight(run), { code: 'INVALID_RUN' });
    await repo.failed(run, 'INVALID_RUN');
  });
  await noPublished(); assert.equal((await state()).status, 'failed');
});
test('verification references cannot cross stores or bounds', async () => {
  const first = await scan();
  for (const change of [{ storeSlug: 'vesterbro' }, { end: '2025-01-20' }]) {
    await assert.rejects(scan(undefined, { options: { ...options, ...change, verificationOf: first.runId } }), { code: 'INVALID_RUN' });
  }
});
test('global advisory ownership excludes independent importers and Stage 1 publication locks', async () => {
  await withImportOwner(config, async () => {
    await assert.rejects(withImportOwner(config, async () => {}), { code: 'IMPORTER_BUSY' });
    const result = await db.transaction(session => session.query('SELECT pg_try_advisory_xact_lock($1, $2) AS acquired', IMPORT_LOCK));
    assert.equal(result.rows[0].acquired, false);
  });
  await withImportOwner(config, async () => {});
});
test('failed owner releases its connection and lock', async () => {
  let pid;
  await assert.rejects(withImportOwner(config, async session => {
    pid = (await session.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; throw new Error(CANARY);
  }), { code: 'DB_OPERATION_FAILED' });
  await withImportOwner(config, async () => {});
  assert.equal((await db.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0].count, 0);
});
async function childReady(mode) {
  const child = fork(path.join(__dirname, 'owner-child.js'), [mode], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: ['--require', path.join(__dirname, 'network-guard.js')],
    env: { KK_TEST_DATABASE_URL: config.connectionString, PGOPTIONS: process.env.PGOPTIONS || '' } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Synthetic child ready timeout')); }, 10000);
    child.once('message', message => { clearTimeout(timer); message.ready ? resolve() : reject(new Error('Unexpected child message')); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Synthetic child failed before ready')); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Synthetic child process failed')); });
  });
  return child;
}
test('SIGKILL releases the real session lock and interrupted fetch restarts from page one', async () => {
  const child = await childReady('scan');
  try {
    assert.equal(await count('sales_stage_line'), 1);
    await assert.rejects(withImportOwner(config, async () => {}), { code: 'IMPORTER_BUSY' });
  } finally { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  const mock = provider([[raw({ orderlineid: 'synthetic-after-kill' })]]);
  await scan(undefined, { request: mock.request });
  assert.equal(mock.calls[0], initial); assert.equal(await count('sales_line'), 1); assert.equal(await count('sales_stage_line'), 0);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM sales_foundation.sales_import_scan WHERE status = 'interrupted'")).rows[0].count, 1);
});
test('database connection loss fences the old importer instead of borrowing a replacement', async () => {
  await assert.rejects(withImportOwner(config, async session => {
    const pid = (await session.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await db.query('SELECT pg_terminate_backend($1)', [pid]);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(session.signal.aborted, true);
    await session.query('SELECT 1');
  }), { code: 'LOCK_LOST' });
  await withImportOwner(config, async () => {}); await noPublished();
});
test('unknown product and payment values produce only review counts with no persisted free text', async () => {
  for (const field of ['productname', 'paymenttype']) {
    await assert.rejects(scan([[raw({ [field]: CANARY })]]), { code: 'CATALOG_REVIEW' });
    assert.equal((await state()).review_count, 1); assert.equal((await state()).status, 'quarantined'); await noPublished();
    assert.equal(await count('sales_stage_line'), 0);
  }
});
test('Copenhagen DST transitions, midnight and explicitly ambiguous autumn time survive import', async () => {
  const rows = [raw({ orderlineid: 'synthetic-spring', timestamp_pay: '2025-03-30 00:00:00' }),
    raw({ orderlineid: 'synthetic-autumn', timestamp_pay: '2025-10-26 02:30:00' })];
  await scan([rows], { options: { ...options, end: '2025-11-01' } });
  const values = (await db.query('SELECT second_of_day, time_quality FROM sales_foundation.sales_line ORDER BY business_date')).rows;
  assert.deepEqual(values, [{ second_of_day: 0, time_quality: 'payment' }, { second_of_day: 9000, time_quality: 'payment_ambiguous' }]);
  await assert.rejects(scan([[raw({ timestamp_pay: '2025-03-30 02:30:00' })]], { options: { ...options, end: '2025-11-01' } }), { code: 'INVALID_LINE' });
});
test('prohibited canaries and raw source identities never reach staging, facts, serializers or reports', async () => {
  const reports = [], item = raw({ orderlineid: CANARY, customer: CANARY, debtor: CANARY, cardnumber: CANARY,
    clerk: CANARY, employee: CANARY, orderid: CANARY, company: CANARY, account: CANARY,
    terminal: CANARY, table: CANARY, pax: CANARY, headers: { token: CANARY }, rawResponse: CANARY });
  const hasCanary = async table => (await db.query(`SELECT coalesce(bool_or(row_to_json(t)::text LIKE $1), false) AS leaked FROM sales_foundation.${table} t`, ['%' + CANARY + '%'])).rows[0].leaked;
  let page = 0;
  await scan(undefined, { report: row => reports.push(row), request: async () => {
    if (++page === 1) return body([item], 1, initial + '?page=2');
    assert.equal(await count('sales_stage_line'), 1); assert.equal(await hasCanary('sales_stage_line'), false);
    return body([], 2);
  } });
  for (const table of ['sales_line', 'sales_stage_line', 'sales_sync_run', 'sales_day_state', 'sales_import_scan', 'sales_import_day', 'sales_import_bucket', 'sales_import_discrepancy']) {
    assert.equal(await hasCanary(table), false, 'database privacy scan');
  }
  const repo = createRepository(db, context), publicRows = await repo.lines({ storeSlug: 'norrebro', start, end });
  assert.ok(!JSON.stringify(publicRows).includes(CANARY), 'serializer privacy scan');
  assert.ok(!JSON.stringify(reports).includes(CANARY), 'report privacy scan');
  assert.ok(!JSON.stringify(reports).includes(context.identity.protect('norrebro', CANARY).toString('hex')), 'protected identity report scan');
  const columns = (await db.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'sales_foundation'")).rows;
  assert.ok(columns.every(row => !['json', 'jsonb'].includes(row.data_type)));
  assert.ok(columns.every(row => !/customer|card|clerk|employee|account|order|credential|password|raw_response/.test(row.column_name)));
});
test('changed identity key cannot initialize a second identity namespace', async () => {
  await scan();
  await assert.rejects(scan(undefined, { context: { ...context, identity: createIdentity({ key: Buffer.alloc(32, 9), version: 1 }) } }), { code: 'IDENTITY_MISMATCH' });
  assert.equal(await count('sales_line'), 1);
});
test('dry-run does not create run, identity or staging rows on an actual configured database', async () => {
  const result = await scan(undefined, { apply: false }); assert.equal(result.status, 'validated-only');
  await noPublished(); assert.equal(await count('sales_import_scan'), 0); assert.equal(await count('sales_stage_line'), 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sales_foundation.identity_key_check')).rows[0].n, 0);
});
test('CLI requires apply for database writes and exits nonzero on incomplete traversal', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-importer-catalog-'));
  const file = path.join(directory, 'reviewed.json');
  await fs.writeFile(file, JSON.stringify({ products: [{ storeSlug: 'norrebro', productId: 'synthetic-product', productLabel: 'Synthetic product',
    groupId: 'synthetic-group', groupLabel: 'Synthetic group' }], payments: [{ paymentType: 'Synthetic payment', paymentCode: 'TEST' }] }));
  const args = ['--store', 'norrebro', '--from', start, '--through', end, '--catalog', file];
  const env = { KK_SALES_DB_ENABLED: 'true', KK_SALES_DB_URL: config.connectionString,
    KK_SALES_IDENTITY_KEY_HEX: Buffer.alloc(32, 7).toString('hex'), KK_SALES_IDENTITY_KEY_VERSION: '1', KK_BACKFILL_COMPANY_ID: '12345' };
  const reports = [];
  try {
    assert.equal(await main(args, env, text => reports.push(text), { request: provider([[raw()]]).request }), 0);
    assert.equal(await count('sales_import_scan'), 0);
    assert.equal(await main([...args, '--apply'], env, text => reports.push(text), { request: async () => '{}' }), 1);
    await noPublished(); assert.equal((await state()).status, 'failed');
    assert.ok(!reports.some(text => text.includes('"status":"published"')));
    assert.ok(!reports.join('').includes(CANARY));
    let page = 0;
    const graceful = await main([...args, '--apply'], env, text => reports.push(text), { request: async (url, { signal }) => {
      if (++page === 1) return body([raw()], 1, initial + '?page=2');
      setImmediate(() => process.emit('SIGTERM'));
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new ImportError('INTERRUPTED')), { once: true }));
    } });
    assert.equal(graceful, 1); assert.equal((await state()).status, 'interrupted');
    await noPublished(); assert.equal(await count('sales_stage_line'), 0);
  } finally { await fs.rm(directory, { recursive: true }); }
});
test('real importer preserves the unchanged reference fixture and all canonical metric values', async () => {
  const fixture = parseLossless(await fs.readFile(path.join(__dirname, '../fixtures/norrebro-2026-09-20.fixture.json'), 'utf8'));
  const ctx = { identity: context.identity, catalog: createReviewedCatalog(require('../sales-db/reviewed-fixture-catalog.json')) };
  const source = fixture.lines.map(item => ({ orderlineid: item.line_id, timestamp_pay: item.date,
    productid: item.productid, productname: item.productname, productgroup: item.productgroup,
    count: item.count, price: item.price, priceexclvat: item.priceexclvat, paymenttype: item.paymenttype }));
  const fixtureOptions = { ...options, start: '2026-09-20', end: '2026-09-21' };
  const result = await scan([source], { options: fixtureOptions, context: ctx });
  assert.equal(result.lineCount, 466); assert.equal(result.revenueExcl, '13143.68');
  assert.equal((await db.query("SELECT sum(revenue_excl)::text AS value FROM sales_foundation.sales_line WHERE payment_type = 'Wolt'")).rows[0].value, '2120.48');
  const values = (await createRepository(db, ctx).lines({ storeSlug: 'norrebro', start: fixtureOptions.start, end: fixtureOptions.end, limit: 1000 })).lines;
  // Conversion is only the unchanged legacy metric boundary in this parity test.
  const metrics = computeMetrics(values.map(line => ({ productid: line.productId, count: Number(line.quantity), price: Number(line.revenueIncl) })));
  assert.equal(metrics.komboUnits, 66); assert.equal(metrics.rollUnits, 54); assert.equal(Math.round(metrics.komboPct), 55); assert.equal(metrics.lemUnits, 20);
});
test('large synthetic traversal uses bounded pages and staging without retaining history in memory', { timeout: 240000 }, async () => {
  const result = await simulate(config);
  assert.equal(result.rows, 100000); assert.equal(result.pages, 100); assert.equal(result.rowsBuiltAtOnce, 1000);
  assert.equal(await count('sales_line'), 100000); assert.equal(await count('sales_stage_line'), 0);
  assert.ok(result.peakHeapBytes < 256 * 1024 * 1024, 'bounded heap budget');
  assert.ok(result.latePeakHeapBytes - result.earlyPeakHeapBytes < 96 * 1024 * 1024, 'bounded retained-memory growth');
  console.log('Synthetic importer memory result: ' + JSON.stringify(result));
});
