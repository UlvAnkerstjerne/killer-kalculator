'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { createReviewedCatalog, createSafeLine } = require('../../lib/sales-db/facts');
const { storeId } = require('../../lib/sales-db/values');
const { reviewText, reviewProductLabel } = require('../../lib/sales-sync/catalog-text');
const { normalizeLine } = require('../../lib/sales-sync/normalize');
const { main } = require('../../scripts/sales-backfill');
const metrics = require('../../lib/product-metrics');
const { identity, input } = require('../sales-db/helpers');
const { raw, body, options } = require('./helpers');
const reviewed = require('../../catalogues/onlinepos-reviewed.json');
const provenance = require('../../docs/onlinepos-catalogue-provenance.json');
const catalogPath = path.join(__dirname, '../../catalogues/onlinepos-reviewed.json');
const catalog = createReviewedCatalog(reviewed), context = { identity, catalog };
const productFields = ['storeSlug', 'productId', 'productLabel', 'groupId', 'groupLabel'];
const paymentFields = ['paymentType', 'paymentCode'];
const expectedCounts = {"christianshavn":66,"fisketorvet":67,"frederiksberg":57,"indre-by":55,"norrebro":70,"vesterbro":56};
const key = (p, fields) => JSON.stringify(fields.map(f => p[f]));
const sort = (rows, fields) => [...rows].sort((a, b) => key(a, fields) < key(b, fields) ? -1 : key(a, fields) > key(b, fields) ? 1 : 0);
const sha = text => createHash('sha256').update(text).digest('hex');
const digest = (rows, fields) => sha(JSON.stringify(sort(rows, fields).map(p => fields.map(f => p[f]))));
const line = (product, payment = reviewed.payments[0]) => createSafeLine(input({ ...product, ...payment }), context);
const emptyProduct = { storeSlug: 'frederiksberg', productId: '27241352', productLabel: '', groupId: '2911684', groupLabel: 'Drinks ' };

