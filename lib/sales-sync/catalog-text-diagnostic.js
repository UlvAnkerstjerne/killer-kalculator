'use strict';
const { traverse } = require('./traverse');
const { validateOptions } = require('./options');
const { createReviewedCatalog } = require('../sales-db/facts');
const { inspectText } = require('./catalog-text');
const { fail, checkSignal } = require('./errors');

const MAX_DIAGNOSTICS = 12;
const FIELDS = [
  ['productid', 'product', 'product-id', 'id', false],
  ['productname', 'product', 'product-label', 'label', false],
  ['productgroupid', 'product', 'product-group-id', 'id', true],
  ['productgroup', 'product', 'product-group-label', 'label', true],
  ['paymenttype', 'payment', 'payment-type', 'label', false],
  ['paymenttypecode', 'payment', 'payment-type-code', 'code', true],
];
function textDiagnosticCollector() {
  const retained = new Map();
  let inRangeRows = 0, rejectedRows = 0, rejectedFields = 0;
  return {
    row(raw) {
      inRangeRows++; let rejected = false;
      for (const [key, candidateKind, fieldRole, kind, nullable] of FIELDS) {
        const value = raw[key];
        if (nullable && value == null) continue;
        const issue = inspectText(value, kind);
        if (!issue) continue;
        rejected = true; rejectedFields++;
        const diagnostic = { candidateKind, fieldRole, ...issue };
        // Key contains only fixed enums, lengths and non-content character data.
        const signature = JSON.stringify(diagnostic), prior = retained.get(signature);
        if (prior) prior.occurrences++;
        else {
          retained.set(signature, { ...diagnostic, occurrences: 1 });
          if (retained.size > MAX_DIAGNOSTICS) {
            // Keep the lexicographically smallest signatures, independent of row
            // order. Evicted signatures can never re-enter the decreasing bound.
            retained.delete([...retained.keys()].sort().at(-1));
          }
        }
      }
      if (rejected) rejectedRows++;
    },
    finish() {
      const diagnostics = [...retained].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, d]) => d);
      const omittedFields = rejectedFields - diagnostics.reduce((sum, d) => sum + d.occurrences, 0);
      return { inRangeRows, rejectedRows, rejectedFields, diagnosticLimit: MAX_DIAGNOSTICS,
        diagnosticsTruncated: omittedFields > 0, omittedFields, diagnostics };
    },
  };
}
async function diagnoseCatalogText({ reviewed, request, options, signal, limits = {}, now = new Date() }) {
  // Refuse write/identity paths before option validation can load their helpers.
  if (options?.verificationOf || options?.resumePublication) fail('INVALID_OPTIONS');
  const params = validateOptions(options, now);
  if (typeof options.companyId !== 'string' || !/^[1-9]\d{0,63}$/.test(options.companyId)) fail('INVALID_OPTIONS');
  try { createReviewedCatalog(reviewed); } catch { fail('INVALID_CATALOG'); }
  const collector = textDiagnosticCollector();
  const traversal = await traverse({ ...limits, ...params, companyId: options.companyId, request, signal,
    sink: { async batch() { fail('INVALID_OPTIONS'); }, async progress() {} } }, { catalogReviewRow: collector.row });
  checkSignal(signal);
  const summary = collector.finish();
  // No labels, previews, identifiers, approved candidates or arbitrary error data.
  const result = { status: summary.rejectedFields ? 'incomplete' : 'catalog-text-diagnostic',
    ...(summary.rejectedFields ? { code: 'CATALOG_TEXT_REVIEW' } : {}), format: 'kk-catalog-text-diagnostic-v1',
    redacted: true, approvalRequired: true, store: params.storeSlug, start: params.start, end: params.end,
    timezone: 'Europe/Copenhagen', terminal: true, pages: traversal.pages, rows: traversal.rows,
    excludedRows: traversal.rows - summary.inRangeRows, ...summary };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 16384) fail('CATALOG_TEXT_REVIEW');
  return result;
}
module.exports = { diagnoseCatalogText, textDiagnosticCollector };
