'use strict';
const { validateOptions } = require('./options');
const { traverse } = require('./traverse');
const { summarize } = require('./checksums');
const { createImportRepository } = require('./repository');
const { withImportOwner } = require('./owner');
const { fail, safeError, checkSignal } = require('./errors');

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
  return withImportOwner(config, session => applyHistory({ context, request, params, options,
    signal, report, limits }, session));
}

// Same session owns the existing environment-wide publication lock for the
// entire bounded worker run. Never lend an unlocked/replacement connection to
// the importer, or reacquire ownership between planning and publication.
async function withImportBatch({ config, context, signal, requireNonEmpty = false }, work) {
  if (!context?.identity || !context?.catalog) fail('INVALID_IDENTITY');
  if (typeof requireNonEmpty !== 'boolean') fail('INVALID_OPTIONS');
  return withImportOwner(config, async session => {
    const lifetime = new AbortController();
    const activeSignal = AbortSignal.any([lifetime.signal, session.signal, ...(signal ? [signal] : [])]);
    let pending = null, closed = false;
    try {
      return await work({ session, signal: activeSignal, importOne: async ({ options, request, report = () => {}, limits = {}, now = () => new Date() }) => {
        if (closed) fail('LOCK_LOST');
        if (pending) fail('IMPORTER_BUSY');
        const params = validateOptions(options, now());
        // Pending snapshots use the unchanged explicit manual resume workflow.
        if (requireNonEmpty && params.resumePublication) fail('INVALID_OPTIONS');
        checkSignal(activeSignal);
        pending = applyHistory({ context, request, params, options, signal: activeSignal, report, limits, requireNonEmpty }, session);
        try { return await pending; }
        finally { pending = null; }
      } });
    } finally {
      closed = true; lifetime.abort();
      // Even a callback that returns/throws without awaiting its import cannot
      // release ownership while that import still has provider/SQL work alive.
      if (pending) { try { await pending; } catch {} }
    }
  });
}

async function applyHistory({ context, request, params, options, signal, report, limits, requireNonEmpty = false }, session) {
  const activeSignal = signal ? AbortSignal.any([signal, session.signal]) : session.signal;
  const repository = createImportRepository(session, context);
  let run;
  const review = require('./catalog-encoded').createReview({ catalog: context.catalog, options: params });
  try {
    run = params.resumePublication ? await repository.resume(params.resumePublication, params) : await repository.begin(params);
    let traversal;
    if (!params.resumePublication) {
      traversal = await traverse({ ...limits, ...params, companyId: options.companyId, context, request: review.wrap(request), signal: activeSignal,
        sink: { terminal: review.terminal, batch: batch => repository.stage(run, batch), progress: async value => {
          await repository.progress(run, value);
          report(safeReport({ status: 'staging', runId: run.id, ...value }));
        } } }, { catalogReviewObserver: review.row });
      checkSignal(activeSignal);
      const total = await repository.finishScan(run, traversal);
      // Count the durable, normalized, deduplicated in-range snapshot only after
      // genuine terminal pagination. Revenue/quantity can legitimately be zero.
      // Manual imports and verification retain their existing empty-day behavior.
      // A multi-day batch must not silently complete an empty day just because
      // another day has facts. Durable day summaries retain the review scope.
      if (requireNonEmpty && !run.verificationOf && total.emptyDays.length > 0) fail('ZERO_FACT_DAY_REVIEW');
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
    // The existing schema has a closed audit-code list. An empty worker
    // candidate is INVALID_RUN durably; keep the specific fixed code at the CLI.
    const auditCode = safe.code === 'ZERO_FACT_DAY_REVIEW' ? 'INVALID_RUN' : safe.code;
    if (run) { try { await repository.failed(run, auditCode); } catch {} }
    if (safe.code === 'CATALOG_REVIEW') report({ status: 'catalog-review', catalogReview: review.finish(safe) });
    report(safeReport({ status: 'incomplete', runId: run?.id, code: safe.code }));
    throw safe;
  }
}
module.exports = { importHistory, withImportBatch, validateOptions, safeReport };
