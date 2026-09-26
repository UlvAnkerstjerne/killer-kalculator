'use strict';
const { traverse } = require('./traverse');
const { validateOptions } = require('./importer');
const { fail, safeError, checkSignal } = require('./errors');

const INTERVALS = ['before', 'inside', 'after'];
const FIELDS = ['product', 'payment-type', 'payment-type-code'];

// Uses the production parser, pagination, time/identity/decimal validation and
// reviewed catalogue. Retains only fixed counters; no repository or publisher
// is invoked, and neither raw rows nor safe projections are persisted.
async function diagnoseCatalog({ context, request, options, signal, limits = {}, now = new Date() }) {
  const params = validateOptions(options, now);
  if (params.verificationOf || params.resumePublication) fail('INVALID_OPTIONS');
  if (!context?.identity) fail('INVALID_IDENTITY');
  if (typeof context.catalog?.validate !== 'function' || typeof context.catalog?.reviewFields !== 'function') fail('INVALID_CATALOG');
  const counts = INTERVALS.map(() => FIELDS.map(() => 0));
  let candidates = 0, terminal;
  const diagnosticContext = { identity: context.identity, catalog: { validate(line) {
    try { context.catalog.validate(line); }
    catch (error) {
      if (error.code !== 'UNREVIEWED_CATALOG') throw error;
      // createSafeLine has already validated the Copenhagen time, identity and
      // exact amounts before calling this catalogue wrapper.
      const fields = context.catalog.reviewFields(line);
      if (!Array.isArray(fields) || !fields.length || new Set(fields).size !== fields.length ||
          fields.some(field => !FIELDS.includes(field))) fail('INVALID_CATALOG');
      const interval = line.businessDate < params.start ? 0 : line.businessDate >= params.end ? 2 : 1;
      candidates++;
      for (const field of fields) counts[interval][FIELDS.indexOf(field)]++;
      throw error; // Catalogue rejection is preserved, including out-of-range rows.
    }
  } } };
  try {
    await traverse({ ...limits, ...params, companyId: options.companyId, context: diagnosticContext, request, signal,
      sink: { async batch() {}, async progress() {}, async terminal(value) { terminal = value; } } });
  } catch (error) {
    // An upstream error with the same code, or incomplete/invalid pagination,
    // cannot be mistaken for the terminal catalogue rejection.
    if (error.code !== 'CATALOG_REVIEW' || !terminal) throw safeError(error);
  }
  checkSignal(signal);
  if (!terminal || terminal.reviewCount !== candidates) fail('INVALID_PAGE');
  const reviews = [];
  for (let i = 0; i < INTERVALS.length; i++) for (let f = 0; f < FIELDS.length; f++) {
    if (counts[i][f]) reviews.push({ interval: INTERVALS[i], field: FIELDS[f], affectedRows: counts[i][f] });
  }
  return { status: 'catalog-diagnostic', store: params.storeSlug, start: params.start, end: params.end,
    timezone: 'Europe/Copenhagen', terminal: true, pages: terminal.pages, rows: terminal.rows,
    reviewCount: candidates, reviews, verified: false };
}
module.exports = { diagnoseCatalog };
