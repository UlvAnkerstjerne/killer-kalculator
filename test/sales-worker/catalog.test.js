'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { loadCatalog, readRuntime, parseArgs } = require('../../lib/sales-worker/config');
const { main: backfill } = require('../../scripts/sales-backfill');
const { createReviewedCatalog } = require('../../lib/sales-db/facts');
const { storeId, STORES } = require('../../lib/sales-db/values');
const { normalizeLine } = require('../../lib/sales-sync/normalize');
const { identity } = require('../sales-db/helpers');
const { body } = require('../sales-sync/helpers');
const root = path.join(__dirname, '../..');
const cataloguePath = path.join(root, 'catalogues/onlinepos-reviewed.json');
const provenancePath = path.join(root, 'docs/onlinepos-catalogue-provenance.json');
const currentBytes = fs.readFileSync(cataloguePath);
const current = JSON.parse(currentBytes);
const provenance = JSON.parse(fs.readFileSync(provenancePath));
const PRODUCT = ['storeSlug', 'productId', 'productLabel', 'groupId', 'groupLabel'];
const PAYMENT = ['paymentType', 'paymentCode'];
const key = (p, fields) => JSON.stringify(fields.map(f => p[f]));
const sort = (rows, fields) => [...rows].sort((a, b) => key(a, fields) < key(b, fields) ? -1 : key(a, fields) > key(b, fields) ? 1 : 0);
const sha = value => createHash('sha256').update(value).digest('hex');
const digest = (rows, fields) => sha(JSON.stringify(sort(rows, fields).map(p => fields.map(f => p[f]))));
const extra = { storeSlug: 'norrebro', productId: 'synthetic-reviewed-growth', productLabel: 'Synthetic reviewed growth ', groupId: 'synthetic-group', groupLabel: 'Synthetic group ' };
const expanded = () => ({ products: [...structuredClone(current.products), { ...extra }], payments: structuredClone(current.payments) });
// Only a test creates matching provenance. Runtime exposes no such generator.
function fixture(catalogue = expanded()) {
  const canonical = { ...catalogue, products: sort(catalogue.products, PRODUCT), payments: sort(catalogue.payments, PAYMENT) };
  const bytes = Buffer.from(JSON.stringify(canonical, null, 2) + '\n');
  const stores = [...new Set(catalogue.products.map(p => p.storeSlug))].sort();
  return { catalogue: canonical, bytes, provenance: { ...structuredClone(provenance),
    catalogSha256: sha(bytes), productsSha256: digest(catalogue.products, PRODUCT), paymentsSha256: digest(catalogue.payments, PAYMENT),
    counts: { products: catalogue.products.length, payments: catalogue.payments.length, stores: stores.length },
    reviewedStores: stores.map(storeSlug => {
      const products = catalogue.products.filter(p => p.storeSlug === storeSlug);
      return { storeSlug, productCount: products.length, productsSha256: digest(products, PRODUCT) };
    }) } };
}
// Substitute bytes only at the two production-fixed paths. No production API
// accepts test paths/provenance. Sync mocks are restored before the next test.
function withFiles(f, work) {
  const originals = Object.fromEntries(['openSync', 'fstatSync', 'readSync', 'closeSync'].map(k => [k, fs[k]]));
  const values = new Map([[cataloguePath, f.bytes], [provenancePath, Buffer.from(JSON.stringify(f.provenance))]]);
  const handles = new Map(); let next = 1000000;
  fs.openSync = function(file, flags) {
    if (!values.has(file)) return originals.openSync.apply(this, arguments);
    assert.equal(flags, 'r'); const fd = next++; handles.set(fd, values.get(file)); return fd;
  };
  fs.fstatSync = function(fd) { return handles.has(fd) ? { isFile: () => true, size: handles.get(fd).length } : originals.fstatSync.apply(this, arguments); };
  fs.readSync = function(fd, buffer, offset, length, position) { return handles.has(fd) ? handles.get(fd).copy(buffer, offset, position, position + length) : originals.readSync.apply(this, arguments); };
  fs.closeSync = function(fd) { if (!handles.delete(fd)) return originals.closeSync.apply(this, arguments); };
  try { return work(); } finally { Object.assign(fs, originals); assert.equal(handles.size, 0); }
}
const accepts = f => withFiles(f, () => assert.equal(typeof loadCatalog().validate, 'function'));
const rejects = f => withFiles(f, () => assert.throws(() => loadCatalog(), { code: 'INVALID_CATALOG' }));

