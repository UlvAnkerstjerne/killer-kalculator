'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { validateSafeLine } = require('../sales-db/facts');
const { storeId, range } = require('../sales-db/values');
const { summarize, months, accumulator, sameSummary, units, amount } = require('./checksums');
const { fail, checkSignal } = require('./errors');

const FIELDS = [
  ['store_id', 'storeId'], ['source_key', 'sourceKey'], ['key_version', 'keyVersion'],
  ['business_date', 'businessDate'], ['sale_local', 'saleLocal'], ['second_of_day', 'secondOfDay'],
  ['time_quality', 'timeQuality'], ['product_id', 'productId'], ['product_label', 'productLabel'],
  ['group_id', 'groupId'], ['group_label', 'groupLabel'], ['quantity', 'quantity'],
  ['revenue_incl', 'revenueIncl'], ['revenue_excl', 'revenueExcl'], ['payment_type', 'paymentType'],
  ['payment_code', 'paymentCode'], ['fingerprint', 'fingerprint'],
];
const COLUMNS = FIELDS.map(([sql]) => sql).join(', ');
const PROJECTION = FIELDS.map(([sql, js]) => {
  if (sql === 'sale_local') return `to_char(sale_local, 'YYYY-MM-DD HH24:MI:SS') AS "${js}"`;
  const cast = ['business_date', 'quantity', 'revenue_incl', 'revenue_excl'].includes(sql) ? '::text' : '';
  return `${sql}${cast} AS "${js}"`;
}).join(', ');
const EMPTY_HASH = createHash('sha256').digest();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function runId(value) { if (typeof value !== 'string' || !UUID.test(value)) fail('INVALID_RUN'); return value; }
function placeholders(rows) {
  let n = 0;
  return rows.map(row => '(' + row.map(() => '$' + (++n)).join(', ') + ')').join(', ');
}

