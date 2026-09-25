'use strict';
const { createHash } = require('node:crypto');
const { fail } = require('./errors');
const { storeId, exactKeys, decimal, saleTime, identifier, paymentCode: paymentCodeId } = require('./values');

const INPUT_KEYS = ['storeSlug', 'sourceLineId', 'businessDate', 'saleLocal', 'timeSource',
  'productId', 'productLabel', 'groupId', 'groupLabel', 'quantity', 'revenueIncl',
  'revenueExcl', 'paymentType', 'paymentCode'];
const CONTENT_KEYS = ['businessDate', 'saleLocal', 'secondOfDay', 'timeQuality', 'productId',
  'productLabel', 'groupId', 'groupLabel', 'quantity', 'revenueIncl', 'revenueExcl', 'paymentType', 'paymentCode'];
const SAFE_KEYS = ['storeId', 'sourceKey', 'keyVersion', ...CONTENT_KEYS, 'fingerprint'];
function label(value) {
  if (typeof value !== 'string' || !value.length || value.length > 160 || /[\x00-\x1f\x7f]/.test(value)) fail();
  return value;
}
function catalogTuple(line) {
  return JSON.stringify([line.storeId, line.productId, line.productLabel, line.groupId, line.groupLabel]);
}
// Trusted, explicitly reviewed configuration only. Never build this list from
// a provider response. Historical label variants each need their own entry.
function createReviewedCatalog({ products, payments }) {
  if (!Array.isArray(products) || !Array.isArray(payments)) fail();
  const approvedProducts = new Set(products.map(entry => {
    exactKeys(entry, ['storeSlug', 'productId', 'productLabel', 'groupId', 'groupLabel']);
    return catalogTuple({ storeId: storeId(entry.storeSlug), productId: identifier(entry.productId),
      productLabel: label(entry.productLabel), groupId: entry.groupId === null ? null : identifier(entry.groupId),
      groupLabel: entry.groupLabel === null ? null : label(entry.groupLabel) });
  }));
  const approvedPayments = new Set(payments.map(entry => {
    exactKeys(entry, ['paymentType', 'paymentCode']);
    return JSON.stringify([label(entry.paymentType), entry.paymentCode === null ? null : paymentCodeId(entry.paymentCode)]);
  }));
  const approvedPaymentTypes = new Set(payments.map(entry => entry.paymentType));
  return Object.freeze({ reviewFields(line) {
    // Diagnostic categories only. Never return unreviewed text or learn new
    // mappings. Malformed catalogue fields cannot become a review candidate.
    label(line.productLabel);
    if (line.groupLabel !== null) label(line.groupLabel);
    label(line.paymentType);
    if (line.paymentCode !== null) paymentCodeId(line.paymentCode);
    const fields = [];
    if (!approvedProducts.has(catalogTuple(line))) fields.push('product');
    if (!approvedPayments.has(JSON.stringify([line.paymentType, line.paymentCode]))) {
      fields.push(approvedPaymentTypes.has(line.paymentType) ? 'payment-type-code' : 'payment-type');
    }
    return fields;
  }, validate(line) {
    if (!approvedProducts.has(catalogTuple(line)) ||
        !approvedPayments.has(JSON.stringify([line.paymentType, line.paymentCode]))) fail('UNREVIEWED_CATALOG');
  } });
}
function fingerprint(line) {
  return createHash('sha256').update(JSON.stringify(CONTENT_KEYS.map(key => line[key]))).digest();
}
function validateSafeLine(line, { identity, catalog }) {
  exactKeys(line, SAFE_KEYS);
  if (!Number.isInteger(line.storeId) || line.storeId < 1 || line.storeId > 6 ||
      !Buffer.isBuffer(line.sourceKey) || line.sourceKey.length !== 32 || line.keyVersion !== identity.version ||
      !Buffer.isBuffer(line.fingerprint) || line.fingerprint.length !== 32) fail();
  if (typeof line.timeQuality !== 'string') fail();
  const source = line.timeQuality.replace(/_ambiguous$/, '');
  const time = saleTime(line.businessDate, line.saleLocal, source);
  if (time.secondOfDay !== line.secondOfDay || time.timeQuality !== line.timeQuality) fail();
  identifier(line.productId);
  if (line.groupId !== null) identifier(line.groupId);
  for (const key of ['quantity', 'revenueIncl', 'revenueExcl']) if (decimal(line[key]) !== line[key]) fail();
  catalog.validate(line);
  if (!fingerprint(line).equals(line.fingerprint)) fail();
  return line;
}
function createSafeLine(input, context) {
  exactKeys(input, INPUT_KEYS);
  const time = saleTime(input.businessDate, input.saleLocal, input.timeSource);
  const line = {
    storeId: storeId(input.storeSlug), sourceKey: context.identity.protect(input.storeSlug, input.sourceLineId),
    keyVersion: context.identity.version, businessDate: input.businessDate,
    saleLocal: time.saleLocal, secondOfDay: time.secondOfDay, timeQuality: time.timeQuality,
    productId: input.productId, productLabel: input.productLabel, groupId: input.groupId, groupLabel: input.groupLabel,
    quantity: decimal(input.quantity), revenueIncl: decimal(input.revenueIncl), revenueExcl: decimal(input.revenueExcl),
    paymentType: input.paymentType, paymentCode: input.paymentCode,
  };
  line.fingerprint = fingerprint(line);
  return Object.freeze(validateSafeLine(line, context));
}
// Explicit public projection: no source key, raw ID, digest or run provenance.
// These are foundation values, not a replacement for any existing route format.
function publicLine(line, context) {
  validateSafeLine(line, context);
  return {
    businessDate: line.businessDate, saleLocal: line.saleLocal, secondOfDay: line.secondOfDay,
    timeQuality: line.timeQuality, productId: line.productId, productLabel: line.productLabel,
    groupId: line.groupId, groupLabel: line.groupLabel, quantity: line.quantity,
    revenueIncl: line.revenueIncl, revenueExcl: line.revenueExcl,
    paymentType: line.paymentType, paymentCode: line.paymentCode,
  };
}
module.exports = { createReviewedCatalog, createSafeLine, validateSafeLine, publicLine, CONTENT_KEYS };
