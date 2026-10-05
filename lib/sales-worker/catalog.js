'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createReviewedCatalog } = require('../sales-db/facts');
const { STORES, exactKeys } = require('../sales-db/values');
const { reviewText, reviewProductLabel } = require('../sales-sync/catalog-text');
const { fail } = require('../sales-sync/errors');
const PRODUCT = ['storeSlug', 'productId', 'productLabel', 'groupId', 'groupLabel'];
const PAYMENT = ['paymentType', 'paymentCode'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const key = (entry, fields) => JSON.stringify(fields.map(field => entry[field]));
const sorted = (entries, fields) => [...entries].sort((a, b) => {
  const x = key(a, fields), y = key(b, fields);
  return x < y ? -1 : x > y ? 1 : 0;
});
const digest = (entries, fields) => sha(JSON.stringify(sorted(entries, fields).map(entry => fields.map(field => entry[field]))));
function check(ok) { if (!ok) fail('INVALID_CATALOG'); }
function read(file, maximum) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.size <= maximum);
    const buffer = Buffer.alloc(maximum + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    check(count <= maximum);
    return buffer.subarray(0, count);
  } finally { fs.closeSync(fd); }
}

// Trust is the reviewed, immutable deployment artifact: these two fixed files
// must change together in a repository review. No provider, CLI or environment
// input selects a path, supplies provenance, or changes the expected formats.
function loadCatalog() {
  try {
    const root = path.join(__dirname, '../..');
    const bytes = read(path.join(root, 'catalogues/onlinepos-reviewed.json'), 1024 * 1024);
    const provenance = JSON.parse(read(path.join(root, 'docs/onlinepos-catalogue-provenance.json'), 128 * 1024));
    check(provenance.provenanceVersion === 1 && provenance.catalogueVersion === 1);
    check(sha(bytes) === provenance.catalogSha256);
    const reviewed = JSON.parse(bytes);
    // Catalogue v1 is the existing two-key format; versioning is declared in
    // provenance so the already reviewed catalogue bytes remain unchanged.
    exactKeys(reviewed, ['products', 'payments']);
    check(Array.isArray(reviewed.products) && reviewed.products.length > 0 && reviewed.products.length <= 10000);
    check(Array.isArray(reviewed.payments) && reviewed.payments.length > 0 && reviewed.payments.length <= 100);
    const catalog = createReviewedCatalog(reviewed);
    const identities = new Set(), payments = new Set();
    for (const product of reviewed.products) {
      reviewText(product.productId, 'id'); reviewProductLabel(product.productLabel);
      if (product.groupId !== null) reviewText(product.groupId, 'id');
      if (product.groupLabel !== null) reviewText(product.groupLabel);
      const identity = JSON.stringify([product.storeSlug, product.productId]);
      // Duplicate tuples and a changed tuple under an existing store/product ID
      // both require review; neither can silently collapse into a Set.
      check(!identities.has(identity)); identities.add(identity);
    }
    for (const payment of reviewed.payments) {
      reviewText(payment.paymentType);
      if (payment.paymentCode !== null) reviewText(payment.paymentCode, 'code');
      const tuple = key(payment, PAYMENT);
      check(!payments.has(tuple)); payments.add(tuple);
    }
    const stores = [...new Set(reviewed.products.map(product => product.storeSlug))].sort();
    check(JSON.stringify(stores) === JSON.stringify([...STORES].sort()));
    exactKeys(provenance.counts, ['products', 'payments', 'stores']);
    check(provenance.counts.products === reviewed.products.length && provenance.counts.payments === reviewed.payments.length && provenance.counts.stores === stores.length);
    check(digest(reviewed.products, PRODUCT) === provenance.productsSha256 && digest(reviewed.payments, PAYMENT) === provenance.paymentsSha256);
    check(Array.isArray(provenance.reviewedStores) && provenance.reviewedStores.length === stores.length);
    for (const [i, storeSlug] of stores.entries()) {
      const record = provenance.reviewedStores[i];
      exactKeys(record, ['storeSlug', 'productCount', 'productsSha256']);
      const products = reviewed.products.filter(product => product.storeSlug === storeSlug);
      check(record.storeSlug === storeSlug && record.productCount === products.length && record.productsSha256 === digest(products, PRODUCT));
    }
    const project = fields => entry => Object.fromEntries(fields.map(field => [field, entry[field]]));
    const canonical = { products: sorted(reviewed.products, PRODUCT).map(project(PRODUCT)),
      payments: sorted(reviewed.payments, PAYMENT).map(project(PAYMENT)) };
    check(bytes.equals(Buffer.from(JSON.stringify(canonical, null, 2) + '\n')));
    // Merge auto-admitted entries so future workers recognise them without
    // re-discovering on every run. The reviewed file remains the trust anchor;
    // auto-admitted entries use the same opaque-label policy from PR #46.
    const admitted = loadAdmitted();
    const productKeys = new Set(reviewed.products.map(p => key(p, PRODUCT)));
    for (const p of admitted.products) {
      try {
        if (!STORES.includes(p.storeSlug)) continue;
        const candidate = { storeSlug: p.storeSlug, productId: p.productId, productLabel: p.productLabel,
          groupId: p.groupId, groupLabel: p.groupLabel };
        if (productKeys.has(key(candidate, PRODUCT))) continue;
        // Validate text safety before admitting.
        reviewText(candidate.productId, 'id'); reviewProductLabel(candidate.productLabel);
        if (candidate.groupId !== null) reviewText(candidate.groupId, 'id');
        if (candidate.groupLabel !== null) reviewText(candidate.groupLabel);
        catalog.admit({ storeId: require('../sales-db/values').storeId(p.storeSlug),
          productId: candidate.productId, productLabel: candidate.productLabel,
          groupId: candidate.groupId, groupLabel: candidate.groupLabel,
          paymentType: reviewed.payments[0].paymentType, paymentCode: reviewed.payments[0].paymentCode });
      } catch { /* skip invalid entries */ }
    }
    const paymentKeys = new Set(reviewed.payments.map(p => key(p, PAYMENT)));
    for (const p of admitted.payments) {
      try {
        if (paymentKeys.has(key(p, PAYMENT))) continue;
        reviewText(p.paymentType);
        if (p.paymentCode !== null) reviewText(p.paymentCode, 'code');
        catalog.admit({ storeId: 1, productId: reviewed.products[0].productId,
          productLabel: reviewed.products[0].productLabel,
          groupId: reviewed.products[0].groupId, groupLabel: reviewed.products[0].groupLabel,
          paymentType: p.paymentType, paymentCode: p.paymentCode });
      } catch { /* skip invalid entries */ }
    }
    return catalog;
  } catch { fail('INVALID_CATALOG'); }
}
function admittedPath() { return path.join(__dirname, '../../catalogues/auto-admitted.json'); }
function loadAdmitted() {
  try {
    const bytes = read(admittedPath(), 256 * 1024);
    const data = JSON.parse(bytes);
    if (!Array.isArray(data.products) || !Array.isArray(data.payments)) return { products: [], payments: [] };
    return { products: data.products.slice(0, 5000), payments: data.payments.slice(0, 50) };
  } catch { return { products: [], payments: [] }; }
}
function persistAdmitted(admitted) {
  if (!admitted.products.length && !admitted.payments.length) return;
  const existing = loadAdmitted();
  const productKeys = new Set(existing.products.map(p => key(p, PRODUCT)));
  const paymentKeys = new Set(existing.payments.map(p => key(p, PAYMENT)));
  for (const p of admitted.products) {
    const k = key({ storeSlug: p.storeSlug, productId: p.productId, productLabel: p.productLabel,
      groupId: p.groupId, groupLabel: p.groupLabel }, PRODUCT);
    if (!productKeys.has(k)) { existing.products.push({ storeSlug: p.storeSlug, productId: p.productId,
      productLabel: p.productLabel, groupId: p.groupId, groupLabel: p.groupLabel }); productKeys.add(k); }
  }
  for (const p of admitted.payments) {
    const k = key(p, PAYMENT);
    if (!paymentKeys.has(k)) { existing.payments.push({ paymentType: p.paymentType, paymentCode: p.paymentCode }); paymentKeys.add(k); }
  }
  fs.writeFileSync(admittedPath(), JSON.stringify(existing, null, 2) + '\n');
}
module.exports = { loadCatalog, loadAdmitted, persistAdmitted };