test('trusted catalogue serialization and approved tuple checksums are deterministic', () => {
  assert.equal(reviewed.products.length, 371); assert.equal(reviewed.payments.length, 9);
  assert.equal(new Set(reviewed.products.map(p => key(p, productFields))).size, 371);
  assert.equal(new Set(reviewed.payments.map(p => key(p, paymentFields))).size, 9);
  assert.deepEqual([...new Set(reviewed.products.map(p => p.storeSlug))].sort(), Object.keys(expectedCounts));
  const canonical = { products: sort([...reviewed.products].reverse(), productFields), payments: sort([...reviewed.payments].reverse(), paymentFields) };
  const text = JSON.stringify(canonical, null, 2) + '\n';
  assert.equal(fs.readFileSync(catalogPath, 'utf8'), text);
  assert.equal(sha(text), provenance.catalogSha256);
  assert.equal(sha(text), '04fb7b8f03bbd962dabc880ead5c6bc7c66f9ee174fe11aa2884389fa0a857e4');
  assert.equal(digest(reviewed.products, productFields), provenance.productsSha256);
  assert.equal(digest(reviewed.payments, paymentFields), provenance.paymentsSha256);
});
for (const [store, expected] of Object.entries(expectedCounts)) {
  test('exact approved tuples load with source checksum and coverage: ' + store, () => {
    const products = reviewed.products.filter(p => p.storeSlug === store);
    const source = provenance.reviewedStores.find(p => p.storeSlug === store);
    assert.equal(products.length, expected); assert.equal(source.productCount, expected);
    assert.equal(digest(products, productFields), source.productsSha256);
    for (const product of products) for (const payment of reviewed.payments) {
      const actual = line(product, payment);
      assert.equal(actual.storeId, storeId(store));
      for (const field of productFields.filter(f => f !== 'storeSlug')) assert.equal(actual[field], product[field]);
      for (const field of paymentFields) assert.equal(actual[field], payment[field]);
    }
  });
}
test('existing explicit CLI file loader accepts the repository catalogue with a local stub only', async () => {
  let requests = 0; const output = [];
  const code = await main(['--store', 'norrebro', '--from', options.start, '--through', options.end,
    '--catalog', catalogPath, '--export-catalog-review'], { KK_BACKFILL_COMPANY_ID: '12345' }, text => output.push(JSON.parse(text)),
  { request: async () => { requests++; return body([]); } });
  assert.equal(code, 0); assert.equal(requests, 1);
  assert.equal(output[0].status, 'catalog-review-candidates');
  assert.equal(output[0].inRangeRows, 0);
});
test('catalogue has only approved identity fields and safe text, with no provider or personal fields', () => {
  assert.deepEqual(Object.keys(reviewed).sort(), ['payments', 'products']);
  for (const p of reviewed.products) {
    assert.deepEqual(Object.keys(p).sort(), [...productFields].sort());
    reviewText(p.productId, 'id'); reviewProductLabel(p.productLabel);
    if (p.groupId !== null) reviewText(p.groupId, 'id');
    if (p.groupLabel !== null) reviewText(p.groupLabel);
  }
  for (const p of reviewed.payments) {
    assert.deepEqual(Object.keys(p).sort(), [...paymentFields].sort());
    reviewText(p.paymentType); if (p.paymentCode !== null) reviewText(p.paymentCode, 'code');
  }
});
test('trailing spaces are exact identities and trimming does not broaden approval', () => {
  let checks = 0;
  for (const p of reviewed.products) for (const field of ['productLabel', 'groupLabel']) {
    if (p[field] !== null && p[field].trim() !== p[field]) {
      assert.equal(line(p)[field], p[field]);
      assert.throws(() => line({ ...p, [field]: p[field].trim() }), { code: 'UNREVIEWED_CATALOG' }); checks++;
    }
  }
  assert.ok(checks > 0);
});
test('only the complete approved Frederiksberg empty product tuple is accepted', () => {
  assert.deepEqual(reviewed.products.filter(p => p.productLabel === ''), [emptyProduct]);
  assert.equal(line(emptyProduct).productLabel, '');
  for (const change of [{ storeSlug: 'norrebro' }, { productId: 'synthetic-other-product' },
    { groupId: 'synthetic-other-group' }, { groupLabel: 'Drinks' }, { groupId: null }, { groupLabel: null }, { productLabel: 'Unknown' }]) {
    assert.throws(() => line({ ...emptyProduct, ...change }), { code: 'UNREVIEWED_CATALOG' });
  }
  const withoutEmpty = createReviewedCatalog({ products: reviewed.products.filter(p => p.productLabel !== ''), payments: reviewed.payments });
  assert.throws(() => createSafeLine(input({ ...emptyProduct, ...reviewed.payments[0] }), { identity, catalog: withoutEmpty }), { code: 'UNREVIEWED_CATALOG' });
});
test('whitespace-only product labels remain invalid even in an explicit reviewed entry', () => {
  for (const productLabel of [' ', '\t', '\r\n', '\u0085', '\u00a0', '\u1680', '\u2000\u200a', '\u2028\u2029', '\u202f', '\u205f', '\u3000', '\ufeff']) {
    assert.throws(() => createReviewedCatalog({ products: [{ ...emptyProduct, productLabel }], payments: reviewed.payments }));
    assert.throws(() => reviewProductLabel(productLabel), { code: 'CATALOG_TEXT_REVIEW' });
  }
});
test('every unknown placeholder remains outside all product metric sets', () => {
  const products = reviewed.products.filter(p => p.productLabel === 'Unknown external product');
  assert.deepEqual([...new Set(products.map(p => p.storeSlug))].sort(), Object.keys(expectedCounts));
  for (const p of products) {
    for (const set of [metrics.KOMBO_IDS, metrics.ROLL_IDS, metrics.LEM_IDS, metrics.BOWL_IDS]) assert.equal(set.has(p.productId), false);
    assert.deepEqual(metrics.computeMetrics([{ productid: p.productId, productname: p.productLabel, count: 1, price: 100 }]), metrics.computeMetrics([]));
  }
});
test('Lover and its observed add-ons remain admitted identities outside lemonade metrics', () => {
  const products = reviewed.products.filter(p => /Lover/.test(p.productLabel));
  assert.ok(products.length > 0);
  for (const p of products) {
    assert.equal(line(p).productLabel, p.productLabel);
    assert.equal(metrics.LEM_IDS.has(p.productId), false);
    assert.equal(metrics.computeMetrics([{ productid: p.productId, productname: p.productLabel, count: 1, price: 100 }]).lemUnits, 0);
  }
});
test('approved Huuray and Splitbetaling remain unattributed in actual application channel logic', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const mapping = html.match(/^const WOLT_VIA_HEAPS = \{[^]*?^};/m);
  const channel = html.match(/^function lineChannel\([^]*?^}/m);
  const kpis = html.match(/^function buildChannelKpis\([^]*?^}/m);
  assert.ok(mapping && channel && kpis);
  const actual = vm.runInNewContext(mapping[0] + '\n' + channel[0] + '\n' + kpis[0] + '\n({lineChannel, buildChannelKpis})');
  for (const payment of [{ paymentType: 'Huuray', paymentCode: 'mixed 11' }, { paymentType: 'Splitbetaling', paymentCode: 'mixed' }]) {
    assert.ok(reviewed.payments.some(p => key(p, paymentFields) === key(payment, paymentFields)));
    for (const store of Object.keys(expectedCounts)) {
      line(reviewed.products.find(p => p.storeSlug === store), payment);
      assert.equal(actual.lineChannel(payment.paymentType, store), null);
      assert.deepEqual(JSON.parse(JSON.stringify(actual.buildChannelKpis([{ paymenttype: payment.paymentType, priceexclvat: 8 }], store))),
        { total: 8, wolt: 0, uberEats: 0, heaps: 0 });
    }
  }
});
test('all 69 Norrebro production identities and seven prior global payments remain exact', () => {
  const addedIds = new Set((provenance.additions || []).filter(a => a.store === 'norrebro').flatMap(a => a.products.map(p => p.productId)));
  const products = reviewed.products.filter(p => p.storeSlug === 'norrebro' && !addedIds.has(p.productId));
  const payments = reviewed.payments.filter(p => !['Huuray', 'Splitbetaling'].includes(p.paymentType));
  const source = provenance.sources.find(p => p.store === 'norrebro');
  assert.equal(source.sourceSha256, 'b9036f5e8ba08e1636d932a4766c85c4df84e2fc6a22c2fdd31923aed1338aa1');
  assert.equal(products.length, 69); assert.equal(payments.length, 7);
  assert.equal(digest(products, productFields), source.productsSha256);
  assert.equal(digest(payments, paymentFields), source.paymentsSha256);
  const previous = { identity, catalog: createReviewedCatalog({ products, payments }) };
  for (const product of products) for (const payment of payments) {
    assert.deepEqual(line(product, payment), createSafeLine(input({ ...product, ...payment }), previous));
  }
});
test('unreviewed or altered product and payment tuples still reach catalogue quarantine errors', () => {
  for (const p of reviewed.products) {
    const item = raw({ productid: p.productId, productname: p.productLabel, productgroupid: p.groupId, productgroup: p.groupLabel,
      paymenttype: reviewed.payments[0].paymentType, paymenttypecode: reviewed.payments[0].paymentCode });
    for (const change of [{ productid: 'synthetic-unreviewed-product' }, { productname: 'Unreviewed label' },
      { productgroupid: 'synthetic-unreviewed-group' }, { productgroup: 'Unreviewed group' },
      { paymenttype: 'Unreviewed payment' }, { paymenttypecode: 'UNREVIEWED' }]) {
      assert.throws(() => normalizeLine({ ...item, ...change }, { ...options, storeSlug: p.storeSlug, context }), { code: 'CATALOG_REVIEW' });
    }
  }
});

