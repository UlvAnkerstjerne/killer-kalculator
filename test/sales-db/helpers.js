'use strict';
const { randomUUID } = require('node:crypto');
const { createIdentity } = require('../../lib/sales-db/identity');
const { createReviewedCatalog, createSafeLine } = require('../../lib/sales-db/facts');
const { STORES } = require('../../lib/sales-db/values');
const identity = createIdentity({ key: Buffer.alloc(32, 7), version: 1 }); // Synthetic test key only.
const catalog = createReviewedCatalog({
  products: STORES.map(storeSlug => ({ storeSlug, productId: 'synthetic-product', productLabel: 'Synthetic product', groupId: 'synthetic-group', groupLabel: 'Synthetic group' })),
  payments: [{ paymentType: 'Synthetic payment', paymentCode: 'TEST' }],
});
const context = { identity, catalog };
function input(overrides = {}) {
  return { storeSlug: 'norrebro', sourceLineId: 'synthetic-line-1', businessDate: '2026-09-20',
    saleLocal: '2026-09-20 12:00:00', timeSource: 'payment', productId: 'synthetic-product',
    productLabel: 'Synthetic product', groupId: 'synthetic-group', groupLabel: 'Synthetic group',
    quantity: '1', revenueIncl: '10', revenueExcl: '8', paymentType: 'Synthetic payment', paymentCode: 'TEST', ...overrides };
}
function line(overrides = {}, ctx = context) { return createSafeLine(input(overrides), ctx); }
function run(lines = [line()], overrides = {}) {
  return { runId: randomUUID(), storeSlug: 'norrebro', start: '2026-09-20', end: '2026-09-21',
    observedAt: '2026-09-21T12:00:00.000Z', complete: true, expectedLineCount: lines.length, lines, ...overrides };
}
const request = { storeSlug: 'norrebro', start: '2026-09-20', end: '2026-09-21' };
module.exports = { identity, catalog, context, input, line, run, request };
