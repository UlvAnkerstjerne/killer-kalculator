'use strict';
const { performance } = require('node:perf_hooks');
const { storeId } = require('../sales-db/values');
const { withImportOwner } = require('../sales-sync/owner');
const { withImportBatch } = require('../sales-sync/importer');
const { createImportRepository } = require('../sales-sync/repository');
const { createHttpRequest } = require('../sales-sync/http');
const { fail, safeError, checkSignal } = require('../sales-sync/errors');
const { validateScope } = require('./config');
const { readPlan, outcome } = require('./planner');
const QUARANTINE = new Set(['INVALID_LINE', 'CATALOG_REVIEW', 'SOURCE_CONFLICT', 'RECONCILIATION_REQUIRED', 'VERIFICATION_MISMATCH']);

async function runWorker({ options, config, context, credentials, signal, now = () => new Date(),
  requestFor = (_store, credential) => createHttpRequest(credential) }) {
  const started = performance.now();
  // Construct the output explicitly: no context, provider errors, importer run
  // identifiers, catalogue values, credentials or protected hashes are logged.
  const summary = { status: 'incomplete', planned: 0, attempted: 0, published: 0, noOp: 0,
    quarantined: 0, failed: 0, pages: 0, rows: 0, logicalRows: 0, countsComplete: true,
    hasMore: false, plan: [], coverage: [] };
  try {
    if (options.apply && options.enabled !== true) { summary.status = 'disabled'; return summary; }
    if (typeof options.apply !== 'boolean') fail('INVALID_OPTIONS');
    const scope = validateScope({ ...options.scope, start: options.scope?.start ?? undefined }, now());
    checkSignal(signal);
    if (options.apply) {
      if (!context?.identity || !context?.catalog || !(credentials instanceof Map)) fail('INVALID_CONFIG');
      // Validate all configured stores before any connection, audit or request.
      for (const store of scope.stores) createHttpRequest(credentials.get(store) || {});
    }
    const work = async ({ session, signal: ownedSignal, importOne }) => {
      const activeSignal = signal ? AbortSignal.any([signal, ownedSignal]) : ownedSignal;
      checkSignal(activeSignal);
      const plan = await readPlan(session, scope, options.apply ? context.identity : undefined);
      Object.assign(summary, { planned: plan.units.length, noOp: plan.noOp, hasMore: plan.hasMore, plan: plan.units, bounds: plan.bounds });
      if (!options.apply) { summary.status = 'planned'; return; }
      // Reuse the importer's recovery under its SAME publication lock, including
      // cleanup after a crash between a committed bucket and staging purge.
      const repository = createImportRepository(session, context);
      for (const store of scope.stores) { checkSignal(activeSignal); await repository.recover(storeId(store)); }
      const requests = new Map(); // At most six transports; preserve per-store request pacing across days.
      for (const unit of plan.units) {
        checkSignal(activeSignal);
        const current = await outcome(session, unit);
        if (current !== 'missing') { summary.noOp++; summary.coverage.push({ ...unit, evidence: current }); continue; }
        summary.attempted++;
        let pages = 0, rows = 0, logicalRows = 0;
        try {
          // Only the selected credential is passed to the transport. The
          // importer never receives the environment or credentials collection.
          const credential = credentials.get(unit.store);
          if (!requests.has(unit.store)) requests.set(unit.store, requestFor(unit.store, credential));
          const request = requests.get(unit.store);
          const result = await importOne({ options: { storeSlug: unit.store, start: unit.start, end: unit.end, companyId: credential.companyId },
            request, now, report: value => {
              if (Number.isInteger(value.pages)) pages = value.pages;
              if (Number.isInteger(value.rows)) rows = value.rows;
              if (Number.isInteger(value.lineCount)) logicalRows = value.lineCount;
            } });
          if (result.status !== 'published') fail('INVALID_RUN');
          const evidence = await outcome(session, unit);
          summary.published++; summary.coverage.push({ ...unit, evidence });
        } catch (error) {
          const code = safeError(error).code;
          summary.code = code; summary.countsComplete = false;
          if (QUARANTINE.has(code)) summary.quarantined++; else summary.failed++;
          let evidence = 'unavailable';
          try { evidence = await outcome(session, unit); } catch {}
          // Commit may precede disconnect/purge failure. Report the durable
          // coverage if observable; never infer rollback from a thrown error.
          if (evidence !== 'missing' && evidence !== 'unavailable') summary.published++;
          summary.coverage.push({ ...unit, evidence });
          return; // No retry, and never advance past a failed oldest gap.
        } finally { summary.pages += pages; summary.rows += rows; summary.logicalRows += logicalRows; }
      }
      summary.status = 'complete';
    };
    if (options.apply) await withImportBatch({ config, context, signal }, work);
    else await withImportOwner(config, session => work({ session, signal: session.signal }));
  } catch (error) {
    summary.code = safeError(error).code;
    if (summary.code === 'IMPORTER_BUSY') summary.status = 'busy';
  } finally { summary.elapsedMs = Math.round(performance.now() - started); }
  return summary;
}
module.exports = { runWorker };