test('delegated September 25 product admission remains exact, inert and unclassified', () => {
  const p=reviewed.products.find(p=>p.storeSlug==='norrebro'&&p.productId==='28715749');assert.ok(p);
  assert.equal(Buffer.byteLength(p.productLabel),17);
  assert.equal(sha(Buffer.from(p.productLabel)),'1208e9dc5b4fa497beeb3a294a9c0201d626ca825bcb82adce06fbfd52e4f421');
  const bytes=Buffer.from(p.productLabel);assert.ok(Buffer.from(bytes.toString('base64url'),'base64url').equals(bytes));
  assert.ok(Buffer.from(JSON.parse(JSON.stringify(line(p))).productLabel).equals(bytes));
  assert.equal(metrics.ALL_KNOWN_IDS.has(p.productId),false);
  assert.deepEqual(metrics.computeMetrics([{productid:p.productId,count:1,price:100}]),metrics.computeMetrics([]));
  const html=fs.readFileSync(path.join(__dirname,'../../index.html'),'utf8');
  const esc=vm.runInNewContext(html.match(/^function escHtml\([^]*?^}/m)[0]+'\nescHtml;');
  assert.ok(esc(p.productLabel)===p.productLabel.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));
});

test('delegated Indre By September 21 additions preserve exact inert unclassified values', () => {
  const addition = provenance.additions.find(a => a.store === 'indre-by' && a.start === '2026-09-21');
  assert.equal(addition.products.length, 6);
  for (const entry of addition.products) {
    const p = reviewed.products.find(p => p.storeSlug === 'indre-by' && p.productId === entry.productId);
    assert.ok(p);
    for (const field of productFields.filter(f => f !== 'storeSlug')) {
      if (p[field] === null) { assert.equal(entry.fields[field], null); continue; }
      const bytes = Buffer.from(p[field]);
      assert.equal(bytes.length, entry.fields[field].byteLength);
      assert.equal(sha(bytes), entry.fields[field].sha256);
      assert.ok(Buffer.from(bytes.toString('base64url'), 'base64url').equals(bytes));
      assert.ok(Buffer.from(JSON.parse(JSON.stringify(line(p)))[field]).equals(bytes));
    }
    assert.equal(metrics.ALL_KNOWN_IDS.has(p.productId), false);
    assert.deepEqual(metrics.computeMetrics([{productid:p.productId,count:1,price:100}]),metrics.computeMetrics([]));
  }
});

