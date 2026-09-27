'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { createReviewedCatalog, publicLine } = require('../../lib/sales-db/facts');
const { reviewText, reviewProductLabel, inspectText } = require('../../lib/sales-sync/catalog-text');
const { exportCatalogReview } = require('../../lib/sales-sync/catalog-review');
const { normalizeLine } = require('../../lib/sales-sync/normalize');
const { summarize } = require('../../lib/sales-sync/checksums');
const { main } = require('../../scripts/sales-backfill');
const { computeMetrics, KOMBO_IDS } = require('../../lib/product-metrics');
const { line, context: original } = require('../sales-db/helpers');
const { raw, provider, options, start, end, CANARY } = require('./helpers');
const product = { storeSlug: 'norrebro', productId: 'synthetic-product', productLabel: '',
  groupId: 'synthetic-group', groupLabel: 'Synthetic group' };
const payments = [{ paymentType: 'Synthetic payment', paymentCode: 'TEST' }];
const reviewed = { products: [product], payments };
const context = { identity: original.identity, catalog: createReviewedCatalog(reviewed) };
const white = [' ', '\t', '\n', '\r', '\v', '\f', '\u0085', '\u00a0', '\u1680',
  ...Array.from({ length: 11 }, (_, i) => String.fromCodePoint(0x2000 + i)),
  '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff'];