test('fixed repository catalogue remains byte-identical with 350 products, nine payments and all six stores', () => {
  assert.equal(current.products.length, 350); assert.equal(current.payments.length, 9);
  assert.equal(sha(currentBytes), '22d5d68adabf988eb8f388c7ba6f7b9e3be1333404619e2df48702d986041f9a');
  assert.deepEqual([...new Set(current.products.map(p => p.storeSlug))].sort(), [...STORES].sort());
  accepts({ bytes: currentBytes, provenance });
});
test('reviewed synthetic larger catalogue loads without a runtime count edit', () => {
  const f = fixture(); assert.equal(f.provenance.counts.products, current.products.length + 1);
  withFiles(f, () => loadCatalog().validate({ ...extra, storeId: storeId(extra.storeSlug), ...current.payments[0] }));
});
test('reviewed future growth is not special-cased to the baseline', () => {
  const c = expanded(); c.products.push({ ...extra, productId: 'synthetic-second-growth' });
  assert.equal(c.products.length, current.products.length + 2); accepts(fixture(c));
});
for (const [name, edit] of [
  ['stale product count', f => { f.provenance.counts.products = current.products.length; }],
  ['stale payment count', f => { f.provenance.counts.payments--; }],
  ['stale store count', f => { f.provenance.counts.stores--; }],
  ['stale byte digest', f => { f.provenance.catalogSha256 = provenance.catalogSha256; }],
  ['stale product digest', f => { f.provenance.productsSha256 = provenance.productsSha256; }],
  ['wrong provenance version', f => { f.provenance.provenanceVersion = 2; }],
  ['missing provenance version', f => { delete f.provenance.provenanceVersion; }],
  ['wrong catalogue version', f => { f.provenance.catalogueVersion = 2; }],
  ['stale per-store count', f => { f.provenance.reviewedStores.find(p => p.storeSlug === 'norrebro').productCount--; }],
  ['stale per-store digest', f => { f.provenance.reviewedStores.find(p => p.storeSlug === 'norrebro').productsSha256 = '0'.repeat(64); }],
  ['missing store provenance', f => { f.provenance.reviewedStores.pop(); }],
  ['provider candidate envelope as provenance', f => { f.provenance = { status: 'catalog-review-candidates', approvalRequired: true, ...f.catalogue }; }],
]) test('rejects ' + name, () => { const f = fixture(); edit(f); rejects(f); });

for (const [name, edit] of [
  ['tuple altered after review', c => { c.products[0].productLabel += ' altered'; }],
  ['whitespace altered after review', c => { c.products.find(p => p.productId === extra.productId).productLabel = extra.productLabel.trim(); }],
  ['product removed after review', c => { c.products.pop(); }],
  ['payment altered after review', c => { c.payments[0].paymentType += ' altered'; }],
]) test('rejects ' + name, () => {
  const f = fixture(); edit(f.catalogue); f.bytes = Buffer.from(JSON.stringify(f.catalogue, null, 2) + '\n'); rejects(f);
});

for (const [name, edit] of [
  ['duplicate product even with recalculated provenance', c => { c.products.push({ ...c.products[0] }); }],
  ['store-product collision even with recalculated provenance', c => { c.products.push({ ...c.products[0], productLabel: 'Different label' }); }],
  ['unknown store even with matching counts', c => { c.products[0].storeSlug = 'unknown'; }],
  ['missing required store even with matching counts', c => { c.products = c.products.filter(p => p.storeSlug !== 'vesterbro'); }],
  ['duplicate payment even with recalculated provenance', c => { c.payments.push({ ...c.payments[0] }); }],
  ['whitespace-only label', c => { c.products[0].productLabel = ' '; }],
  ['control character label', c => { c.products[0].productLabel = 'Synthetic\u0001'; }],
  ['extra product field', c => { c.products[0].unreviewed = true; }],
  ['extra payment field', c => { c.payments[0].unreviewed = true; }],
  ['different catalogue schema', c => { c.version = 2; }],
]) test('rejects ' + name, () => { const c = expanded(); edit(c); rejects(fixture(c)); });