test('delegated traversal 11 products preserve exact unclassified values', () => {
  const addition = provenance.additions.find(a => a.traversal === 11);
  assert.equal(addition.products.length, 6);
  for (const entry of addition.products) {
    const p = reviewed.products.find(p => p.storeSlug === addition.store && p.productId === entry.productId); assert.ok(p);
    for (const field of productFields.filter(f => f !== 'storeSlug')) {
      if (p[field] === null) { assert.equal(entry.fields[field], null); continue; }
      const bytes = Buffer.from(p[field]); assert.equal(bytes.length, entry.fields[field].byteLength); assert.equal(sha(bytes), entry.fields[field].sha256);
      assert.ok(Buffer.from(bytes.toString('base64url'), 'base64url').equals(bytes)); assert.ok(Buffer.from(JSON.parse(JSON.stringify(line(p)))[field]).equals(bytes));
    }
    assert.equal(metrics.ALL_KNOWN_IDS.has(p.productId), false); assert.deepEqual(metrics.computeMetrics([{productid:p.productId,count:1,price:100}]),metrics.computeMetrics([]));
  }
});

test('delegated traversal 13 products preserve exact unclassified values', () => {
  const addition = provenance.additions.find(a => a.traversal === 13);
  assert.equal(addition.products.length, 8);
  for (const entry of addition.products) {
    const p = reviewed.products.find(p => p.storeSlug === addition.store && p.productId === entry.productId); assert.ok(p);
    for (const field of productFields.filter(f => f !== 'storeSlug')) {
      if (p[field] === null) { assert.equal(entry.fields[field], null); continue; }
      const bytes = Buffer.from(p[field]); assert.equal(bytes.length, entry.fields[field].byteLength); assert.equal(sha(bytes), entry.fields[field].sha256);
      assert.ok(Buffer.from(bytes.toString('base64url'), 'base64url').equals(bytes)); assert.ok(Buffer.from(JSON.parse(JSON.stringify(line(p)))[field]).equals(bytes));
    }
    assert.equal(metrics.ALL_KNOWN_IDS.has(p.productId), false); assert.deepEqual(metrics.computeMetrics([{productid:p.productId,count:1,price:100}]),metrics.computeMetrics([]));
  }
});

