'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const identityModule = require('../../lib/sales-db/identity');
const { exportCatalogReview, reviewCollector } = require('../../lib/sales-sync/catalog-review');
const { createReviewedCatalog } = require('../../lib/sales-db/facts');
const { main, parseArgs } = require('../../scripts/sales-backfill');
const { raw, provider, body, options, start, end, initial, CANARY } = require('./helpers');
const product = { storeSlug: 'norrebro', productId: 'synthetic-product', productLabel: 'Synthetic product',
  groupId: 'synthetic-group', groupLabel: 'Synthetic group' };
const reviewed = { products: [product], payments: [{ paymentType: 'Synthetic payment', paymentCode: 'TEST' }] };
const run = (pages, extra = {}) => exportCatalogReview({ reviewed, options, request: provider(pages).request, ...extra });

async function cli(rows, work) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-catalog-review-'));
  const file = path.join(dir, 'baseline.json');
  await fs.writeFile(file, JSON.stringify(reviewed));
  const args = ['--store', options.storeSlug, '--from', start, '--through', end, '--catalog', file, '--export-catalog-review'];
  try { return await work(args, provider([rows]).request); }
  finally { await fs.rm(dir, { recursive: true }); }
}
test('review CLI needs no database or identity configuration and cannot connect or create HMAC identities', async () => {
  const originalConnect = Client.prototype.connect, originalIdentity = identityModule.createIdentity, originalHmac = crypto.createHmac;
  let connections = 0, identities = 0, hmacs = 0;
  Client.prototype.connect = () => { connections++; throw new Error('Unexpected database connection'); };
  identityModule.createIdentity = () => { identities++; throw new Error('Unexpected identity'); };
  crypto.createHmac = () => { hmacs++; throw new Error('Unexpected HMAC'); };
  try {
    await cli([raw({ orderlineid: null, count: 'invalid', price: 'invalid', priceexclvat: null })], async (args, request) => {
      const env = new Proxy({ KK_BACKFILL_COMPANY_ID: '12345' }, { get(target, key) {
        assert.ok(!String(key).startsWith('KK_SALES_'), 'review mode must not read database/identity configuration');
        return target[key];
      } });
      const output = [];
      assert.equal(await main(args, env, text => output.push(text), { request }), 0);
      assert.equal(output.length, 1);
      assert.equal(JSON.parse(output[0]).status, 'catalog-review-candidates');
      assert.throws(() => createReviewedCatalog(JSON.parse(output[0])), 'review envelope is not trusted input');
    });
    assert.deepEqual({ connections, identities, hmacs }, { connections: 0, identities: 0, hmacs: 0 });
  } finally { Client.prototype.connect = originalConnect; identityModule.createIdentity = originalIdentity; crypto.createHmac = originalHmac; }
});
test('collector never reads raw source IDs, monetary values, private fields or arbitrary properties', () => {
  const item = raw();
  for (const key of ['orderlineid', 'orderid', 'count', 'price', 'priceexclvat', 'customer', 'card', 'clerk', 'headers']) {
    Object.defineProperty(item, key, { get() { assert.fail('Prohibited source field accessed'); } });
  }
  const collector = reviewCollector(reviewed, options.storeSlug);
  collector.row(item);
  assert.equal(collector.finish().inRangeRows, 1);
});
test('review boundaries filter before extraction and still count every provider row', async () => {
  const result = await run([[raw({ timestamp_pay: '2024-12-31 23:59:59', productname: 'name: private' }),
    raw({ timestamp_pay: start + ' 00:00:00' }), raw({ timestamp_pay: '2025-01-31 23:59:59' }),
    raw({ timestamp_pay: end + ' 00:00:00', productname: null }), raw({ timestamp_pay: '2025-02-02', paymenttype: null })]]);
  assert.equal(result.rows, 5); assert.equal(result.inRangeRows, 2); assert.equal(result.excludedRows, 3);
  assert.equal(result.productCandidates[0].affectedRows, 2); assert.equal(result.paymentCandidates[0].affectedRows, 2);
});
for (const timestamp of ['', 'invalid', '2025-02-30', '2025-02-30 12:00:00', '2025-03-30 02:30:00', '2024-12-31 24:00:00']) {
  test('review rejects malformed primary/calendar/DST time even with valid fallback', async () => {
    await assert.rejects(run([[raw({ timestamp_pay: timestamp, datetime: start + ' 12:00:00' })]]), { code: 'INVALID_LINE' });
  });
}
test('missing time and invalid raw shape fail closed; valid fallback/date-only/autumn time survive', async () => {
  for (const item of [null, [], false, raw({ timestamp_pay: null, datetime: null }), raw({ timestamp_pay: undefined, datetime: undefined })]) {
    await assert.rejects(run([[item]]), { code: 'INVALID_LINE' });
  }
  const r = await run([[raw({ timestamp_pay: null, datetime: start }), raw({ timestamp_pay: start }),
    raw({ timestamp_pay: '2025-10-26 02:30:00' })]], { options: { ...options, end: '2025-11-01' } });
  assert.equal(r.inRangeRows, 3);
});
test('review rejects store mismatch before, inside and after interval and invalid expected company', async () => {
  for (const timestamp_pay of ['2024-12-31', start, end]) await assert.rejects(run([[raw({ firmaid: '99999', timestamp_pay })]]), { code: 'STORE_MISMATCH' });
  for (const companyId of [undefined, '', '0', '01', 'bad']) await assert.rejects(run([[]], { options: { ...options, companyId } }), { code: 'INVALID_OPTIONS' });
});
test('nonchronological review pages include retroactive rows and validate all-row declared totals', async () => {
  for (const total of [3, 2]) {
    let calls = 0;
    const request = async () => JSON.stringify({ data: ++calls === 1 ? [raw({ timestamp_pay: end })]
      : [raw({ timestamp_pay: start }), raw({ timestamp_pay: '2024-12-31' })],
    current_page: calls, next_page_url: calls === 1 ? initial + '?page=2' : null, total });
    if (total === 2) await assert.rejects(run(null, { request }), { code: 'INVALID_PAGE' });
    else {
      const r = await run(null, { request });
      assert.equal(r.pages, 2); assert.equal(r.rows, 3); assert.equal(r.inRangeRows, 1); assert.equal(r.excludedRows, 2);
    }
    assert.equal(calls, 2);
  }
});
test('review requires terminal proof and retains pagination and resource/interruption safeguards', async () => {
  const first = body([raw()], 1, initial + '?page=2');
  for (const tail of ['{}', body([], 2, initial), JSON.stringify({ data: [], current_page: 2, last_page: 3, next_page_url: null })]) {
    let calls = 0; await assert.rejects(run(null, { request: async () => ++calls === 1 ? first : tail })); assert.equal(calls, 2);
  }
  await assert.rejects(run([[raw()], []], { limits: { maxPages: 1 } }), { code: 'PAGE_LIMIT' });
  await assert.rejects(run([[raw(), raw()]], { limits: { maxRows: 1 } }), { code: 'ROW_LIMIT' });
  await assert.rejects(run([[raw()]], { limits: { maxBytes: 10 } }), { code: 'PAGE_TOO_LARGE' });
  await assert.rejects(run(null, { request: async () => JSON.stringify({ data: [raw(), raw()], current_page: 1, per_page: 1, next_page_url: null }) }), { code: 'INVALID_PAGE' });
  const c = new AbortController(); c.abort(); await assert.rejects(run([[]], { signal: c.signal }), { code: 'INTERRUPTED' });
});
test('unique product/payment tuples sort deterministically with exact independent occurrence counts', async () => {
  const rows = [raw({ productid: 'z', productname: 'Zed' }), raw(), raw({ paymenttypecode: 'ALT' }), raw()];
  const a = await run([rows]), b = await run([[...rows].reverse()]);
  assert.deepEqual(a, b); assert.equal(a.productCandidates.length, 2); assert.equal(a.paymentCandidates.length, 2);
  assert.deepEqual(a.productCandidates.map(p => p.affectedRows), [3, 1]);
  assert.equal(a.paymentCandidates.find(p => p.paymentCode === 'ALT').affectedRows, 1);
  assert.equal(a.paymentCandidates.find(p => p.paymentCode === 'TEST').affectedRows, 3);
  assert.ok(a.productCandidates.every(p => !Object.hasOwn(p, 'paymentType')));
  assert.ok(a.paymentCandidates.every(p => !Object.hasOwn(p, 'productId')));
});
test('classification requires exact reviewed membership or cross-store equivalence including group ID', async () => {
  const baseline = { products: [product, { ...product, storeSlug: 'vesterbro', productId: 'reviewed-elsewhere', productLabel: 'Equivalent' }], payments: reviewed.payments };
  const r = await run([[raw(), raw({ productid: 'other', productname: 'Equivalent' }),
    raw({ productid: 'novel', productname: 'Equivalent', productgroupid: 'different-group' }),
    raw({ productid: 'same-store-new-id' }), raw({ paymenttypecode: 'UNREVIEWED' })]], { reviewed: baseline });
  const classification = id => r.productCandidates.find(p => p.productId === id).classification;
  assert.equal(classification('synthetic-product'), 'already-reviewed');
  assert.equal(classification('other'), 'mechanical-cross-store-equivalent');
  assert.equal(classification('novel'), 'novel'); assert.equal(classification('same-store-new-id'), 'novel');
  assert.equal(r.paymentCandidates.find(p => p.paymentCode === 'UNREVIEWED').classification, 'novel');
  assert.equal(r.paymentCandidates.find(p => p.paymentCode === 'TEST').classification, 'already-reviewed');
});
for (const label of ['alice@example.invalid', 'søren@eksempel.dk', '+45 12 34 56 78', '4111 1111 1111 1111',
  'customer: Example Person', 'navn: Example Person', 'CPR: 010101-1234', 'Mr. Example Person', 'Bearer synthetic-token',
  'https://example.invalid/private', 'a'.repeat(64), 'bad\nlabel', 'hidden\u200Blabel', 'x'.repeat(161), '']) {
  test('suspicious or malformed labels fail closed without echoing or partially exporting candidates', async () => {
    await cli([raw(), raw({ productname: label })], async (args, request) => {
      const output = [];
      assert.equal(await main(args, { KK_BACKFILL_COMPANY_ID: '12345' }, s => output.push(s), { request }), 1);
      assert.deepEqual(output.map(JSON.parse), [{ status: 'incomplete', code: 'CATALOG_TEXT_REVIEW', redacted: true }]);
    });
  });
}
test('privacy validation covers every emitted catalogue string and preserves exact allowed spacing', async () => {
  for (const field of ['productname', 'productgroup', 'paymenttype', 'productid', 'productgroupid', 'paymenttypecode']) {
    await assert.rejects(run([[raw({ [field]: 'alice@example.invalid' })]]), { code: 'CATALOG_TEXT_REVIEW' });
  }
  const r = await run([[raw({ paymenttypecode: 'mixed 1', productgroup: null, productgroupid: null })]]);
  assert.equal(r.paymentCandidates[0].paymentCode, 'mixed 1'); assert.equal(r.productCandidates[0].groupLabel, null);
});
test('output has a closed allowlist and omits private fields, raw IDs and protected hashes', async () => {
  const hash = 'b'.repeat(64);
  const r = await run([[raw({ orderlineid: CANARY, orderid: CANARY, customer: CANARY, card: CANARY, clerk: CANARY,
    headers: { token: CANARY }, fingerprint: hash, sourceKey: hash, identityKey: hash, databaseUrl: CANARY })]]);
  assert.ok(!JSON.stringify(r).includes(CANARY)); assert.ok(!JSON.stringify(r).includes(hash));
  assert.deepEqual(Object.keys(r).sort(), ['status', 'format', 'approvalRequired', 'store', 'start', 'end', 'timezone', 'terminal', 'pages', 'rows', 'excludedRows', 'inRangeRows', 'productCandidates', 'paymentCandidates'].sort());
  assert.deepEqual(Object.keys(r.productCandidates[0]).sort(), ['storeSlug', 'productId', 'productLabel', 'groupId', 'groupLabel', 'classification', 'affectedRows'].sort());
  assert.deepEqual(Object.keys(r.paymentCandidates[0]).sort(), ['storeSlug', 'paymentType', 'paymentCode', 'classification', 'affectedRows'].sort());
  assert.equal(r.approvalRequired, true);
});
test('review mode rejects every write/diagnostic/verification combination and empty results remain unapproved', async () => {
  for (const mode of [['--apply'], ['--dry-run'], ['--validate'], ['--diagnose-catalog'], ['--verify-run', 'synthetic'], ['--resume-publication', 'synthetic']]) {
    for (const args of [['--export-catalog-review', ...mode], [...mode, '--export-catalog-review']]) assert.throws(() => parseArgs(args), { code: 'INVALID_OPTIONS' });
  }
  for (const extra of [{ verificationOf: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }, { resumePublication: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }]) {
    await assert.rejects(run([[]], { options: { ...options, ...extra } }), { code: 'INVALID_OPTIONS' });
  }
  const empty = await run([[]]); assert.equal(empty.status, 'catalog-review-candidates');
  assert.equal(empty.inRangeRows, 0); assert.deepEqual(empty.productCandidates, []); assert.deepEqual(empty.paymentCandidates, []);
});