function createImportRepository(session, context) {
  async function identity(initialize = false) {
    if (initialize) await session.query(`INSERT INTO sales_foundation.identity_key_check (singleton, key_version, check_digest)
      VALUES (true, $1, $2) ON CONFLICT DO NOTHING`, [context.identity.version, context.identity.check()]);
    const { rows } = await session.query('SELECT key_version, check_digest FROM sales_foundation.identity_key_check');
    if (rows.length !== 1 || rows[0].key_version !== context.identity.version || !rows[0].check_digest.equals(context.identity.check())) fail('IDENTITY_MISMATCH');
  }
  async function purge(id) {
    // Only sanitized staging for this run. Never delete/deactivate a fact.
    while (true) {
      const result = await session.query(`DELETE FROM sales_foundation.sales_stage_line WHERE ctid IN
        (SELECT ctid FROM sales_foundation.sales_stage_line WHERE run_id = $1 LIMIT 1000)`, [runId(id)]);
      if (!result.rowCount) break;
    }
  }
  async function recover(store) {
    // Holding the exclusive owner lock proves no other CLI is still fetching.
    // An unfinished source scan is abandoned, never resumed at its page number.
    await session.query(`UPDATE sales_foundation.sales_import_scan SET status = 'interrupted', error_code = 'INTERRUPTED'
      WHERE store_id = $1 AND status IN ('fetching', 'staged', 'validated')`, [store]);
    const { rows } = await session.query(`SELECT run_id FROM sales_foundation.sales_import_scan i
      WHERE store_id = $1 AND status <> 'publication-pending' AND EXISTS
        (SELECT 1 FROM sales_foundation.sales_stage_line s WHERE s.run_id = i.run_id)`, [store]);
    for (const row of rows) await purge(row.run_id);
    const pending = await session.query(`SELECT 1 FROM sales_foundation.sales_import_scan
      WHERE store_id = $1 AND status = 'publication-pending' LIMIT 1`, [store]);
    if (pending.rows.length) fail('PUBLICATION_PENDING');
  }
  async function begin(options) {
    const id = storeId(options.storeSlug);
    await session.transaction(() => identity(true));
    await recover(id);
    const run = { id: randomUUID(), store: id, start: options.start, end: options.end, observedAt: options.observedAt,
      verificationOf: options.verificationOf ?? null };
    if (run.verificationOf) runId(run.verificationOf);
    await session.transaction(async () => {
      await identity(true);
      if (run.verificationOf) {
        const old = await session.query(`SELECT 1 FROM sales_foundation.sales_import_scan i
          JOIN sales_foundation.sales_sync_run r USING (run_id, store_id)
          WHERE i.run_id = $1 AND i.store_id = $2 AND r.start_date = $3 AND r.end_date = $4
            AND i.terminal AND i.status = 'published' AND i.scan_finished_at < $5`,
        [run.verificationOf, id, run.start, run.end, run.observedAt]);
        if (!old.rows.length) fail('INVALID_RUN');
      }
      await session.query(`INSERT INTO sales_foundation.sales_sync_run
        (run_id, store_id, start_date, end_date, observed_at, state, line_count, content_digest, run_kind)
        VALUES ($1, $2, $3, $4, $5, 'staging', 0, $6, 'backfill')`,
      [run.id, id, run.start, run.end, run.observedAt, EMPTY_HASH]);
      await session.query(`INSERT INTO sales_foundation.sales_import_scan (run_id, store_id, status, verification_of)
        VALUES ($1, $2, 'fetching', $3)`, [run.id, id, run.verificationOf]);
    });
    return Object.freeze(run);
  }
  async function stage(run, batch) {
    if (!Array.isArray(batch) || !batch.length || batch.length > 500) fail('INVALID_OPTIONS');
    // Copy/validate before the first await. Safe fields alone enter SQL parameters.
    const unique = new Map();
    for (const { line, page, position } of batch) {
      validateSafeLine(line, context);
      if (line.storeId !== run.store || !Number.isInteger(page) || page < 1 || page > 10000 ||
          !Number.isInteger(position) || position < 0 || position >= 10000) fail('STORE_MISMATCH');
      const key = line.sourceKey.toString('hex');
      const safe = Object.fromEntries(FIELDS.map(([, field]) => [field,
        Buffer.isBuffer(line[field]) ? Buffer.from(line[field]) : line[field]]));
      if (unique.has(key) && !unique.get(key).line.fingerprint.equals(safe.fingerprint)) fail('SOURCE_CONFLICT');
      unique.set(key, { line: safe, page, position });
    }
    await session.transaction(async () => {
      const state = await session.query('SELECT status FROM sales_foundation.sales_import_scan WHERE run_id = $1 AND store_id = $2', [run.id, run.store]);
      if (state.rows[0]?.status !== 'fetching') fail('INVALID_RUN');
      const prior = await session.query(`SELECT source_key, fingerprint FROM sales_foundation.sales_stage_line
        WHERE run_id = $1 AND store_id = $2 AND source_key = ANY($3::bytea[])`,
      [run.id, run.store, [...unique.values()].map(x => x.line.sourceKey)]);
      for (const row of prior.rows) if (!unique.get(row.source_key.toString('hex')).line.fingerprint.equals(row.fingerprint)) fail('SOURCE_CONFLICT');
      const values = [...unique.values()].map(({ line, page, position }) => [
        ...FIELDS.map(([, key]) => line[key]), run.observedAt, run.observedAt, run.id, run.id, page, position,
      ]);
      const inserted = await session.query(`INSERT INTO sales_foundation.sales_stage_line
        (${COLUMNS}, first_seen_at, content_changed_at, last_seen_run, run_id, source_page, source_position)
        VALUES ${placeholders(values)} ON CONFLICT (run_id, store_id, source_key) DO NOTHING`, values.flat());
      await session.query('UPDATE sales_foundation.sales_sync_run SET line_count = line_count + $2 WHERE run_id = $1', [run.id, inserted.rowCount]);
    });
  }
  async function progress(run, { pages, rows, reviewCount }) {
    await session.query(`UPDATE sales_foundation.sales_import_scan SET pages = $2, received_rows = $3, review_count = $4
      WHERE run_id = $1 AND status = 'fetching'`, [run.id, pages, rows, reviewCount]);
  }
  async function* ordered(run, { start = null, end = null, facts = false } = {}) {
    let after = Buffer.alloc(0);
    while (true) {
      const table = facts ? 'sales_line' : 'sales_stage_line';
      const { rows } = await session.query(`SELECT ${PROJECTION} FROM sales_foundation.${table}
        WHERE store_id = $1 AND source_key > $2
          AND ($3::date IS NULL OR business_date >= $3) AND ($4::date IS NULL OR business_date < $4)
          ${facts ? '' : 'AND run_id = $5'} ORDER BY source_key LIMIT 500`,
      facts ? [run.store, after, start, end] : [run.store, after, start, end, run.id]);
      if (!rows.length) break;
      for (const row of rows) { validateSafeLine(row, context); yield row; }
      after = rows.at(-1).sourceKey;
    }
  }
  async function finishScan(run, traversal) {
    if (traversal.terminal !== true) fail('INVALID_PAGE');
    await session.query(`UPDATE sales_foundation.sales_import_scan SET terminal = true, status = 'staged',
      scan_finished_at = clock_timestamp() WHERE run_id = $1 AND status = 'fetching'`, [run.id]);
    // Filtering/bucketing only now: the source has explicitly terminated.
    const summary = await summarize(ordered(run), run.start, run.end);
    for (let offset = 0; offset < summary.days.length; offset += 250) {
      const values = summary.days.slice(offset, offset + 250).map(day => [run.id, run.store, day.date,
        day.count, day.revenueIncl, day.revenueExcl, day.quantity, day.negativePrice, day.negativeQuantity,
        day.refundIncl, day.refundExcl, day.digest]);
      await session.query(`INSERT INTO sales_foundation.sales_import_day
        (run_id, store_id, business_date, line_count, revenue_incl, revenue_excl, quantity,
         negative_price_count, negative_quantity_count, refund_incl, refund_excl, content_digest)
        VALUES ${placeholders(values)}`, values.flat());
    }
    const t = summary.total;
    await session.transaction(async () => {
      await session.query('UPDATE sales_foundation.sales_sync_run SET content_digest = $2 WHERE run_id = $1', [run.id, t.digest]);
      await session.query(`UPDATE sales_foundation.sales_import_scan SET logical_count = $2, revenue_incl = $3,
        revenue_excl = $4, quantity = $5, negative_price_count = $6, negative_quantity_count = $7,
        refund_incl = $8, refund_excl = $9 WHERE run_id = $1`,
      [run.id, t.count, t.revenueIncl, t.revenueExcl, t.quantity, t.negativePrice, t.negativeQuantity, t.refundIncl, t.refundExcl]);
    });
    return summary.total;
  }
  async function preflight(run) {
    await identity();
    const scan = (await session.query(`SELECT status, terminal, verified FROM sales_foundation.sales_import_scan
      WHERE run_id = $1 AND store_id = $2`, [run.id, run.store])).rows[0];
    if (!scan?.terminal || !['staged', 'publication-pending'].includes(scan.status)) fail('INVALID_RUN');
    // Re-read the durable snapshot: completion metadata alone is not evidence.
    // This also guards publication-only resume after process loss.
    const snapshot = await summarize(ordered(run), run.start, run.end);
    const recorded = (await session.query(`SELECT i.logical_count AS count, i.revenue_incl::text AS "revenueIncl",
      i.revenue_excl::text AS "revenueExcl", i.quantity::text, i.negative_price_count AS "negativePrice",
      i.negative_quantity_count AS "negativeQuantity", i.refund_incl::text AS "refundIncl", i.refund_excl::text AS "refundExcl",
      r.content_digest AS digest FROM sales_foundation.sales_import_scan i JOIN sales_foundation.sales_sync_run r USING (run_id)
      WHERE i.run_id = $1`, [run.id])).rows[0];
    const canonical = row => {
      for (const key of ['revenueIncl', 'revenueExcl', 'quantity', 'refundIncl', 'refundExcl']) row[key] = amount(units(row[key]));
      return row;
    };
    if (!sameSummary(snapshot.total, canonical(recorded))) fail('INVALID_RUN');
    const savedDays = (await session.query(`SELECT business_date::text AS date, line_count AS count,
      revenue_incl::text AS "revenueIncl", revenue_excl::text AS "revenueExcl", quantity::text,
      negative_price_count AS "negativePrice", negative_quantity_count AS "negativeQuantity",
      refund_incl::text AS "refundIncl", refund_excl::text AS "refundExcl", content_digest AS digest
      FROM sales_foundation.sales_import_day WHERE run_id = $1 ORDER BY business_date`, [run.id])).rows;
    if (savedDays.length !== snapshot.days.length || savedDays.some((day, i) =>
      day.date !== snapshot.days[i].date || !sameSummary(snapshot.days[i], canonical(day)))) fail('INVALID_RUN');
    // Compare against all prior facts in the logical range, and any identities
    // moving into it. Missing lines become candidates, never deletions.
    await session.query(`INSERT INTO sales_foundation.sales_import_discrepancy
      (run_id, store_id, source_key, kind, old_date, new_date, old_fingerprint, new_fingerprint)
      SELECT $1, p.store_id, p.source_key, CASE WHEN s.source_key IS NULL THEN 'missing' ELSE 'changed' END,
        p.business_date, s.business_date, p.fingerprint, s.fingerprint
      FROM sales_foundation.sales_line p LEFT JOIN sales_foundation.sales_stage_line s
        ON s.run_id = $1 AND s.store_id = p.store_id AND s.source_key = p.source_key
      WHERE p.store_id = $2 AND ((p.business_date >= $3 AND p.business_date < $4)
        OR (s.business_date >= $3 AND s.business_date < $4))
        AND (s.source_key IS NULL OR p.fingerprint <> s.fingerprint)
      ON CONFLICT DO NOTHING`, [run.id, run.store, run.start, run.end]);
    const discrepancies = await session.query('SELECT count(*)::int AS count FROM sales_foundation.sales_import_discrepancy WHERE run_id = $1', [run.id]);
    if (discrepancies.rows[0].count) fail('RECONCILIATION_REQUIRED');
    const newer = await session.query(`SELECT 1 FROM sales_foundation.sales_day_state WHERE store_id = $1
      AND business_date >= $2 AND business_date < $3 AND source_observed_at > $4 LIMIT 1`,
    [run.store, run.start, run.end, run.observedAt]);
    if (newer.rows.length) fail('RECONCILIATION_REQUIRED');
    const count = (await session.query('SELECT count(*)::int AS count FROM sales_foundation.sales_import_day WHERE run_id = $1', [run.id])).rows[0].count;
    if (count !== range(run.start, run.end, 36600).length) fail('INVALID_RUN');
    let verified = false;
    if (run.verificationOf) {
      const mismatch = await session.query(`SELECT 1 FROM sales_foundation.sales_import_day a
        FULL JOIN (SELECT * FROM sales_foundation.sales_import_day WHERE run_id = $2) b
          ON a.store_id = b.store_id AND a.business_date = b.business_date
        WHERE (a.run_id = $1 OR a.run_id IS NULL) AND
          (a.run_id IS NULL OR b.run_id IS NULL OR
           ROW(a.line_count, a.revenue_incl, a.revenue_excl, a.quantity, a.negative_price_count, a.negative_quantity_count,
               a.refund_incl, a.refund_excl, a.content_digest) IS DISTINCT FROM
           ROW(b.line_count, b.revenue_incl, b.revenue_excl, b.quantity, b.negative_price_count, b.negative_quantity_count,
               b.refund_incl, b.refund_excl, b.content_digest)) LIMIT 1`, [run.id, run.verificationOf]);
      if (mismatch.rows.length) fail('VERIFICATION_MISMATCH');
      verified = true;
    }
    await session.query(`UPDATE sales_foundation.sales_import_scan SET status = 'validated', verified = $2, error_code = NULL WHERE run_id = $1`, [run.id, verified]);
    return verified;
  }
  async function publicationBuckets(run) {
    const buckets = [];
    for (const month of months(run.start, run.end)) {
      const { rows } = await session.query(`SELECT business_date::text AS date, line_count FROM sales_foundation.sales_import_day
        WHERE run_id = $1 AND business_date >= $2 AND business_date < $3 ORDER BY business_date`, [run.id, month.start, month.end]);
      if (rows.some(day => day.line_count > 100000)) fail('ROW_LIMIT');
      if (rows.reduce((sum, day) => sum + day.line_count, 0) <= 100000) buckets.push(month);
      else for (const day of rows) buckets.push({ start: day.date, end: new Date(Date.parse(day.date) + 86400000).toISOString().slice(0, 10) });
    }
    return buckets;
  }
  async function publish(run, signal) {
    const buckets = await publicationBuckets(run); // All limits checked before any publication.
    await session.query(`UPDATE sales_foundation.sales_import_scan SET status = 'publication-pending' WHERE run_id = $1 AND status = 'validated'`, [run.id]);
    for (const bucket of buckets) {
      checkSignal(signal);
      await session.transaction(async () => {
        const done = await session.query('SELECT 1 FROM sales_foundation.sales_import_bucket WHERE scan_id = $1 AND start_date = $2', [run.id, bucket.start]);
        if (done.rows.length) return;
        const scan = (await session.query('SELECT status, verified FROM sales_foundation.sales_import_scan WHERE run_id = $1', [run.id])).rows[0];
        if (scan?.status !== 'publication-pending') fail('INVALID_RUN');
        const expected = accumulator();
        for await (const line of ordered(run, bucket)) expected.add(line);
        const totals = expected.finish();
        const id = randomUUID();
        await session.query(`INSERT INTO sales_foundation.sales_sync_run
          (run_id, store_id, start_date, end_date, observed_at, state, line_count, content_digest, published_at, run_kind)
          VALUES ($1, $2, $3, $4, $5, 'published', $6, $7, clock_timestamp(), 'backfill_bucket')`,
        [id, run.store, bucket.start, bucket.end, run.observedAt, totals.count, totals.digest]);
        await session.query(`INSERT INTO sales_foundation.sales_line
          (${COLUMNS}, first_seen_at, content_changed_at, last_seen_run)
          SELECT ${COLUMNS}, first_seen_at, content_changed_at, $5 FROM sales_foundation.sales_stage_line
          WHERE run_id = $1 AND store_id = $2 AND business_date >= $3 AND business_date < $4
          ON CONFLICT (store_id, source_key) DO NOTHING`, [run.id, run.store, bucket.start, bucket.end, id]);
        // Revalidate persisted facts in bounded pages before committing coverage.
        const actual = accumulator();
        for await (const line of ordered(run, { ...bucket, facts: true })) actual.add(line);
        const got = actual.finish();
        if (got.count !== totals.count || got.revenueIncl !== totals.revenueIncl || got.revenueExcl !== totals.revenueExcl ||
            !got.digest.equals(totals.digest)) fail('RECONCILIATION_REQUIRED');
        await session.query(`INSERT INTO sales_foundation.sales_day_state
          (store_id, business_date, published_run, verified_at, source_observed_at, status, line_count,
           revenue_incl, revenue_excl, content_digest, evidence, verification_run)
          SELECT store_id, business_date, $2, clock_timestamp(), $3, 'complete', line_count, revenue_incl,
            revenue_excl, content_digest,
            CASE WHEN NOT $6::boolean THEN 'complete-single-pass' WHEN line_count = 0 THEN 'verified-empty' ELSE 'independently-verified' END,
            CASE WHEN $6::boolean THEN $1::uuid ELSE NULL END
          FROM sales_foundation.sales_import_day WHERE run_id = $1 AND business_date >= $4 AND business_date < $5
          ON CONFLICT (store_id, business_date) DO UPDATE SET
            published_run = EXCLUDED.published_run, verified_at = EXCLUDED.verified_at,
            source_observed_at = EXCLUDED.source_observed_at, line_count = EXCLUDED.line_count,
            revenue_incl = EXCLUDED.revenue_incl, revenue_excl = EXCLUDED.revenue_excl, content_digest = EXCLUDED.content_digest,
            evidence = EXCLUDED.evidence, verification_run = EXCLUDED.verification_run`,
        [run.id, id, run.observedAt, bucket.start, bucket.end, scan.verified]);
        await session.query(`INSERT INTO sales_foundation.sales_import_bucket (scan_id, store_id, start_date, end_date, published_run)
          VALUES ($1, $2, $3, $4, $5)`, [run.id, run.store, bucket.start, bucket.end, id]);
      });
    }
    await session.transaction(async () => {
      await session.query(`UPDATE sales_foundation.sales_sync_run SET state = 'published', published_at = clock_timestamp() WHERE run_id = $1`, [run.id]);
      await session.query(`UPDATE sales_foundation.sales_import_scan SET status = 'published', error_code = NULL WHERE run_id = $1`, [run.id]);
    });
    await purge(run.id);
  }
  async function failed(run, code) {
    const state = (await session.query('SELECT status FROM sales_foundation.sales_import_scan WHERE run_id = $1', [run.id])).rows[0]?.status;
    if (state === 'published') return;
    if (state === 'publication-pending') {
      await session.query(`UPDATE sales_foundation.sales_import_scan SET error_code = 'PUBLICATION_PENDING' WHERE run_id = $1`, [run.id]);
      return; // Terminal validated snapshot/checkpoints remain resumable.
    }
    const status = ['CATALOG_REVIEW', 'SOURCE_CONFLICT', 'RECONCILIATION_REQUIRED', 'VERIFICATION_MISMATCH'].includes(code)
      ? 'quarantined' : code === 'INTERRUPTED' ? 'interrupted' : 'failed';
    await session.query('UPDATE sales_foundation.sales_import_scan SET status = $2, error_code = $3 WHERE run_id = $1', [run.id, status, code]);
    await purge(run.id);
  }
  async function resume(id, options) {
    runId(id); await identity();
    const { rows: [row] } = await session.query(`SELECT r.store_id, r.start_date::text, r.end_date::text, r.observed_at, i.verification_of
      FROM sales_foundation.sales_sync_run r JOIN sales_foundation.sales_import_scan i USING (run_id, store_id)
      WHERE r.run_id = $1 AND i.status = 'publication-pending' AND i.terminal`, [id]);
    if (!row || row.store_id !== storeId(options.storeSlug) || row.start_date !== options.start || row.end_date !== options.end) fail('INVALID_RUN');
    return { id, store: row.store_id, start: row.start_date, end: row.end_date,
      observedAt: row.observed_at.toISOString(), verificationOf: row.verification_of };
  }
  async function coverage({ storeSlug, start, end }) {
    const id = storeId(storeSlug), dates = range(start, end);
    const { rows } = await session.query(`SELECT business_date::text AS date, evidence AS status, line_count AS "lineCount"
      FROM sales_foundation.sales_day_state WHERE store_id = $1 AND business_date >= $2 AND business_date < $3`, [id, start, end]);
    const attempts = await session.query(`SELECT i.status FROM sales_foundation.sales_import_scan i
      JOIN sales_foundation.sales_sync_run r USING (run_id, store_id)
      WHERE i.store_id = $1 AND r.start_date <= $2 AND r.end_date >= $3 ORDER BY r.observed_at DESC LIMIT 1`, [id, start, end]);
    const latestAttempt = attempts.rows[0]?.status ?? null;
    return { latestAttempt, days: dates.map(date => rows.find(row => row.date === date) || { date, lineCount: null,
      status: latestAttempt === 'quarantined' ? 'conflict-quarantine' : ['fetching', 'staged', 'validated', 'publication-pending'].includes(latestAttempt)
        ? 'staged' : 'never-synchronized' }) };
  }
  async function report(run) {
    const { rows: [row] } = await session.query(`SELECT i.pages, r.line_count AS "sanitizedRows", i.logical_count AS "lineCount",
      i.revenue_incl::text AS "revenueIncl", i.revenue_excl::text AS "revenueExcl",
      i.negative_price_count AS "negativePrice", i.negative_quantity_count AS "negativeQuantity"
      FROM sales_foundation.sales_import_scan i JOIN sales_foundation.sales_sync_run r USING (run_id) WHERE i.run_id = $1`, [run.id]);
    return row;
  }
  return Object.freeze({ begin, stage, progress, finishScan, preflight, publish, failed, resume, coverage, ordered, report });
}
module.exports = { createImportRepository, runId };