test('delegated traversal 15 products preserve exact unclassified values', () => {
  const addition = provenance.additions.find(a => a.traversal === 15);
  assert.equal(addition.products.length, 1);
  for (const entry of addition.products) {
    const p = reviewed.products.find(p => p.storeSlug === addition.store && p.productId === entry.productId); assert.ok(p);
    for (const field of productFields.filter(f => f !== 'storeSlug')) {
      if (p[field] === null) { assert.equal(entry.fields[field], null); continue; }
      const bytes = Buffer.from(p[field]); assert.equal(bytes.length, entry.fields[field].byteLength); assert.equal(sha(bytes), entry.fields[field].sha256);
      assert.ok(Buffer.from(bytes.toString('base64url'), 'base64url').equals(bytes)); assert.ok(Buffer.from(JSON.parse(JSON.stringify(line(p)))[field]).equals(bytes));
    }
    assert.equal(metrics.ALL_KNOWN_IDS.has(p.productId), false); assert.deepEqual(metrics.computeMetrics([{productid:p.productId,count:1,price:100}]),metrics.computeMetrics([]));
  }
});

test('delegated traversal 17 products preserve exact unclassified values', () => {
  const addition = provenance.additions.find(a => a.traversal === 17);
  assert.equal(addition.products.length, 7);
  for (const entry of addition.products) {
    const p = reviewed.products.find(p => p.storeSlug === addition.store && p.productId === entry.productId); assert.ok(p);
    for (const field of productFields.filter(f => f !== 'storeSlug')) {
      if (p[field] === null) { assert.equal(entry.fields[field], null); continue; }
      const bytes = Buffer.from(p[field]); assert.equal(bytes.length, entry.fields[field].byteLength); assert.equal(sha(bytes), entry.fields[field].sha256);
      assert.ok(Buffer.from(bytes.toString('base64url'), 'base64url').equals(bytes)); assert.ok(Buffer.from(JSON.parse(JSON.stringify(line(p)))[field]).equals(bytes));
    }
    assert.equal(metrics.ALL_KNOWN_IDS.has(p.productId), false); assert.deepEqual(metrics.computeMetrics([{productid:p.productId,count:1,price:100}]),metrics.computeMetrics([]));
  }
});

test('delegated traversal 19 products preserve exact unclassified values', () => {
  const addition = provenance.additions.find(a => a.traversal === 19);
  assert.equal(addition.products.length, 3);
  for (const entry of addition.products) {
    const p = reviewed.products.find(p => p.storeSlug === addition.store && p.productId === entry.productId); assert.ok(p);
    for (const field of productFields.filter(f => f !== 'storeSlug')) {
      if (p[field] === null) { assert.equal(entry.fields[field], null); continue; }
      const bytes = Buffer.from(p[field]); assert.equal(bytes.length, entry.fields[field].byteLength); assert.equal(sha(bytes), entry.fields[field].sha256);
      assert.ok(Buffer.from(bytes.toString('base64url'), 'base64url').equals(bytes)); assert.ok(Buffer.from(JSON.parse(JSON.stringify(line(p)))[field]).equals(bytes));
    }
    assert.equal(metrics.ALL_KNOWN_IDS.has(p.productId), false); assert.deepEqual(metrics.computeMetrics([{productid:p.productId,count:1,price:100}]),metrics.computeMetrics([]));
  }
});

