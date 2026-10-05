'use strict';
const { date, cphLocal, storeId, STORES } = require('../sales-db/values');
const { withImportBatch } = require('../sales-sync/importer');
const { withImportOwner } = require('../sales-sync/owner');
const { createImportRepository } = require('../sales-sync/repository');
const { createHttpRequest } = require('../sales-sync/http');
const { checkFoundation } = require('./planner');
const { fail, safeError, checkSignal } = require('../sales-sync/errors');
const { nextDate } = require('./config');
const { persistAdmitted } = require('./catalog');
const LOOKBACK_DAYS = 7, MAX_UNITS = 2, MAX_ATTEMPTS = 3, RETRY_DELAY_MS = 20 * 60 * 60 * 1000;
const MAX_REQUESTS = 20, MAX_DURATION_MS = 8 * 60 * 1000;
const COMPLETE = new Set(['complete-single-pass', 'independently-verified', 'verified-empty','verified-closed']);
const RETRYABLE = new Set(['UPSTREAM_FAILED', 'UPSTREAM_RATE_LIMIT', 'INTERRUPTED', 'DB_OPERATION_FAILED', 'CATALOG_REVIEW']);
function priorDate(value, count = 1) { return date(new Date(Date.parse(date(value)) - count * 86400000).toISOString().slice(0, 10)); }
function dailyScope(store, from, now = new Date()) {
  try {
  if (!STORES.includes(store)) fail('INVALID_OPTIONS');
  const today = date(cphLocal(now.getTime()).slice(0, 10)), floor = date(from);
  // Explicit forward-only floor keeps earlier operator-owned gaps out of automation.
  const start = [floor, priorDate(today, LOOKBACK_DAYS)].sort().at(-1);
  return { store, from: floor, start, end: today, days: start >= today ? [] : Array.from(
    { length: Math.round((Date.parse(today) - Date.parse(start)) / 86400000) }, (_, n) => priorDate(today, n + 1)) };
  } catch { fail('INVALID_OPTIONS'); }
}
async function readDailyStatus(session, scope) {
  const id = storeId(scope.store);
  const { rows: pending } = await session.query(`SELECT count(*)::int AS count FROM sales_foundation.sales_import_scan
    WHERE store_id=$1 AND status='publication-pending'`, [id]);
  const { rows } = await session.query(`SELECT d::date::text AS date,
    c.status AS "coverageStatus", c.evidence, c.line_count AS "lineCount", c.source_observed_at AS "observedAt",
    a.attempts, a.last_attempt AS "lastAttempt", latest.status AS "attemptState", latest.error_code AS "errorCode",
    latest.terminal, latest.logical_count AS "logicalCount", latest.published_at AS "publishedAt"
    FROM (SELECT $2::date+n AS d FROM generate_series(0, ($3::date-$2::date)-1) n) dates
    LEFT JOIN sales_foundation.sales_day_state c ON c.store_id=$1 AND c.business_date=d::date
    LEFT JOIN LATERAL (SELECT count(*)::int attempts,max(r.observed_at) last_attempt
      FROM sales_foundation.sales_sync_run r JOIN sales_foundation.sales_import_scan i USING(run_id,store_id)
      WHERE r.store_id=$1 AND r.start_date<=d::date AND r.end_date>d::date AND i.verification_of IS NULL) a ON true
    LEFT JOIN LATERAL (SELECT i.status,i.error_code,i.terminal,i.logical_count,r.published_at
      FROM sales_foundation.sales_sync_run r JOIN sales_foundation.sales_import_scan i USING(run_id,store_id)
      WHERE r.store_id=$1 AND r.start_date<=d::date AND r.end_date>d::date AND i.verification_of IS NULL
      ORDER BY r.observed_at DESC,r.run_id DESC LIMIT 1) latest ON true
    ORDER BY d DESC`, [id, scope.start, scope.end]);
  const days = rows.map(r => {
    const complete = ['complete','VERIFIED_CLOSED'].includes(r.coverageStatus) && COMPLETE.has(r.evidence);
    const invalid = r.coverageStatus !== null && !complete;
    // The unchanged importer durably records the zero-fact guard as INVALID_RUN.
    const errorCode = r.errorCode === 'INVALID_RUN' && r.terminal && r.logicalCount === 0
      ? 'ZERO_FACT_DAY_REVIEW' : r.errorCode === null ? null : safeError({ code: r.errorCode }).code;
    return { store: scope.store, date: r.date, complete, evidence: complete ? r.evidence : null,
      lineCount: complete ? r.lineCount : null, attempts: r.attempts, lastAttemptAt: r.lastAttempt?.toISOString() ?? null,
      completionAt: complete ? (r.publishedAt || r.observedAt)?.toISOString() ?? null : null,
      attemptState: r.attemptState || 'never-attempted', errorCode: invalid ? 'INVALID_RUN' : errorCode,
      invalidCoverage: invalid };
  });
  return { pendingPublications: pending[0].count, days };
}
function decision(day, now) {
  if (day.complete) return 'complete';
  if (day.invalidCoverage) return 'operator-review';
  if (day.attempts === 0) return 'eligible';
  if (day.attempts >= MAX_ATTEMPTS) return 'attempt-limit';
  if (!RETRYABLE.has(day.errorCode)) return 'operator-review';
  if (now.getTime() - Date.parse(day.lastAttemptAt) < RETRY_DELAY_MS) return 'retry-not-due';
  return 'eligible';
}
function autoAdmitPolicy(context) {
  const { inspectText } = require('../sales-sync/catalog-text');
  return (raw, storeSlug) => {
    let pl = raw.productname;
    const issue = inspectText(pl, 'label');
    if (issue && issue.reason === 'SENSITIVE_PATTERN') {
      const id = String(raw.productid), chunks = [];
      for (let i = 0; i < id.length; i += 3) chunks.push(id.slice(i, i + 3));
      pl = `[P:${chunks.join('/')}]`;
    } else if (issue) return null;
    const sid = storeId(storeSlug);
    context.catalog.admit({
      storeId: sid, productId: String(raw.productid), productLabel: pl,
      groupId: raw.productgroupid != null ? String(raw.productgroupid) : null,
      groupLabel: raw.productgroup != null ? String(raw.productgroup) : null,
      paymentType: String(raw.paymenttype),
      paymentCode: raw.paymenttypecode != null ? String(raw.paymenttypecode) : null,
    });
    return { ...raw, productname: pl };
  };
}
async function reconcilePending(session, context, store, importOne) {
  const id = storeId(store);
  const { rows } = await session.query(`SELECT run_id, r.start_date::text AS start, r.end_date::text AS "end"
    FROM sales_foundation.sales_import_scan i JOIN sales_foundation.sales_sync_run r USING(run_id, store_id)
    WHERE i.store_id = $1 AND (i.status = 'publication-pending' OR (i.zero_day_policy = 'review' AND i.status IN ('staged','validated')))
    AND i.terminal LIMIT 1`, [id]);
  if (!rows.length) return false;
  const pending = rows[0];
  await importOne({ options: { storeSlug: store, start: pending.start, end: pending.end,
    resumePublication: pending.run_id, companyId: '0' },
    request: async () => fail('INVALID_RUN') });
  return true;
}
async function runDaily({ store, from, apply = false, enabled = false, config, context, credentials,
  signal, now = () => new Date(), requestFor = (_store, credential) => createHttpRequest(credential),
  emit = () => {} }) {
  const result = { kind: 'daily-sales', status: 'incomplete', store: STORES.includes(store) ? store : null,
    startedAt: now().toISOString(), finishedAt: null, attempted: 0, published: 0, requests: 0, days: [] };
  try {
    if (apply && !enabled) { result.status = 'disabled'; return result; }
    const scope = dailyScope(store, from, now());
    if (typeof apply !== 'boolean' || typeof enabled !== 'boolean') fail('INVALID_OPTIONS');
    const credential = credentials?.get(store);
    createHttpRequest(credential || {}); // Readiness validates credentials without making a request.
    if (!context?.identity || !context?.catalog) fail('INVALID_CONFIG');
    const admit = autoAdmitPolicy(context);
    const work = async ({ session, signal: ownedSignal, importOne }) => {
      const activeSignal = AbortSignal.any([ownedSignal, ...(signal ? [signal] : [])]);
      checkSignal(activeSignal);
      await checkFoundation(session, context.identity);
      let snapshot = await readDailyStatus(session, scope);
      result.scope = scope;
      if (apply && snapshot.pendingPublications) {
        // Reconcile a valid pending publication left by a prior crashed run.
        await reconcilePending(session, context, store, importOne);
        snapshot = await readDailyStatus(session, scope);
        if (snapshot.pendingPublications) fail('PUBLICATION_PENDING');
      }
      if (snapshot.pendingPublications) fail('PUBLICATION_PENDING');
      if (apply) {
        // Same ownership lock as all importers. Recovery never resumes uncertain publication.
        await createImportRepository(session, context).recover(storeId(store));
        snapshot = await readDailyStatus(session, scope);
      }
      result.days = snapshot.days.map(day => ({ ...day, action: decision(day, now()) }));
      if (!apply) { result.status = 'ready'; return; }
      const selected = result.days.filter(d => d.action === 'eligible').slice(0, MAX_UNITS);
      let transport;
      for (const day of selected) {
        checkSignal(activeSignal);
        if (result.requests >= MAX_REQUESTS) break;
        const attempt = { kind: 'daily-sales-attempt', store, date: day.date, startedAt: now().toISOString(),
          finishedAt: null, completionState: 'missing', errorCode: null, requests: 0 };
        result.attempted++;
        emit({ ...attempt, phase: 'started' });
        const beforeRequests = result.requests;
        try {
          transport ||= requestFor(store, credential);
          await importOne({ options: { storeSlug: store, start: day.date, end: nextDate(day.date), companyId: credential.companyId }, now,
            limits: { maxPages: MAX_REQUESTS, maxRows: 100000 },
            request: async (...args) => {
              if (result.requests >= MAX_REQUESTS) fail('PAGE_LIMIT');
              result.requests++; return transport(...args);
            },
            autoAdmit: admit });
          const after = await readDailyStatus(session, scope);
          const stored = after.days.find(d => d.date === day.date);
          if (!stored?.complete) fail('INVALID_RUN');
          result.published++; attempt.completionState = 'complete';
        } catch (error) {
          attempt.errorCode = safeError(error).code;
          attempt.completionState = 'unavailable';
          // Never infer rollback from an error. Unknown writes stop this store;
          // a durable pending checkpoint prevents all further source traversals.
          const after = await readDailyStatus(session, scope);
          const stored = after.days.find(d => d.date === day.date);
          attempt.completionState = after.pendingPublications ? 'publication-pending' : 'missing';
          if (stored?.complete) { result.published++; attempt.completionState = 'complete'; }
          if (after.pendingPublications || ['LOCK_LOST','PUBLICATION_PENDING'].includes(attempt.errorCode)) {
            result.code = after.pendingPublications ? 'PUBLICATION_PENDING' : attempt.errorCode;
            break;
          }
          // A blocked day does not stop independent newer/older eligible dates.
        } finally {
          attempt.finishedAt = now().toISOString();attempt.requests = result.requests - beforeRequests;
          emit({ ...attempt, phase: 'finished' });
        }
      }
      const after = await readDailyStatus(session, scope);
      result.days = after.days.map(day => ({ ...day, action: decision(day, now()) }));
      if (after.pendingPublications) result.code = 'PUBLICATION_PENDING';
      result.status = result.code ? 'incomplete' : result.days.some(d => !d.complete) ? 'gaps' : 'complete';
      // Persist auto-admitted catalogue entries so future workers and readers
      // recognise them without re-discovering on every run.
      if (result.published > 0) {
        try { persistAdmitted(context.catalog.admitted()); } catch { /* non-fatal */ }
      }
    };
    if (apply) await withImportBatch({ config, context, signal, requireNonEmpty: true }, work);
    else await withImportOwner(config, session => work({ session, signal: session.signal }));
  } catch (error) { result.code = safeError(error).code; result.status = result.code === 'IMPORTER_BUSY' ? 'busy' : 'incomplete'; }
  finally { result.finishedAt = now().toISOString(); }
  return result;
}
module.exports = { dailyScope, readDailyStatus, decision, runDaily, LOOKBACK_DAYS, MAX_UNITS, MAX_ATTEMPTS, RETRY_DELAY_MS, MAX_REQUESTS, MAX_DURATION_MS };
