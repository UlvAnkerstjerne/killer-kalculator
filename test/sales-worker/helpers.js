'use strict';
const { createIdentity } = require('../../lib/sales-db/identity');
const { STORES } = require('../../lib/sales-db/values');
const { loadCatalog } = require('../../lib/sales-worker/config');
const { runWorker } = require('../../lib/sales-worker/worker');
const { body } = require('../sales-sync/helpers');
const reviewed = require('../../catalogues/onlinepos-reviewed.json');
const identity = createIdentity({ key: Buffer.alloc(32, 7), version: 1 });
const context = { identity, catalog: loadCatalog() };
const credentials = new Map(STORES.map((s, i) => [s, { token: 'synthetic-only-' + i, companyId: String(100 + i) }]));
const now = () => new Date();
const scope = { stores: ['norrebro'], start: '2026-09-20', end: '2026-09-21', maxDays: 1 };
function row(store = 'norrebro', day = '2026-09-20', extra = {}) {
  const p = reviewed.products.find(p => p.storeSlug === store && (store !== 'frederiksberg' || p.productLabel === ''));
  const payment = reviewed.payments[0];
  return { orderlineid: 'synthetic-worker-' + store + '-' + day,
    firmaid: credentials.get(store).companyId, timestamp_pay: day + ' 12:00:00',
    productid: p.productId, productname: p.productLabel, productgroupid: p.groupId,
    productgroup: p.groupLabel, count: '1', price: '10', priceexclvat: '8',
    paymenttype: payment.paymentType, paymenttypecode: payment.paymentCode, ...extra };
}
function worker(config, extra = {}) {
  return runWorker({ config, context, credentials, now,
    options: { apply: true, enabled: true, scope },
    requestFor: () => async () => body([row()]), ...extra });
}
module.exports = { STORES, identity, context, credentials, now, scope, row, body, worker };
