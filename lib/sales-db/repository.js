'use strict';
const { createHash } = require('node:crypto');
const { fail } = require('./errors');
const { storeId, exactKeys, range, timestamp, cphLocal } = require('./values');
const { validateSafeLine, publicLine } = require('./facts');

const FIELDS = [
  ['store_id', 'storeId'], ['source_key', 'sourceKey'], ['key_version', 'keyVersion'],
  ['business_date', 'businessDate'], ['sale_local', 'saleLocal'], ['second_of_day', 'secondOfDay'],
  ['time_quality', 'timeQuality'], ['product_id', 'productId'], ['product_label', 'productLabel'],
  ['group_id', 'groupId'], ['group_label', 'groupLabel'], ['quantity', 'quantity'],
  ['revenue_incl', 'revenueIncl'], ['revenue_excl', 'revenueExcl'], ['payment_type', 'paymentType'],
  ['payment_code', 'paymentCode'], ['fingerprint', 'fingerprint'],
];
const COLUMN_LIST = FIELDS.map(([sql]) => sql).join(', ');
// Explicit casts avoid local-TZ date parsers and preserve numeric strings even
// when the underlying database column uses a numeric domain.
const PROJECTION = FIELDS.map(([sql, js]) => {
  if (sql === 'sale_local') return `to_char(sale_local, 'YYYY-MM-DD HH24:MI:SS') AS "${js}"`;
  const cast = ['business_date', 'quantity', 'revenue_incl', 'revenue_excl'].includes(sql) ? '::text' : '';
  return `${sql}${cast} AS "${js}"`;
}).join(', ');
function digestLines(lines) {
  const hash = createHash('sha256');
  for (const line of lines) hash.update(line.sourceKey).update(line.fingerprint);
  return hash.digest();
}
function createRepository(database, context) {
  async function verifyIdentity(session, initialize = false) {
    if (initialize) {
      await session.query(`INSERT INTO sales_foundation.identity_key_check (singleton, key_version, check_digest)
        VALUES (true, $1, $2) ON CONFLICT (singleton) DO NOTHING`, [context.identity.version, context.identity.check()]);
    }
    const { rows } = await session.query('SELECT key_version, check_digest FROM sales_foundation.identity_key_check');
    if (rows.length && (rows[0].key_version !== context.identity.version || !rows[0].check_digest.equals(context.identity.check()))) fail('IDENTITY_MISMATCH');
  }
  async function coverageOn(session, id, start, end) {
    const days = range(start, end);
    const { rows } = await session.query(`SELECT business_date::text AS date, line_count AS "lineCount",
      source_observed_at AS "observedAt" FROM sales_foundation.sales_day_state
      WHERE store_id = $1 AND business_date >= $2 AND business_date < $3 ORDER BY business_date`, [id, start, end]);
    const byDate = new Map(rows.map(row => [row.date, row]));
    return { complete: rows.length === days.length, days: days.map(date => {
      const row = byDate.get(date);
      return { date, status: row ? 'complete' : 'never-synchronized',
        lineCount: row?.lineCount ?? null, observedAt: row?.observedAt?.toISOString() ?? null };
    }) };
  }
  async function read(work) {
    return database.transaction(async session => {
      await session.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await verifyIdentity(session);
      return work(session);
    });
  }
  async function publishCompletedRun(input) {
    exactKeys(input, ['runId', 'storeSlug', 'start', 'end', 'observedAt', 'complete', 'expectedLineCount', 'lines']);
    const id = storeId(input.storeSlug);
    const days = range(input.start, input.end, 31);
    timestamp(input.observedAt);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.runId) ||
        input.complete !== true || !Number.isInteger(input.expectedLineCount) ||
        !Array.isArray(input.lines) || input.lines.length > 10000 ||
        Date.parse(input.observedAt) > Date.now() || input.end > cphLocal(Date.parse(input.observedAt)).slice(0, 10)) fail('INCOMPLETE_PUBLICATION');
    // Copy buffers/fields before any async boundary: caller mutation cannot
    // alter the checked publication while it waits for a database connection.
    const unique = new Map();
    for (const candidate of input.lines) {
      validateSafeLine(candidate, context);
      if (candidate.storeId !== id || candidate.businessDate < input.start || candidate.businessDate >= input.end) fail('INCOMPLETE_PUBLICATION');
      const line = Object.fromEntries(FIELDS.map(([, key]) => [key,
        Buffer.isBuffer(candidate[key]) ? Buffer.from(candidate[key]) : candidate[key]]));
      const key = line.sourceKey.toString('hex');
      const prior = unique.get(key);
      if (prior && !prior.fingerprint.equals(line.fingerprint)) fail('SOURCE_CONFLICT');
      unique.set(key, line);
    }
    const lines = [...unique.values()].sort((a, b) => Buffer.compare(a.sourceKey, b.sourceKey));
    if (lines.length !== input.expectedLineCount) fail('INCOMPLETE_PUBLICATION');
    const digest = digestLines(lines);
    // Freeze primitive run metadata too; no provider objects retained.
    const run = { runId: input.runId, start: input.start, end: input.end, observedAt: input.observedAt };
    return database.transaction(async session => {
      // Publication serialization only; this is NOT the later worker leader lock.
      await session.query('SELECT pg_advisory_xact_lock($1, $2)', [1935764581, 2]);
      await verifyIdentity(session, true);
      const existing = await session.query(`SELECT store_id, start_date::text, end_date::text,
        observed_at, content_digest FROM sales_foundation.sales_sync_run WHERE run_id = $1`, [run.runId]);
      if (existing.rows.length) {
        const old = existing.rows[0];
        if (old.store_id !== id || old.start_date !== run.start || old.end_date !== run.end ||
            old.observed_at.toISOString() !== run.observedAt || !old.content_digest.equals(digest)) fail('RUN_CONFLICT');
        return { published: false, lineCount: lines.length };
      }
      // Changed or missing previously committed identities require later explicit
      // reconciliation. Never infer deletion, move a date, or certify a partial scan.
      const prior = await session.query(`SELECT source_key, fingerprint FROM sales_foundation.sales_line
        WHERE store_id = $1 AND ((business_date >= $2 AND business_date < $3) OR source_key = ANY($4::bytea[]))`,
      [id, run.start, run.end, lines.map(line => line.sourceKey)]);
      for (const old of prior.rows) {
        const next = unique.get(old.source_key.toString('hex'));
        if (!next) fail('INCOMPLETE_PUBLICATION');
        if (!old.fingerprint.equals(next.fingerprint)) fail('RECONCILIATION_REQUIRED');
      }
      const newer = await session.query(`SELECT 1 FROM sales_foundation.sales_day_state
        WHERE store_id = $1 AND business_date >= $2 AND business_date < $3 AND source_observed_at > $4 LIMIT 1`,
      [id, run.start, run.end, run.observedAt]);
      if (newer.rows.length) fail('INCOMPLETE_PUBLICATION');
      await session.query(`INSERT INTO sales_foundation.sales_sync_run
        (run_id, store_id, start_date, end_date, observed_at, state, line_count, content_digest)
        VALUES ($1, $2, $3, $4, $5, 'staging', $6, $7)`,
      [run.runId, id, run.start, run.end, run.observedAt, lines.length, digest]);
      for (const [position, line] of lines.entries()) {
        const values = FIELDS.map(([, key]) => line[key]);
        values.push(run.observedAt, run.observedAt, run.runId, run.runId, 1, position);
        await session.query(`INSERT INTO sales_foundation.sales_stage_line
          (${COLUMN_LIST}, first_seen_at, content_changed_at, last_seen_run, run_id, source_page, source_position)
          VALUES (${values.map((_, i) => '$' + (i + 1)).join(', ')})`, values);
      }
      await session.query(`INSERT INTO sales_foundation.sales_line
        (${COLUMN_LIST}, first_seen_at, content_changed_at, last_seen_run)
        SELECT ${COLUMN_LIST}, first_seen_at, content_changed_at, last_seen_run
        FROM sales_foundation.sales_stage_line WHERE run_id = $1
        ON CONFLICT (store_id, source_key) DO NOTHING`, [run.runId]);
      for (const day of days) {
        const dayLines = lines.filter(line => line.businessDate === day);
        await session.query(`INSERT INTO sales_foundation.sales_day_state
          (store_id, business_date, published_run, verified_at, source_observed_at, status,
           line_count, revenue_incl, revenue_excl, content_digest)
          SELECT $1::smallint, $2::date, $3::uuid, clock_timestamp(), $4::timestamptz, 'complete', count(*),
            coalesce(sum(revenue_incl), 0), coalesce(sum(revenue_excl), 0), $5
          FROM sales_foundation.sales_line WHERE store_id = $1 AND business_date = $2
          ON CONFLICT (store_id, business_date) DO UPDATE SET
            published_run = EXCLUDED.published_run, verified_at = EXCLUDED.verified_at,
            source_observed_at = EXCLUDED.source_observed_at, line_count = EXCLUDED.line_count,
            revenue_incl = EXCLUDED.revenue_incl, revenue_excl = EXCLUDED.revenue_excl, content_digest = EXCLUDED.content_digest`,
        [id, day, run.runId, run.observedAt, digestLines(dayLines)]);
      }
      await session.query(`UPDATE sales_foundation.sales_sync_run SET state = 'published',
        published_at = clock_timestamp() WHERE run_id = $1`, [run.runId]);
      await session.query('DELETE FROM sales_foundation.sales_stage_line WHERE run_id = $1', [run.runId]);
      return { published: true, lineCount: lines.length };
    });
  }
  return Object.freeze({
    publishCompletedRun,
    coverage: ({ storeSlug, start, end }) => read(session => coverageOn(session, storeId(storeSlug), start, end)),
    summary: ({ storeSlug, start, end }) => read(async session => {
      const id = storeId(storeSlug);
      const coverage = await coverageOn(session, id, start, end);
      if (!coverage.complete) return { coverage, revenueIncl: null, revenueExcl: null, lineCount: null };
      const { rows: [totals] } = await session.query(`SELECT coalesce(sum(revenue_incl), 0)::text AS "revenueIncl",
        coalesce(sum(revenue_excl), 0)::text AS "revenueExcl", coalesce(sum(line_count), 0)::text AS "lineCount"
        FROM sales_foundation.sales_day_state WHERE store_id = $1 AND business_date >= $2 AND business_date < $3`, [id, start, end]);
      return { coverage, ...totals };
    }),
    lines: ({ storeSlug, start, end, limit = 500, offset = 0 }) => read(async session => {
      const id = storeId(storeSlug);
      range(start, end);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0 || offset > 100000) fail();
      const coverage = await coverageOn(session, id, start, end);
      const { rows } = await session.query(`SELECT ${PROJECTION} FROM sales_foundation.sales_line
        WHERE store_id = $1 AND business_date >= $2 AND business_date < $3 AND reconciliation_state = 'active'
        ORDER BY business_date, second_of_day NULLS LAST, source_key LIMIT $4 OFFSET $5`, [id, start, end, limit + 1, offset]);
      return { coverage, lines: rows.slice(0, limit).map(line => publicLine(line, context)), hasMore: rows.length > limit };
    }),
  });
}
module.exports = { createRepository };
