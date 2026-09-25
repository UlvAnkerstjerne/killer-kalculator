'use strict';
const { storeId, date, cphLocal } = require('../sales-db/values');
const { traverse } = require('./traverse');
const { summarize } = require('./checksums');
const { createImportRepository, runId } = require('./repository');
const { withImportOwner } = require('./owner');
const { fail, safeError, checkSignal } = require('./errors');

function validateOptions(options, now = new Date()) {
  try {
    storeId(options.storeSlug); date(options.start);
    const observedAt = now.toISOString(), today = cphLocal(now.getTime()).slice(0, 10);
    const end = options.end ?? today; date(end);
    if (options.start >= end || end > today) fail('INVALID_OPTIONS');
    if (options.verificationOf) runId(options.verificationOf);
    if (options.resumePublication) runId(options.resumePublication);
    if (options.verificationOf && options.resumePublication) fail('INVALID_OPTIONS');
    return { storeSlug: options.storeSlug, start: options.start, end, observedAt,
      verificationOf: options.verificationOf, resumePublication: options.resumePublication };
  } catch { fail('INVALID_OPTIONS'); }
}
// Closed allowlist for every progress/final serializer. Never stringify errors,
// context, source records, protected keys, fingerprints or provider objects.
function safeReport(value) {
  const result = {};
  for (const key of ['status', 'code', 'runId', 'store', 'start', 'end', 'pages', 'rows', 'reviewCount',
    'sanitizedRows', 'lineCount', 'revenueIncl', 'revenueExcl', 'negativePrice', 'negativeQuantity', 'verified']) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
}
async function importHistory({ config, context, request, options, apply = false, signal,
  report = () => {}, limits = {}, now = () => new Date() }) {
  if (!config?.enabled) fail('DB_DISABLED');
  if (!context?.identity || !context?.catalog) fail('INVALID_IDENTITY');
  const params = validateOptions(options, now());
  checkSignal(signal);
  if (!apply && (params.verificationOf || params.resumePublication)) fail('INVALID_OPTIONS');
  if (!apply) {
    // Validation never connects to/writes the DB or spills raw responses to disk.
    // Full-history scans require --apply for durable bounded PostgreSQL staging.
    const safe = new Map(); let bytes = 0;
    const sink = {
      async batch(batch) {
        for (const { line } of batch) {
          const key = line.sourceKey.toString('hex'), prior = safe.get(key);
          if (prior && !prior.fingerprint.equals(line.fingerprint)) fail('SOURCE_CONFLICT');
          if (prior) continue;
          const value = { sourceKey: Buffer.from(line.sourceKey), fingerprint: Buffer.from(line.fingerprint),
            businessDate: line.businessDate, quantity: line.quantity, revenueIncl: line.revenueIncl, revenueExcl: line.revenueExcl };
          bytes += 256 + value.quantity.length + value.revenueIncl.length + value.revenueExcl.length;
          if (safe.size >= 20000 || bytes > 8 * 1024 * 1024) fail('ROW_LIMIT');
          safe.set(key, value);
        }
      },
      async progress(value) { report(safeReport({ status: 'validating', ...value, sanitizedRows: safe.size })); },
    };
    const traversal = await traverse({ ...limits, ...params, companyId: options.companyId, context, request, sink, signal });
    const sorted = [...safe.values()].sort((a, b) => Buffer.compare(a.sourceKey, b.sourceKey));
    const summary = await summarize(sorted, params.start, params.end);
    const result = safeReport({ status: 'validated-only', store: params.storeSlug, start: params.start, end: params.end,
      pages: traversal.pages, sanitizedRows: safe.size, lineCount: summary.total.count,
      revenueIncl: summary.total.revenueIncl, revenueExcl: summary.total.revenueExcl, verified: false });
    report(result); return result;
  }
  return withImportOwner(config, async session => {
    const activeSignal = signal ? AbortSignal.any([signal, session.signal]) : session.signal;
    const repository = createImportRepository(session, context);
    let run;
    try {
      run = params.resumePublication ? await repository.resume(params.resumePublication, params) : await repository.begin(params);
      let traversal;
      if (!params.resumePublication) {
        traversal = await traverse({ ...limits, ...params, companyId: options.companyId, context, request, signal: activeSignal,
          sink: { batch: batch => repository.stage(run, batch), progress: async value => {
            await repository.progress(run, value);
            report(safeReport({ status: 'staging', runId: run.id, ...value, sanitizedRows: value.rows - value.reviewCount }));
          } } });
        checkSignal(activeSignal);
        await repository.finishScan(run, traversal);
      }
      checkSignal(activeSignal);
      const verified = await repository.preflight(run);
      if (verified) await repository.verify(run);
      else await repository.publish(run, activeSignal);
      const result = safeReport({ status: verified ? 'verified' : 'published', runId: run.id, store: params.storeSlug,
        start: run.start, end: run.end, ...await repository.report(run), verified });
      report(result); return result;
    } catch (error) {
      const safe = safeError(error);
      if (run) { try { await repository.failed(run, safe.code); } catch {} }
      report(safeReport({ status: 'incomplete', runId: run?.id, code: safe.code }));
      throw safe;
    }
  });
}
module.exports = { importHistory, validateOptions, safeReport };
