'use strict';
const { createSafeLine } = require('../sales-db/facts');
const { saleTime } = require('../sales-db/values');
const { fail } = require('./errors');

function readLineTime(raw, companyId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_LINE');
  if (Object.hasOwn(raw, 'firmaid') && raw.firmaid !== companyId) fail('STORE_MISMATCH');
  // Pick exactly one trustworthy time. A malformed primary time is never hidden
  // by a valid fallback. Date-only source values retain explicit missing time.
  const primary = raw.timestamp_pay !== null && raw.timestamp_pay !== undefined;
  const source = primary ? raw.timestamp_pay : raw.datetime;
  let businessDate, saleLocal, timeSource;
  if (typeof source === 'string' && /^20\d\d-\d{2}-\d{2}$/.test(source)) {
    businessDate = source; saleLocal = null; timeSource = 'missing';
  } else if (typeof source === 'string' && /^20\d\d-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(source)) {
    businessDate = source.slice(0, 10); saleLocal = source.replace('T', ' ');
    timeSource = primary ? 'payment' : 'fallback';
  } else fail('INVALID_LINE');
  try { saleTime(businessDate, saleLocal, timeSource); }
  catch { fail('INVALID_LINE'); }
  return { businessDate, saleLocal, timeSource };
}
function normalizeLine(raw, { storeSlug, companyId, context }) {
  const { businessDate, saleLocal, timeSource } = readLineTime(raw, companyId);
  try {
    // New object, explicit allowlist. Raw identity is consumed by the Stage 1
    // HMAC helper and is absent from its result and from every downstream API.
    return createSafeLine({
      storeSlug, sourceLineId: raw.orderlineid, businessDate, saleLocal, timeSource,
      productId: raw.productid, productLabel: raw.productname,
      groupId: raw.productgroupid ?? null, groupLabel: raw.productgroup ?? null,
      quantity: raw.count, revenueIncl: raw.price, revenueExcl: raw.priceexclvat,
      paymentType: raw.paymenttype, paymentCode: raw.paymenttypecode ?? null,
    }, context);
  } catch (error) {
    if (error.code === 'UNREVIEWED_CATALOG') fail('CATALOG_REVIEW');
    fail('INVALID_LINE');
  }
}
module.exports = { normalizeLine, readLineTime };