test('only product labels gain exact empty acceptance; nullability and other field contracts remain', () => {
  assert.equal(reviewProductLabel(''), '');
  for (const kind of ['label', 'id', 'code']) assert.throws(() => reviewText('', kind), { code: 'CATALOG_TEXT_REVIEW' });
  for (const field of ['productId', 'groupId', 'groupLabel']) {
    assert.throws(() => createReviewedCatalog({ products: [{ ...product, [field]: '' }], payments }));
  }
  for (const field of ['paymentType', 'paymentCode']) {
    assert.throws(() => createReviewedCatalog({ products: [product], payments: [{ ...payments[0], [field]: '' }] }));
  }
  for (const value of [null, undefined, 0, false, {}, []]) {
    assert.throws(() => reviewProductLabel(value));
    assert.throws(() => createReviewedCatalog({ products: [{ ...product, productLabel: value }], payments }));
  }
  const nullable = { ...product, groupId: null, groupLabel: null };
  assert.doesNotThrow(() => createReviewedCatalog({ products: [nullable], payments: [{ paymentType: 'Synthetic payment', paymentCode: null }] }));
  for (const code of ['mixed 1', ' ']) assert.equal(reviewText(code, 'code'), code);
});
test('all Unicode whitespace-only labels fail while Danish, punctuation and meaningful spaces survive unchanged', () => {
  for (const value of [...white, white.join(''), '  \u00a0 ']) {
    assert.throws(() => reviewProductLabel(value), { code: 'CATALOG_TEXT_REVIEW' });
    for (const field of ['productLabel', 'groupLabel']) {
      assert.throws(() => createReviewedCatalog({ products: [{ ...product, [field]: value }], payments }));
    }
    assert.throws(() => createReviewedCatalog({ products: [product], payments: [{ paymentType: value, paymentCode: 'TEST' }] }));
  }
  for (const value of ['Killer Kebab ', '+ Harissa, a little ', 'Æble, øl & blåbær!', ' internal spaces ', 'ø'.repeat(160)]) {
    assert.equal(reviewProductLabel(value), value);
    const ctx = { identity: original.identity, catalog: createReviewedCatalog({ products: [{ ...product, productLabel: value }], payments }) };
    assert.equal(line({ productLabel: value }, ctx).productLabel, value);
  }
});
test('empty exception leaves nonempty sensitive, control, format and length refusals intact', () => {
  for (const value of ['alice@example.invalid', 'card: synthetic', 'name: Synthetic Person', 'Bearer synthetic',
    'https://example.invalid', 'x'.repeat(161), 'test\u0001', 'test\u200b', 'test\u202e']) {
    assert.throws(() => reviewProductLabel(value), { code: 'CATALOG_TEXT_REVIEW' });
  }
  assert.equal(inspectText('').reason, 'EMPTY_TEXT');
  assert.equal(inspectText('synthetic|label').reason, 'UNSAFE_OUTPUT_SEQUENCE');
  assert.equal(inspectText('\ud800').reason, 'INVALID_UNICODE');
  assert.equal(reviewProductLabel('synthetic|label'), 'synthetic|label', 'stricter diagnostic-only boundary is unchanged');
});
test('review authorization is one exact empty tuple, never another store, product, group or label', () => {
  assert.equal(line({ productLabel: '' }, context).productLabel, '');
  for (const change of [{ storeSlug: 'vesterbro' }, { productId: 'synthetic-other' }, { groupId: 'synthetic-other-group' },
    { groupLabel: 'Other synthetic group' }, { groupId: null }, { groupLabel: null }, { productLabel: 'Synthetic product' }]) {
    assert.throws(() => line({ productLabel: '', ...change }, context), { code: 'UNREVIEWED_CATALOG' });
  }
  assert.throws(() => line({ productLabel: '' }, original), { code: 'UNREVIEWED_CATALOG' });
  assert.throws(() => normalizeLine(raw({ productname: '' }), { ...options, context: original }), { code: 'CATALOG_REVIEW' });
  const fields = { ...line({ productLabel: '' }, context), productId: 'synthetic-other' };
  assert.deepEqual(context.catalog.reviewFields(fields), ['product']);
});
test('v1 empty candidate preserves exact tuple/count and mandatory human review without nonempty equivalence', async () => {
  const result = await exportCatalogReview({ options,
    reviewed: { products: [{ ...product, storeSlug: 'vesterbro', productLabel: 'Synthetic product' }], payments },
    request: provider([[raw({ productname: '' })], [raw({ productname: '' })]]).request });
  assert.equal(result.format, 'kk-catalog-review-v1'); assert.equal(result.approvalRequired, true);
  assert.equal(result.terminal, true); assert.equal(result.pages, 2); assert.equal(result.rows, 2);
  assert.deepEqual(result.productCandidates, [{ ...product, classification: 'novel', affectedRows: 2 }]);
  assert.throws(() => createReviewedCatalog(result));
  assert.throws(() => line({ productLabel: '' }, original), { code: 'UNREVIEWED_CATALOG' });
});
test('empty export remains atomic when a later candidate field is unsafe and cannot admit other empty fields', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-empty-label-'));
  const file = path.join(dir, 'synthetic-reviewed.json'); fs.writeFileSync(file, JSON.stringify(reviewed));
  try {
    for (const field of ['productid', 'productgroupid', 'productgroup', 'paymenttype', 'paymenttypecode']) {
      for (const invalid of ['', 'customer: Synthetic Person']) {
        const output = [];
        const code = await main(['--store', options.storeSlug, '--from', start, '--through', end, '--catalog', file, '--export-catalog-review'],
          { KK_BACKFILL_COMPANY_ID: '12345' }, value => output.push(JSON.parse(value)),
          { request: provider([[raw({ productname: '' }), raw({ productname: '', [field]: invalid })]]).request });
        assert.equal(code, 1);
        assert.deepEqual(output, [{ status: 'incomplete', code: 'CATALOG_TEXT_REVIEW', redacted: true }]);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('empty review CLI runs with database, importer and identity modules forbidden', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-empty-cli-'));
  const file = path.join(dir, 'synthetic-reviewed.json'); fs.writeFileSync(file, JSON.stringify(reviewed));
  try {
    const script = `
      const assert = require('node:assert/strict');
      const Module = require('node:module'), original = Module._load;
      Module._load = function(id, ...rest) {
        if (id === 'pg' || /sales-db\\/(?:config|database|repository|identity|migrate)$|sales-sync\\/(?:importer|repository|owner|diagnostic)$/.test(id)) throw Error('Forbidden module');
        return original.call(this, id, ...rest);
      };
      require('node:crypto').createHmac = () => { throw Error('Forbidden identity'); };
      const output = [];
      require('./scripts/sales-backfill').main(${JSON.stringify(['--store', options.storeSlug, '--from', start, '--through', end, '--catalog', file, '--export-catalog-review'])},
        { KK_BACKFILL_COMPANY_ID: '12345' }, x => output.push(JSON.parse(x)),
        { request: async () => ${JSON.stringify(JSON.stringify({ data: [raw({ productname: '', orderlineid: null })], current_page: 1, next_page_url: null }))} })
        .then(code => { assert.equal(code, 0); assert.equal(output[0].productCandidates[0].productLabel, ''); })
        .catch(() => { process.exitCode = 1; });`;
    const result = spawnSync(process.execPath, ['--require', path.resolve('test/sales-sync/network-guard.js'), '-e', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('normalization, public projection, fingerprint and content checksum preserve exact empty identity', async () => {
  const ctx = { identity: original.identity, catalog: createReviewedCatalog({ products: [product, { ...product, productLabel: 'Synthetic product' }], payments }) };
  const a = normalizeLine(raw({ productname: '', customer: CANARY, card: CANARY, clerk: CANARY }), { ...options, context: ctx });
  const b = normalizeLine(raw(), { ...options, context: ctx });
  assert.equal(a.productLabel, ''); assert.ok(a.sourceKey.equals(b.sourceKey)); assert.ok(!a.fingerprint.equals(b.fingerprint));
  const sa = await summarize([a], start, end), sb = await summarize([b], start, end);
  assert.equal(sa.total.revenueExcl, sb.total.revenueExcl); assert.ok(!sa.total.digest.equals(sb.total.digest));
  const output = JSON.stringify(publicLine(a, ctx)); assert.equal(JSON.parse(output).productLabel, '');
  for (const key of ['sourceKey', 'sourceLineId', 'fingerprint', 'keyVersion', 'customer', 'card', 'clerk', CANARY]) assert.ok(!output.includes(key));
});
function actualFunction(file, name, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
  const body = source.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
  assert.ok(body, 'actual application function must be found');
  return vm.runInNewContext('(' + body[0] + ')', globals);
}
test('actual API allowlist keeps empty text; actual UI Unknown fallback is presentation only', () => {
  const serialize = actualFunction('server.js', 'sanitiseSalesLine', { cphHourFromLine: () => 12, cphSecondOfDayFromLine: () => 43200 });
  const originalRow = Object.freeze({ ...raw({ productname: '', count: 1, price: 10, priceexclvat: 8 }),
    customer: CANARY, card: CANARY, clerk: CANARY, sourceKey: CANARY, fingerprint: CANARY });
  const api = JSON.parse(JSON.stringify(serialize(originalRow)));
  assert.equal(api.productname, ''); assert.ok(!JSON.stringify(api).includes(CANARY));
  assert.deepEqual(Object.keys(api).sort(), ['productid', 'productname', 'productgroupid', 'productgroup', 'count', 'price', 'priceexclvat', 'paymenttype', 'paymenttypecode', 'date', 'hour', 'secondOfDay'].sort());
  const before = JSON.stringify(api); Object.freeze(api);
  const displayed = actualFunction('index.html', 'buildTopItems')([api]);
  assert.equal(displayed[0].name, 'Unknown'); assert.equal(JSON.stringify(api), before); assert.equal(originalRow.productname, '');
});
test('metric IDs remain authoritative with no category for synthetic unknown empty product', () => {
  const row = { productid: product.productId, productname: '', count: 1, price: 10 };
  assert.deepEqual(computeMetrics([row]), computeMetrics([]));
  assert.deepEqual(computeMetrics([{ ...row, productname: 'Killer Kebab' }]), computeMetrics([]));
  const known = { ...row, productid: [...KOMBO_IDS][0] };
  assert.equal(computeMetrics([known]).komboUnits, 1);
  assert.deepEqual(computeMetrics([known]), computeMetrics([{ ...known, productname: 'Synthetic label' }]));
});
