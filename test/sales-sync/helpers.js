'use strict';
const { context } = require('../sales-db/helpers');
const { ORIGIN, PREFIX } = require('../../lib/sales-sync/traverse');
const { cphMidnightUnix } = require('../../lib/pos-fetcher');
const start = '2025-01-01', end = '2025-02-01';
const initial = `${ORIGIN}${PREFIX}${cphMidnightUnix(start)}`;
const CANARY = ['SYNTHETIC', 'PRIVATE', 'IMPORTER', 'CANARY'].join('_');
function raw(overrides = {}) {
  return { orderlineid: 'synthetic-line-1', timestamp_pay: '2025-01-10 12:00:00',
    productid: 'synthetic-product', productname: 'Synthetic product', productgroupid: 'synthetic-group',
    productgroup: 'Synthetic group', count: '1', price: '10', priceexclvat: '8',
    paymenttype: 'Synthetic payment', paymenttypecode: 'TEST', ...overrides };
}
function body(rows, page = 1, next = null) {
  // Numeric lexemes reach the parser as JSON numbers, including >2^53 IDs.
  return JSON.stringify({ data: rows, current_page: page, next_page_url: next })
    .replace(/"(count|price|priceexclvat|orderlineid|firmaid)":"(-?(?:0|[1-9]\d*)(?:\.\d+)?)"/g, '"$1":$2');
}
function provider(pages, base = initial) {
  const calls = [];
  const request = async url => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get('page') || '1');
    return body(pages[page - 1], page, page < pages.length ? `${base}?page=${page + 1}` : null);
  };
  return { request, calls };
}
const options = { storeSlug: 'norrebro', companyId: '12345', start, end };
const config = { enabled: true, connectionString: 'postgresql://unused.invalid/synthetic' };
module.exports = { context, start, end, initial, CANARY, raw, body, provider, options, config };
