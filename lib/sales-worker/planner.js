'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { storeId, date } = require('../sales-db/values');
const { fail } = require('../sales-sync/errors');
const { nextDate } = require('./config');
const COMPLETE = ['complete-single-pass', 'independently-verified', 'verified-empty'];

async function checkFoundation(session, identity) {
  const directory = path.join(__dirname, '../../migrations/sales-db');
  const names = (await fs.readdir(directory)).filter(n => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort();
  const expected = await Promise.all(names.map(async version => ({ version,
    checksum: createHash('sha256').update(await fs.readFile(path.join(directory, version))).digest('hex') })));
  const { rows } = await session.query('SELECT version, checksum FROM sales_foundation.schema_migration ORDER BY version');
  if (expected.length !== 4 || JSON.stringify(rows) !== JSON.stringify(expected)) fail('INVALID_CONFIG');
  if (identity) {
    const marker = (await session.query('SELECT key_version, check_digest FROM sales_foundation.identity_key_check')).rows;
    if (marker.length !== 1 || marker[0].key_version !== identity.version || !marker[0].check_digest.equals(identity.check())) fail('IDENTITY_MISMATCH');
  }
}
async function readPlan(session, scope, identity) {
  await session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await checkFoundation(session, identity);
    const candidates = [], bounds = [];
    let noOp = 0;
    for (const store of scope.stores) {
      const id = storeId(store);
      const pending = await session.query(`SELECT 1 FROM sales_foundation.sales_import_scan
        WHERE store_id = $1 AND status = 'publication-pending' LIMIT 1`, [id]);
      // A checkpoint can straddle dates. It must use the existing explicit
      // publication-resume workflow, never a fresh traversal or inferred repair.
      if (pending.rows.length) fail('PUBLICATION_PENDING');
      const anchor = scope.start ?? (await session.query(`SELECT min(business_date)::text AS date
        FROM sales_foundation.sales_day_state WHERE store_id = $1 AND business_date < $2`, [id, scope.end])).rows[0].date;
      if (!anchor) fail('INVALID_OPTIONS');
      date(anchor);
      if (anchor > scope.end) fail('INVALID_OPTIONS');
      bounds.push({ store, start: anchor, end: scope.end });
      const complete = await session.query(`SELECT count(*)::int AS count,
          count(*) FILTER (WHERE status <> 'complete' OR evidence <> ALL($4::text[]))::int AS invalid
        FROM sales_foundation.sales_day_state WHERE store_id = $1 AND business_date >= $2 AND business_date < $3`,
      [id, anchor, scope.end, COMPLETE]);
      if (complete.rows[0].invalid !== 0) fail('INVALID_RUN');
      noOp += complete.rows[0].count;
      // Integer/date arithmetic is independent of server timezone and DST. The
      // schema's 2000..2099 range caps enumeration at 36,525 dates per store.
      // Only maxDays+1 missing dates per store ever leave PostgreSQL.
      const missing = await session.query(`SELECT ($2::date + n)::text AS date FROM
        generate_series(0, ($3::date - $2::date) - 1) AS n
        WHERE NOT EXISTS (SELECT 1 FROM sales_foundation.sales_day_state d
          WHERE d.store_id = $1 AND d.business_date = $2::date + n)
        ORDER BY n LIMIT $4`, [id, anchor, scope.end, scope.maxDays + 1]);
      for (const row of missing.rows) candidates.push({ store, start: date(row.date), end: nextDate(row.date) });
    }
    candidates.sort((a, b) => a.start.localeCompare(b.start) || storeId(a.store) - storeId(b.store));
    await session.query('COMMIT');
    return { units: candidates.slice(0, scope.maxDays), noOp, hasMore: candidates.length > scope.maxDays, bounds };
  } catch (error) { try { await session.query('ROLLBACK'); } catch {} throw error; }
}
async function outcome(session, unit) {
  const { rows } = await session.query(`SELECT evidence FROM sales_foundation.sales_day_state
    WHERE store_id = $1 AND business_date = $2`, [storeId(unit.store), unit.start]);
  if (rows.length && !COMPLETE.includes(rows[0].evidence)) fail('INVALID_RUN');
  return rows[0]?.evidence ?? 'missing';
}
module.exports = { checkFoundation, readPlan, outcome };