test('delegated traversal 21 products preserve exact unclassified values', () => {
  const addition = provenance.additions.find(a => a.traversal === 21);
  assert.equal(addition.products.length, 2);
  for (const entry of addition.products) {
    const p = reviewed.products.find(p => p.storeSlug === addition.store && p.productId === entry.productId); assert.ok(p);
    for (const field of productFields.filter(f => f !== 'storeSlug')) {
      if (p[field] === null) { assert.equal(entry.fields[field], null); continue; }
      const bytes = Buffer.from(p[field]); assert.equal(bytes.length, entry.fields[field].byteLength); assert.equal(sha(bytes), entry.fields[field].sha256);
      assert.ok(Buffer.from(bytes.toString('base64url'), 'base64url').equals(bytes)); assert.ok(Buffer.from(JSON.parse(JSON.stringify(line(p)))[field]).equals(bytes));
    }
    assert.equal(metrics.ALL_KNOWN_IDS.has(p.productId), false); assert.deepEqual(metrics.computeMetrics([{productid:p.productId,count:1,price:100}]),metrics.computeMetrics([]));
  }
});

test('delegated traversal 23 products preserve exact unclassified values', () => {
  const addition = provenance.additions.find(a => a.traversal === 23);
  assert.equal(addition.products.length, 4);
  for (const entry of addition.products) {
    const p = reviewed.products.find(p => p.storeSlug === addition.store && p.productId === entry.productId); assert.ok(p);
    for (const field of productFields.filter(f => f !== 'storeSlug')) {
      if (p[field] === null) { assert.equal(entry.fields[field], null); continue; }
      const bytes = Buffer.from(p[field]); assert.equal(bytes.length, entry.fields[field].byteLength); assert.equal(sha(bytes), entry.fields[field].sha256);
      assert.ok(Buffer.from(bytes.toString('base64url'), 'base64url').equals(bytes)); assert.ok(Buffer.from(JSON.parse(JSON.stringify(line(p)))[field]).equals(bytes));
    }
    assert.equal(metrics.ALL_KNOWN_IDS.has(p.productId), false); assert.deepEqual(metrics.computeMetrics([{productid:p.productId,count:1,price:100}]),metrics.computeMetrics([]));
  }
});

test('delegated traversal 25 products preserve exact unclassified values', () => {
  const addition = provenance.additions.find(a => a.traversal === 25);
  assert.equal(addition.products.length, 5);
  for (const entry of addition.products) {
    const p = reviewed.products.find(p => p.storeSlug === addition.store && p.productId === entry.productId); assert.ok(p);
    for (const field of productFields.filter(f => f !== 'storeSlug')) {
      if (p[field] === null) { assert.equal(entry.fields[field], null); continue; }
      const bytes = Buffer.from(p[field]); assert.equal(bytes.length, entry.fields[field].byteLength); assert.equal(sha(bytes), entry.fields[field].sha256);
      assert.ok(Buffer.from(bytes.toString('base64url'), 'base64url').equals(bytes)); assert.ok(Buffer.from(JSON.parse(JSON.stringify(line(p)))[field]).equals(bytes));
    }
    assert.equal(metrics.ALL_KNOWN_IDS.has(p.productId), false); assert.deepEqual(metrics.computeMetrics([{productid:p.productId,count:1,price:100}]),metrics.computeMetrics([]));
  }
});
