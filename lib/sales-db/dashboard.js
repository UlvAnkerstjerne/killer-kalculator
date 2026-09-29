'use strict';
// Dormant compatibility read path. No importer, identity key, migrations or HTTP.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { storeId, range, decimal, cphLocal, saleTime } = require('./values');
const { createReviewedCatalog } = require('./facts');
const { units } = require('../sales-sync/checksums');
const { metricCoverage } = require('../sales-metric-coverage');
const MAX_LINES = 100000, MAX_BYTES = 32 * 1024 * 1024;
const catalog = createReviewedCatalog(require('../../catalogues/onlinepos-reviewed.json'));
const directory = path.join(__dirname, '../../migrations/sales-db');
const migrations = fs.readdirSync(directory).filter(n => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort()
  .map(version => ({ version, checksum: createHash('sha256').update(fs.readFileSync(path.join(directory, version))).digest('hex') }));
function failure(code) { const error = new Error(code); error.code = code; throw error; }
function numeric(value) {
  const exact = decimal(value), n = Number(exact);
  // Refuse lossy values instead of silently rounding large/exotic decimals.
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER || decimal(String(n)) !== exact) failure('DB_NUMERIC_UNREPRESENTABLE');
  return n;
}
function publicLine(row, id) {
  catalog.validate({ storeId: id, ...row });
  const time = saleTime(row.date, row.saleLocal, row.timeQuality.replace(/_ambiguous$/, ''));
  if (time.secondOfDay !== row.secondOfDay || time.timeQuality !== row.timeQuality) failure('DB_TIME_MISMATCH');
  return { productid: row.productId, productname: row.productLabel, productgroupid: row.groupId,
    productgroup: row.groupLabel, count: numeric(row.quantity), price: numeric(row.revenueIncl),
    priceexclvat: numeric(row.revenueExcl), paymenttype: row.paymentType, paymenttypecode: row.paymentCode,
    date: row.date, hour: row.secondOfDay === null ? null : Math.floor(row.secondOfDay / 3600), secondOfDay: row.secondOfDay };
}
async function readiness(session) {
  const { rows } = await session.query('SELECT version, checksum FROM sales_foundation.schema_migration ORDER BY version');
  if (JSON.stringify(rows) !== JSON.stringify(migrations)) failure('DB_SCHEMA_NOT_READY');
  const { rows: [role] } = await session.query(`SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls AS privileged,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='sales_foundation' AND c.relkind IN ('r','p') AND
      (has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE') OR c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))) AS writable
    FROM pg_roles WHERE rolname=current_user`);
  if (!role || role.privileged || role.writable) failure('DB_READ_ROLE_REQUIRED');
}
// One repeatable-read snapshot for coverage, facts and totals; never offset pages.
// Exported separately for offline/private comparison under an already read-only transaction.
async function readSnapshot(session, { storeSlug, start, end, now = Date.now() }) {
  const id = storeId(storeSlug), dates = range(start, end), today = cphLocal(now).slice(0, 10);
  const { rows: states } = await session.query(`SELECT business_date::text AS date, status, evidence,
    line_count AS "lineCount", source_observed_at AS "observedAt", revenue_incl::text AS "revenueIncl",
    revenue_excl::text AS "revenueExcl" FROM sales_foundation.sales_day_state
    WHERE store_id=$1 AND business_date >= $2 AND business_date < $3 ORDER BY business_date`, [id, start, end]);
  const byDate = new Map(states.map(row => [row.date, row]));
  const days = dates.map(date => {
    const s = byDate.get(date), observed = s ? new Date(s.observedAt) : null;
    const valid = !!s && ((s.status === 'complete' && ['complete-single-pass','independently-verified','verified-empty'].includes(s.evidence)) ||
      (s.status === 'VERIFIED_CLOSED' && s.evidence === 'verified-closed' && s.lineCount === 0))
      && Number.isFinite(observed.getTime()) && observed.getTime() <= now && cphLocal(observed.getTime()).slice(0,10) > date;
    return { date, status: date >= today ? 'open-day-unsupported' : !s || ['ZERO_OBSERVED_PENDING_REVIEW','RETRY_REQUIRED'].includes(s.status) ? 'missing' : valid ? 'complete' : 'invalid-coverage',
      evidence: valid ? s.evidence : null, ...(s && ['ZERO_OBSERVED_PENDING_REVIEW','RETRY_REQUIRED','VERIFIED_CLOSED'].includes(s.status) ? { zeroDayStatus: s.status } : {}),
      independentlyVerified: valid && ['independently-verified','verified-empty'].includes(s.evidence),
      lineCount: valid ? s.lineCount : null, observedAt: valid ? observed.toISOString() : null };
  });
  const complete = days.every(d => d.status === 'complete');
  const observed = days.map(d => d.observedAt).filter(Boolean).sort();
  const freshness = { checkedAt: new Date(now).toISOString(), oldestObservation: observed[0] || null,
    newestObservation: observed.at(-1) || null, sourceAgeMs: observed.length ? now - Date.parse(observed[0]) : null,
    status: complete ? 'historical-snapshot' : 'incomplete', live: false };
  const meta = { source: 'database', complete, start, end, storeId: storeSlug, pages: 0,
    rawLineCount: 0, processedLineCount: 0, outOfRange: 0, duplicatesRemoved: 0, invalidCount: 0,
    conflictCount: 0, cacheStatus: 'database-snapshot', stale: false, cacheAgeMs: 0,
    coverage: { complete, days }, freshness };
  if (!complete) return { lines: [], meta: { ...meta, code: 'DB_COVERAGE_INCOMPLETE' } };
  if (days.reduce((n,d) => n + d.lineCount, 0) > MAX_LINES) failure('DB_RANGE_TOO_LARGE');
  const { rows } = await session.query(`SELECT business_date::text AS date, to_char(sale_local,'YYYY-MM-DD HH24:MI:SS') AS "saleLocal",
    second_of_day AS "secondOfDay", time_quality AS "timeQuality", product_id AS "productId", product_label AS "productLabel",
    group_id AS "groupId", group_label AS "groupLabel", quantity::text, revenue_incl::text AS "revenueIncl",
    revenue_excl::text AS "revenueExcl", payment_type AS "paymentType", payment_code AS "paymentCode", reconciliation_state AS state
    FROM sales_foundation.sales_line WHERE store_id=$1 AND business_date >= $2 AND business_date < $3
    ORDER BY business_date, second_of_day NULLS LAST, product_id LIMIT $4`, [id,start,end,MAX_LINES+1]);
  if (rows.length > MAX_LINES || Buffer.byteLength(JSON.stringify(rows)) > MAX_BYTES) failure('DB_RANGE_TOO_LARGE');
  const sums = new Map(dates.map(d => [d,{count:0,incl:0n,excl:0n}]));
  for (const row of rows) {
    if (row.state !== 'active' || !sums.has(row.date)) failure('DB_FACTS_NOT_READY');
    const sum = sums.get(row.date); sum.count++; sum.incl += units(row.revenueIncl); sum.excl += units(row.revenueExcl);
  }
  for (const s of states) {
    const sum = sums.get(s.date);
    if (sum.count !== s.lineCount || sum.incl !== units(s.revenueIncl) || sum.excl !== units(s.revenueExcl)) failure('DB_TOTALS_MISMATCH');
  }
  const lines = rows.map(row => publicLine(row,id));
  meta.rawLineCount = meta.processedLineCount = lines.length;
  meta.metrics = metricCoverage(lines, storeSlug);
  return { lines, meta };
}
function createDashboardReader(database) {
  return { async ready() {
    return database.transaction(async session => {
      await session.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await readiness(session);
      return { ready: true, source: 'database', completedDaysOnly: true };
    });
  }, async read(args) {
    return database.transaction(async session => {
      await session.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await readiness(session);
      return readSnapshot(session,args);
    });
  }, close: () => database.close() };
}
module.exports = { createDashboardReader, readSnapshot, readiness, numeric, publicLine, MAX_LINES };
