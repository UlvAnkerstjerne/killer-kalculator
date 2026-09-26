'use strict';
const { traverse } = require('./traverse');
const { validateOptions } = require('./importer');
const { createReviewedCatalog } = require('../sales-db/facts');
const { identifier, paymentCode } = require('../sales-db/values');
const { fail, checkSignal } = require('./errors');

// Conservative review boundary, not a claim to recognize every personal name.
// Suspect text aborts the entire envelope: no partial candidates are emitted.
function reviewText(value, kind = 'label') {
  if (typeof value !== 'string' || !value.length || value.length > (kind === 'label' ? 160 : 64) ||
      /[\p{Cc}\p{Cf}]/u.test(value)) fail('CATALOG_TEXT_REVIEW');
  const text = value.normalize('NFKC');
  if (/@/.test(text) || /[\w.+-]+\s*(?:@|\[at\]|\(at\))\s*[\w.-]+\.[a-z]{2,}/i.test(text) ||
      /https?:\/\/|www\.|\bBearer\s|-----BEGIN|\b(?:ghp_|github_pat_|sk_live_)/i.test(text) ||
      /\b[a-f0-9]{32,}\b/i.test(text) || /(?:\d[ -]?){13,19}/.test(text) ||
      /\b(?:customer|debtor|clerk|employee|cashier|card(?:number)?|phone|mobile|e-?mail|name|contact|kunde|kundenavn|navn|medarbejder|telefon|cpr|adresse|address|iban|password|secret|token|api[_ -]?key|authorization)\s*[:=#]/i.test(text) ||
      /\b(?:Mr|Mrs|Ms)\.\s+\p{L}+\s+\p{L}+/u.test(text) ||
      (kind === 'label' && /\+?\d(?:[\s().-]*\d){6,}/.test(text))) fail('CATALOG_TEXT_REVIEW');
  try {
    if (kind === 'id') identifier(value);
    if (kind === 'code') paymentCode(value);
  } catch { fail('CATALOG_TEXT_REVIEW'); }
  return value; // Preserve exact case, spacing and source spelling for review.
}
const productKey = p => JSON.stringify([p.storeSlug, p.productId, p.productLabel, p.groupId, p.groupLabel]);
// Only store and product IDs may differ. Group IDs and labels must still match.
const equivalentKey = p => JSON.stringify([p.productLabel, p.groupId, p.groupLabel]);
const paymentKey = p => JSON.stringify([p.paymentType, p.paymentCode]);
const sorted = map => [...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);

function reviewCollector(reviewed, storeSlug) {
  try { createReviewedCatalog(reviewed); } catch { fail('INVALID_CATALOG'); }
  const existingProducts = new Set(reviewed.products.map(productKey));
  const equivalents = new Set(reviewed.products.filter(p => p.storeSlug !== storeSlug).map(equivalentKey));
  // Reviewed payment tuples are global in the existing trusted schema.
  const existingPayments = new Set(reviewed.payments.map(paymentKey));
  const products = new Map(), payments = new Map();
  let inRangeRows = 0;
  function add(map, key, candidate, max) {
    const prior = map.get(key);
    if (prior) prior.affectedRows++;
    else {
      if (map.size >= max) fail('ROW_LIMIT');
      map.set(key, { ...candidate, affectedRows: 1 });
    }
  }
  return {
    row(raw) {
      // Never access order/line IDs, quantities, amounts or arbitrary fields.
      const product = { storeSlug, productId: reviewText(raw.productid, 'id'), productLabel: reviewText(raw.productname),
        groupId: raw.productgroupid == null ? null : reviewText(raw.productgroupid, 'id'),
        groupLabel: raw.productgroup == null ? null : reviewText(raw.productgroup) };
      const payment = { storeSlug, paymentType: reviewText(raw.paymenttype),
        paymentCode: raw.paymenttypecode == null ? null : reviewText(raw.paymenttypecode, 'code') };
      const pk = productKey(product), payk = paymentKey(payment);
      add(products, pk, { ...product, classification: existingProducts.has(pk) ? 'already-reviewed'
        : equivalents.has(equivalentKey(product)) ? 'mechanical-cross-store-equivalent' : 'novel' }, 10000);
      add(payments, payk, { ...payment, classification: existingPayments.has(payk) ? 'already-reviewed' : 'novel' }, 100);
      inRangeRows++;
    },
    finish() { return { inRangeRows, productCandidates: sorted(products), paymentCandidates: sorted(payments) }; },
  };
}

async function exportCatalogReview({ reviewed, request, options, signal, limits = {}, now = new Date() }) {
  const params = validateOptions(options, now);
  if (params.verificationOf || params.resumePublication || typeof options.companyId !== 'string' ||
      !/^[1-9]\d{0,63}$/.test(options.companyId)) fail('INVALID_OPTIONS');
  const collector = reviewCollector(reviewed, params.storeSlug);
  const traversal = await traverse({ ...limits, ...params, companyId: options.companyId, request, signal,
    sink: { async batch() { fail('INVALID_OPTIONS'); }, async progress() {} } }, { catalogReviewRow: collector.row });
  checkSignal(signal);
  const candidates = collector.finish();
  // Deliberately lacks top-level products/payments: cannot load as trusted input.
  return { status: 'catalog-review-candidates', format: 'kk-catalog-review-v1', approvalRequired: true,
    store: params.storeSlug, start: params.start, end: params.end, timezone: 'Europe/Copenhagen',
    terminal: true, pages: traversal.pages, rows: traversal.rows, excludedRows: traversal.rows - candidates.inRangeRows,
    ...candidates };
}
module.exports = { exportCatalogReview, reviewCollector, reviewText };