test('rejects noncanonical serialization even when byte digest is recalculated', () => {
  const f = fixture(); f.bytes = Buffer.from(JSON.stringify(f.catalogue)); f.provenance.catalogSha256 = sha(f.bytes); rejects(f);
});
test('rejects noncanonical tuple field order even when byte digest is recalculated', () => {
  const f = fixture(); f.catalogue.products[0] = Object.fromEntries(Object.entries(f.catalogue.products[0]).reverse());
  f.bytes = Buffer.from(JSON.stringify(f.catalogue, null, 2) + '\n'); f.provenance.catalogSha256 = sha(f.bytes); rejects(f);
});
test('rejects untrusted syntactically valid growth with current committed provenance', () => {
  const f = fixture(); createReviewedCatalog(f.catalogue); f.provenance = provenance; rejects(f);
});
test('exact Frederiksberg empty-label and trailing whitespace identities remain required', () => {
  const p = { storeSlug: 'frederiksberg', productId: '27241352', productLabel: '', groupId: '2911684', groupLabel: 'Drinks ' };
  const catalog = loadCatalog(), line = { ...p, storeId: storeId(p.storeSlug), ...current.payments[0] };
  catalog.validate(line);
  assert.throws(() => catalog.validate({ ...line, groupLabel: 'Drinks' }), { code: 'UNREVIEWED_CATALOG' });
});
test('environment and call arguments cannot choose an external worker catalogue', () => {
  const names = ['KK_SALES_CATALOG_PATH', 'KK_SALES_CATALOG', 'KK_SALES_CATALOGUE_PATH', 'KK_SALES_CATALOG_PROVENANCE'];
  const prior = names.map(k => process.env[k]);
  try {
    names.forEach(k => { process.env[k] = '/nonexistent/untrusted-catalogue.json'; });
    assert.equal(typeof loadCatalog('/nonexistent/untrusted-catalogue.json').validate, 'function');
    assert.throws(() => parseArgs(['--catalog', '/nonexistent/untrusted-catalogue.json']), { code: 'INVALID_OPTIONS' });
  } finally { names.forEach((k, i) => { if (prior[i] === undefined) delete process.env[k]; else process.env[k] = prior[i]; }); }
});
test('plan-only keeps its credential-free catalogue-independent runtime contract with reviewed growth', () => {
  withFiles(fixture(), () => {
    const runtime = readRuntime({ apply: false }, { KK_SALES_DB_ENABLED: 'true', KK_SALES_DB_URL: 'postgresql://unused.invalid/synthetic' });
    assert.deepEqual(Object.keys(runtime), ['config']);
  });
});
test('apply runtime accepts reviewed growth and rejects untrusted growth before opening a connection', () => {
  const env = { KK_SALES_DB_ENABLED: 'true', KK_SALES_DB_URL: 'postgresql://unused.invalid/synthetic',
    KK_SALES_IDENTITY_KEY_HEX: '07'.repeat(32), KK_SALES_IDENTITY_KEY_VERSION: '1',
    KK_SYNC_TOKEN_NORREBRO: 'synthetic-only', KK_SYNC_COMPANY_ID_NORREBRO: '105' };
  const options = { apply: true, scope: { stores: ['norrebro'] } };
  withFiles(fixture(), () => {
    const r = readRuntime(options, env);
    r.context.catalog.validate({ ...extra, storeId: storeId(extra.storeSlug), ...current.payments[0] });
  });
  const f = fixture(); f.provenance = provenance;
  withFiles(f, () => assert.throws(() => readRuntime(options, env), { code: 'INVALID_CATALOG' }));
});
test('manual importer and verification normalization share exact reviewed growth validation', () => {
  const catalogue = createReviewedCatalog(fixture().catalogue), context = { identity, catalog: catalogue };
  const row = { orderlineid: 'synthetic-growth-line', timestamp_pay: '2026-09-25 12:00:00',
    productid: extra.productId, productname: extra.productLabel, productgroupid: extra.groupId, productgroup: extra.groupLabel,
    count: '1', price: '10', priceexclvat: '8', paymenttype: current.payments[0].paymentType, paymenttypecode: current.payments[0].paymentCode };
  const value = normalizeLine(row, { storeSlug: 'norrebro', companyId: '105', context });
  assert.equal(value.productLabel, extra.productLabel);
  assert.throws(() => normalizeLine({ ...row, productname: extra.productLabel.trim() }, { storeSlug: 'norrebro', companyId: '105', context }), { code: 'CATALOG_REVIEW' });
});
test('manual catalogue exporter still accepts explicit reviewed files using only a synthetic provider', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-catalogue-loader-test-'));
  const file = path.join(directory, 'reviewed.json'); fs.writeFileSync(file, fixture().bytes);
  try {
    const result = []; let requests = 0;
    const code = await backfill(['--store', 'norrebro', '--from', '2026-09-25', '--through', '2026-09-26', '--catalog', file, '--export-catalog-review'],
      { KK_BACKFILL_COMPANY_ID: '105' }, text => result.push(JSON.parse(text)), { request: async () => { requests++; return body([]); } });
    assert.equal(code, 0); assert.equal(requests, 1); assert.equal(result[0].status, 'catalog-review-candidates');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('loading the corrected modules and catalogue performs no provider request or database connection', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const blocked=()=>{throw Error('Unexpected access');};
    require('pg').Client.prototype.connect=blocked;require('pg').Pool.prototype.connect=blocked;
    for(const name of ['http','https']) for(const key of ['get','request']) require(name)[key]=blocked;
    require('./scripts/sales-sync');require('./lib/sales-worker/config').loadCatalog();
  `], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0);
});
