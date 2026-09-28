'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inspectText, reviewText } = require('../../lib/sales-sync/catalog-text');
const { diagnoseCatalogText, textDiagnosticCollector } = require('../../lib/sales-sync/catalog-text-diagnostic');
const { exportCatalogReview } = require('../../lib/sales-sync/catalog-review');
const { createReviewedCatalog } = require('../../lib/sales-db/facts');
const { main, parseArgs } = require('../../scripts/sales-backfill');
const start = '2025-01-01', end = '2025-02-01';
const options = { storeSlug: 'norrebro', companyId: '12345', start, end };
const reviewed = { products: [], payments: [] };
const CANARY = ['SYNTHETIC', 'PRIVATE', 'IMPORTER', 'CANARY'].join('_');
const row = (extra = {}) => ({ firmaid: '12345', timestamp_pay: start, productid: 'synthetic-product',
  productname: 'Synthetic label', productgroupid: 'synthetic-group', productgroup: 'Synthetic group',
  paymenttype: 'Synthetic payment', paymenttypecode: 'mixed 1', ...extra });
const body = (data, extra = {}) => JSON.stringify({ data, current_page: 1, next_page_url: null, ...extra });
const diagnose = (data, extra = {}) => diagnoseCatalogText({ reviewed, options, request: async () => body(data), ...extra });
const fields = [
  ['productid', 'product', 'product-id', 'id'], ['productname', 'product', 'product-label', 'label'],
  ['productgroupid', 'product', 'product-group-id', 'id'], ['productgroup', 'product', 'product-group-label', 'label'],
  ['paymenttype', 'payment', 'payment-type', 'label'], ['paymenttypecode', 'payment', 'payment-type-code', 'code'],
];
const cases = [
  ['line feed', 'a\nb', 'FORBIDDEN_LINE_BREAK'], ['carriage return', 'a\rb', 'FORBIDDEN_LINE_BREAK'],
  ['ANSI escape', '\u001b[31m' + CANARY, 'ANSI_ESCAPE'], ['null control', 'a\u0000b', 'CONTROL_CHARACTER'],
  ['tab control', 'a\tb', 'CONTROL_CHARACTER'], ['C1 control', 'a\u0085b', 'CONTROL_CHARACTER'],
  ['bidi control', 'a\u202eb', 'BIDI_FORMATTING'], ['invisible formatting', 'a\u200bb', 'FORMAT_CONTROL'],
  ['unpaired high surrogate', 'a\ud800b', 'INVALID_UNICODE'], ['unpaired low surrogate', 'a\udc00b', 'INVALID_UNICODE'],
  ['empty text', '', 'EMPTY_TEXT'], ['UTF-16 limit', 'x'.repeat(161), 'LENGTH_LIMIT'],
  ['UTF-8 limit', '界'.repeat(107), 'UTF8_BYTE_LIMIT'], ['table syntax', 'a|b', 'UNSAFE_OUTPUT_SEQUENCE'],
  ['Markdown syntax', '`' + CANARY + '`', 'UNSAFE_OUTPUT_SEQUENCE'], ['HTML syntax', '<' + CANARY + '>', 'UNSAFE_OUTPUT_SEQUENCE'],
  ['Unicode line separator', 'a\u2028b', 'UNSAFE_OUTPUT_SEQUENCE'],
  ['formula equals', '=1+1', 'UNSAFE_OUTPUT_SEQUENCE'], ['formula plus', '+SUM(1,2)', 'UNSAFE_OUTPUT_SEQUENCE'],
  ['formula minus', '-2+1', 'UNSAFE_OUTPUT_SEQUENCE'], ['formula at', '@SUM(1,2)', 'SENSITIVE_PATTERN'],
  ['email', CANARY + '@example.invalid', 'SENSITIVE_PATTERN'], ['obfuscated email', 'synthetic [at] example.invalid', 'SENSITIVE_PATTERN'],
  ['phone', '+45 12 34 56 78', 'SENSITIVE_PATTERN'], ['card-like number', '4111 1111 1111 1111', 'SENSITIVE_PATTERN'],
  ['secret marker', 'Bearer ' + CANARY, 'SENSITIVE_PATTERN'], ['key marker', 'api_key=' + CANARY, 'SENSITIVE_PATTERN'],
  ['hash-like text', 'a'.repeat(64), 'SENSITIVE_PATTERN'], ['GitHub-like token', 'ghp_synthetic', 'SENSITIVE_PATTERN'],
  ['credential URL', 'https://example.invalid/' + CANARY, 'SENSITIVE_PATTERN'], ['PEM marker', '-----BEGIN KEY', 'SENSITIVE_PATTERN'],
  ['personal-data marker', 'customer:' + CANARY, 'SENSITIVE_PATTERN'], ['personal-name pattern', 'Mr. Synthetic Person', 'SENSITIVE_PATTERN'],
  ['embedded transaction object', '{"orderlineid":"' + CANARY + '"}', 'UNSAFE_OUTPUT_SEQUENCE'],
  ['embedded customer object', '{"customer":{"name":"' + CANARY + '"}}', 'UNSAFE_OUTPUT_SEQUENCE'],
  ['unsupported object', { customer: CANARY }, 'UNSUPPORTED_TYPE'], ['unsupported array', [CANARY], 'UNSUPPORTED_TYPE'],
  ['unsupported boolean', false, 'UNSUPPORTED_TYPE'], ['unsupported number', 123, 'UNSUPPORTED_TYPE'],
  ['unsupported null', null, 'UNSUPPORTED_TYPE'], ['unsupported undefined', undefined, 'UNSUPPORTED_TYPE'],
  ['unsupported bigint', 1n, 'UNSUPPORTED_TYPE'], ['unsupported symbol', Symbol(CANARY), 'UNSUPPORTED_TYPE'],
];
for (const [name, value, reason] of cases) {
  test('structural text diagnostic: ' + name, () => {
    const issue = inspectText(value, 'label');
    assert.equal(issue.reason, reason);
    assert.deepEqual(Object.keys(issue), ['reason', 'utf16Length', 'characterLength', 'utf8ByteLength', 'lengthsCapped', 'offendingCharacters', 'charactersTruncated']);
    const serialized = JSON.stringify(issue);
    assert.ok(!serialized.includes(CANARY), 'Source canary must never be serialized');
    assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e]/u.test(serialized));
    assert.ok(!serialized.includes('|') && !serialized.includes('`') && !serialized.includes('<'));
    assert.ok(serialized.length < 1024);
    for (const c of issue.offendingCharacters) {
      assert.match(c.codePoint, /^U\+[A-F0-9]{4,6}$/);
      assert.match(String.fromCodePoint(parseInt(c.codePoint.slice(2), 16)), /[\p{Cc}\p{Cf}\p{Cs}]/u);
    }
  });
}
test('field roles and candidate kinds cover every existing catalogue-text rejection path', () => {
  for (const [key, candidateKind, fieldRole, kind] of fields) {
    for (const value of [false, '', 'x'.repeat(kind === 'label' ? 161 : 65), 'bad\nvalue', 'customer:' + CANARY]) {
      const collector = textDiagnosticCollector(); collector.row(row({ [key]: value }));
      const result = collector.finish(); assert.equal(result.rejectedFields, 1);
      assert.equal(result.diagnostics[0].candidateKind, candidateKind); assert.equal(result.diagnostics[0].fieldRole, fieldRole);
      assert.throws(() => reviewText(value, kind), { code: 'CATALOG_TEXT_REVIEW' });
    }
  }
  assert.equal(inspectText('bad/id', 'id').reason, 'INVALID_IDENTIFIER');
  assert.equal(inspectText('bad/code', 'code').reason, 'INVALID_PAYMENT_CODE');
  for (const [key, reason] of [['productid', 'INVALID_IDENTIFIER'], ['productgroupid', 'INVALID_IDENTIFIER'], ['paymenttypecode', 'INVALID_PAYMENT_CODE']]) {
    const c = textDiagnosticCollector(); c.row(row({ [key]: 'bad/value' })); assert.equal(c.finish().diagnostics[0].reason, reason);
  }
});
test('lengths and positions are bounded, explicit, Unicode-safe and never encode content characters', () => {
  const r = inspectText('ø😀\næ\u202eå\t\u001b\u0085');
  assert.equal(r.utf16Length, 10); assert.equal(r.characterLength, 9); assert.equal(r.utf8ByteLength, 18);
  assert.deepEqual(r.offendingCharacters, [{ position: 3, codePoint: 'U+000A' }, { position: 5, codePoint: 'U+202E' },
    { position: 7, codePoint: 'U+0009' }, { position: 8, codePoint: 'U+001B' }]);
  assert.equal(r.charactersTruncated, true);
  const broken = inspectText('\ud800'); assert.equal(broken.utf8ByteLength, null); assert.equal(broken.characterLength, 1);
  const huge = inspectText('a'.repeat(65535) + '😀' + CANARY);
  assert.equal(huge.reason, 'LENGTH_LIMIT'); assert.equal(huge.lengthsCapped, true); assert.equal(huge.utf16Length, 65535);
  assert.deepEqual(inspectText('customer:' + CANARY).offendingCharacters, []);
});
test('no arbitrary keys, IDs, values or coercion hooks are read', () => {
  const item = row({ productname: { toString() { assert.fail('No coercion'); }, customer: CANARY } });
  for (const key of ['orderlineid', 'orderid', 'transaction', 'customer', 'card', 'clerk', 'headers', 'token', 'sourceKey', 'fingerprint', 'identityKey', 'databaseUrl']) {
    Object.defineProperty(item, key, { get() { assert.fail('Prohibited source access'); } });
  }
  const c = textDiagnosticCollector(); c.row(item);
  const text = JSON.stringify(c.finish()); assert.ok(!text.includes(CANARY)); assert.ok(!text.includes('synthetic-product'));
  assert.equal(c.finish().diagnostics[0].reason, 'UNSUPPORTED_TYPE');
});
test('multiple rejected fields aggregate deterministically with fixed caps and exact retained counts', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => row({ productname: 'x'.repeat(170 + i), paymenttype: 'bad\nvalue' }));
  rows.push(rows[0], rows[0]);
  const a = await diagnose(rows), b = await diagnose([...rows].reverse()); assert.deepEqual(a, b);
  assert.equal(a.rejectedRows, 32); assert.equal(a.rejectedFields, 64); assert.equal(a.diagnostics.length, 12);
  assert.equal(a.diagnosticsTruncated, true); assert.equal(a.omittedFields + a.diagnostics.reduce((n, d) => n + d.occurrences, 0), 64);
  assert.equal(a.diagnostics.find(d => d.fieldRole === 'payment-type').occurrences, 32);
  assert.ok(Buffer.byteLength(JSON.stringify(a)) < 16384); assert.equal(a.status, 'incomplete'); assert.equal(a.code, 'CATALOG_TEXT_REVIEW');
  assert.throws(() => createReviewedCatalog(a)); assert.ok(!Object.hasOwn(a, 'products') && !Object.hasOwn(a, 'payments'));
  assert.deepEqual(Object.keys(a.diagnostics[0]), ['candidateKind','fieldRole','reason','utf16Length','characterLength','utf8ByteLength','lengthsCapped','offendingCharacters','charactersTruncated','occurrences']);
});
test('Danish text, punctuation and trailing spaces remain exact in normal export; explicit diagnostic emits no labels', async () => {
  const label = '+ øæå ØÆÅ (10 kr), 0,0% - side. ';
  assert.equal(reviewText(label), label); assert.equal(inspectText(label), null);
  assert.equal(inspectText('ø'.repeat(160)), null);
  const data = [row({ productname: label, productgroupid: null, productgroup: null })];
  const normal = await exportCatalogReview({ reviewed, options, request: async () => body(data) });
  assert.equal(JSON.stringify(normal), JSON.stringify({ status: 'catalog-review-candidates', format: 'kk-catalog-review-v1', approvalRequired: true,
    store: 'norrebro', start, end, timezone: 'Europe/Copenhagen', terminal: true, pages: 1, rows: 1, excludedRows: 0, inRangeRows: 1,
    productCandidates: [{ storeSlug: 'norrebro', productId: 'synthetic-product', productLabel: label, groupId: null, groupLabel: null, classification: 'novel', affectedRows: 1 }],
    paymentCandidates: [{ storeSlug: 'norrebro', paymentType: 'Synthetic payment', paymentCode: 'mixed 1', classification: 'novel', affectedRows: 1 }] }));
  const diagnostic = await diagnose(data); assert.equal(diagnostic.status, 'catalog-text-diagnostic'); assert.equal(diagnostic.rejectedFields, 0);
  assert.ok(!JSON.stringify(diagnostic).includes(label)); assert.deepEqual(diagnostic.diagnostics, []);
  // Explicit-only refusals do not change PR #13's ordinary acceptance boundary.
  for (const text of ['a|b', '=1+1', '界'.repeat(107)]) assert.equal(reviewText(text), text);
});
test('same traversal enforces range, store, timestamps, terminal pagination and all-row totals without retries', async () => {
  let calls = 0;
  const request = async url => {
    calls++; const data = calls === 1 ? [row({ timestamp_pay: end, productname: 'customer:' + CANARY })]
      : [row({ productname: 'bad\nvalue' }), row({ timestamp_pay: '2024-12-31', productname: false })];
    return body(data, { current_page: calls, next_page_url: calls === 1 ? url + '?page=2' : null, total: 3 });
  };
  const r = await diagnose(null, { request }); assert.equal(calls, 2); assert.equal(r.pages, 2); assert.equal(r.rows, 3);
  assert.equal(r.inRangeRows, 1); assert.equal(r.excludedRows, 2); assert.equal(r.rejectedRows, 1);
  for (const data of [[row({ firmaid: 'wrong' })], [row({ timestamp_pay: 'bad', datetime: start })]]) await assert.rejects(diagnose(data));
  await assert.rejects(diagnose(null, { request: async () => body([row({ productname: 'bad\nvalue' })], { total: 2 }) }), { code: 'INVALID_PAGE' });
  calls = 0; await assert.rejects(diagnose(null, { request: async () => { calls++; throw Error(CANARY); } }), { code: 'UPSTREAM_FAILED' }); assert.equal(calls, 1);
  await assert.rejects(diagnose(null, { request: async () => '{"data":[]}' }), { code: 'INVALID_PAGE' });
  try { await diagnose(null, { request: async () => { throw Error(CANARY); } }); assert.fail('Expected refusal'); }
  catch (error) { assert.equal(error.message, 'UPSTREAM_FAILED'); assert.ok(!String(error.stack).includes(CANARY)); }
  const signal = AbortSignal.abort(); await assert.rejects(diagnose([], { signal }), { code: 'INTERRUPTED' });
});
async function cliFile(work) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-text-diagnostic-')), file = path.join(dir, 'baseline.json');
  await fs.writeFile(file, JSON.stringify(reviewed));
  const args = ['--store', 'norrebro', '--from', start, '--through', end, '--catalog', file, '--export-catalog-review', '--diagnose-catalog-text'];
  try { return await work(args, file); } finally { await fs.rm(dir, { recursive: true }); }
}
test('CLI fails nonzero with structural-only output and discards context on parser failures', async () => {
  await cliFile(async args => {
    for (const [value, expected] of [['bad\n' + CANARY, 'CATALOG_TEXT_REVIEW'], ['\ud800', 'INVALID_JSON'], ['\u0000', 'INVALID_JSON']]) {
      const output = []; const code = await main(args, { KK_BACKFILL_COMPANY_ID: '12345' }, s => output.push(s), { request: async () => body([row({ productname: value })]) });
      assert.equal(code, 1); assert.equal(output.length, 1); assert.equal(JSON.parse(output[0]).code, expected); assert.ok(!output[0].includes(CANARY));
      if (expected === 'INVALID_JSON') assert.deepEqual(JSON.parse(output[0]), { status: 'incomplete', code: 'INVALID_JSON' });
    }
    const output = []; assert.equal(await main(args, { KK_BACKFILL_COMPANY_ID: '12345' }, s => output.push(s), { request: async () => body([row()]) }), 0);
    assert.equal(JSON.parse(output[0]).status, 'catalog-text-diagnostic');
  });
});
test('isolated CLI loads no database, repository, importer, publisher or identity module and stderr stays empty', async () => {
  await cliFile(async args => {
    const script = `
      const Module=require('node:module'),original=Module._load;
      Module._load=function(id,...rest){if(id==='pg'||/sales-db\\/(?:config|database|repository|identity|migrate)$|sales-sync\\/(?:importer|repository|owner|diagnostic)$/.test(id))throw Error('Forbidden module');return original.call(this,id,...rest);};
      require('node:crypto').createHmac=()=>{throw Error('Forbidden identity');};
      const {main}=require('./scripts/sales-backfill');
      const env=new Proxy({KK_BACKFILL_COMPANY_ID:'12345'},{get(t,k){if(!['KK_BACKFILL_COMPANY_ID','KK_BACKFILL_TOKEN'].includes(k))throw Error('Forbidden configuration');return t[k];}});
      let calls=0;main(${JSON.stringify(args)},env,undefined,{request:async()=>{if(++calls>1)throw Error('No retry');return ${JSON.stringify(body([row({ productname: 'customer:' + CANARY, orderid: CANARY, card: CANARY })]))};}}).then(code=>{process.exitCode=code;});`;
    const p = spawnSync(process.execPath, ['--require', path.resolve('test/sales-sync/network-guard.js'), '-e', script], {
      cwd: path.resolve(__dirname, '../..'), env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 20000, maxBuffer: 32768 });
    assert.equal(p.status, 1); assert.equal(p.stderr, ''); assert.ok(!p.stdout.includes(CANARY));
    const output = JSON.parse(p.stdout); assert.equal(output.code, 'CATALOG_TEXT_REVIEW'); assert.equal(output.diagnostics[0].reason, 'SENSITIVE_PATTERN');
  });
});
test('diagnostic opt-in rejects every write/verification/aggregate-diagnostic combination before requesting', async () => {
  assert.throws(() => parseArgs(['--diagnose-catalog-text']), { code: 'INVALID_OPTIONS' });
  for (const flags of [['--apply'], ['--dry-run'], ['--validate'], ['--diagnose-catalog'], ['--verify-run', 'synthetic'], ['--resume-publication', 'synthetic']]) {
    assert.throws(() => parseArgs(['--export-catalog-review', '--diagnose-catalog-text', ...flags]), { code: 'INVALID_OPTIONS' });
  }
  for (const extra of [{ verificationOf: 'anything' }, { resumePublication: 'anything' }]) {
    await assert.rejects(diagnose([], { options: { ...options, ...extra }, request: () => assert.fail('No request') }), { code: 'INVALID_OPTIONS' });
  }
});

// Keep the explicit safe diagnostic/controller contract in the standard CI suite.
require("./catalog-diagnostic.test");

require('./catalog-encoded.test');
