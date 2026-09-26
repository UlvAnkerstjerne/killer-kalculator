'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLossless } = require('../../lib/sales-sync/parse');
const { traverse } = require('../../lib/sales-sync/traverse');
const { normalizeLine, readLineTime } = require('../../lib/sales-sync/normalize');
const { importHistory, safeReport } = require('../../lib/sales-sync/importer');
const { diagnoseCatalog } = require('../../lib/sales-sync/diagnostic');
const { ImportError } = require('../../lib/sales-sync/errors');
const { units, amount, months } = require('../../lib/sales-sync/checksums');
const { parseArgs, main } = require('../../scripts/sales-backfill');
const { createHttpRequest } = require('../../lib/sales-sync/http');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { publicLine } = require('../../lib/sales-db/facts');
const { context, start, end, initial, CANARY, raw, body, provider, options, config } = require('./helpers');
const sink = () => ({ lines: [], sizes: [], async batch(batch) { this.sizes.push(batch.length); this.lines.push(...batch.map(x => x.line)); }, async progress() {} });
const walk = (request, target = sink(), limits = {}) => traverse({ ...options, context, request, sink: target, ...limits });

test('lossless JSON keeps monetary tokens, signed quantities and large source IDs exact', () => {
  const parsed = parseLossless(body([raw({ orderlineid: '900719925474099312345678901234567890', price: '-12.123456789012345678', priceexclvat: '-8.004', count: '-3.125' })]));
  const line = normalizeLine(parsed.data[0], { ...options, context });
  assert.equal(line.revenueIncl, '-12.123456789012345678'); assert.equal(line.revenueExcl, '-8.004'); assert.equal(line.quantity, '-3.125');
  assert.ok(line.sourceKey.equals(context.identity.protect(options.storeSlug, '900719925474099312345678901234567890')));
  assert.equal(amount(units('0.000000000000000001') + units('-8.004')), '-8.003999999999999999');
});
for (const text of ['{"x":1,"x":2}', '{"__proto__":1}', '{"x":NaN}', '{"x":Infinity}', '[01]', '[1,]', '{"x":1} extra', '{"x":"\\ud800"}', '{"x":"\\u0000"}', '[truefalse]']) {
  test('bounded parser rejects malformed, ambiguous or unsafe JSON', () => assert.throws(() => parseLossless(text), { code: 'INVALID_JSON' }));
}
test('parser enforces bytes, nesting and string limits before ingestion', () => {
  assert.throws(() => parseLossless('{"x":123}', { maxBytes: 5 }), { code: 'PAGE_TOO_LARGE' });
  assert.throws(() => parseLossless('['.repeat(18) + '0' + ']'.repeat(18)), { code: 'INVALID_JSON' });
  assert.throws(() => parseLossless(JSON.stringify('x'.repeat(65537))), { code: 'INVALID_JSON' });
  assert.equal(parseLossless('{"x":1.2e3}').x, '1.2e3');
});
for (const value of ['1e2', 'NaN', 'Infinity', '0.0000000000000000001', '100000000000000000000', '01', null, 1]) {
  test('ingestion rejects unsupported exact amount without rounding or Number coercion', () => {
    assert.throws(() => normalizeLine(raw({ price: value }), { ...options, context }), { code: 'INVALID_LINE' });
  });
}
test('quantity greater than one never multiplies line revenue or recomputes VAT', () => {
  const line = normalizeLine(raw({ count: '3', price: '10.111', priceexclvat: '7.004' }), { ...options, context });
  assert.equal(line.revenueIncl, '10.111'); assert.equal(line.revenueExcl, '7.004');
});
test('terminal multi-page traversal includes older lines on later pages without date early exit', async () => {
  const mock = provider([[raw({ timestamp_pay: '2025-03-10 12:00:00' })], [raw({ orderlineid: 'synthetic-older' })]]);
  const output = await importHistory({ config, context, options, request: mock.request });
  assert.equal(mock.calls.length, 2); assert.equal(output.lineCount, 1); assert.equal(output.revenueExcl, '8');
});
for (const page of [{}, { data: null, current_page: 1, next_page_url: null }, { data: {}, current_page: 1, next_page_url: null },
  { data: [], current_page: 1 }, { data: [], current_page: 2, next_page_url: null },
  { data: [], current_page: 1, next_page_url: null, last_page: 2 }, { data: [], current_page: 1, next_page_url: null, success: false }]) {
  test('malformed successful envelope cannot certify empty history', async () => {
    await assert.rejects(walk(async () => JSON.stringify(page)), { code: 'INVALID_PAGE' });
  });
}
for (const url of ['https://evil.invalid/api/exportSales/v20/1?page=2', initial.replace('https:', 'http:') + '?page=2',
  initial + '/extra?page=2', initial + '?page=2&token=synthetic', initial + '?page=2&page=2',
  initial + '?page=2#fragment', initial + '?page=3', initial + '?page=02', initial.replace('https://', 'https://user@') + '?page=2', '', false]) {
  test('unsafe or stalled continuations fail before another request', async () => {
    let calls = 0;
    await assert.rejects(walk(async () => { calls++; return body([], 1, url); }), { code: 'UNSAFE_CONTINUATION' });
    assert.equal(calls, 1);
  });
}
test('pagination loop and repeated current page fail closed', async () => {
  await assert.rejects(walk(async () => body([], 1, initial)), { code: 'PAGINATION_LOOP' });
  let calls = 0;
  await assert.rejects(walk(async () => ++calls === 1 ? body([], 1, initial + '?page=2') : body([], 1, null)), { code: 'INVALID_PAGE' });
});
test('declared page totals and page sizes must be consistent with terminal traversal', async () => {
  for (const extra of [{ total: 1 }, { total: 0, per_page: 10001 }, { total: 20, per_page: 10, last_page: 1 }]) {
    await assert.rejects(walk(async () => JSON.stringify({ data: [], current_page: 1, next_page_url: null, ...extra })), { code: 'INVALID_PAGE' });
  }
  let page = 0;
  await assert.rejects(walk(async () => JSON.stringify({ data: [], current_page: ++page,
    next_page_url: page === 1 ? initial + '?page=2' : null, total: page })), { code: 'INVALID_PAGE' });
});
test('safety ceilings cannot be mistaken for terminal completion', async () => {
  await assert.rejects(walk(provider([[raw()], [raw()]]).request, sink(), { maxPages: 1 }), { code: 'PAGE_LIMIT' });
  await assert.rejects(walk(provider([[raw(), raw()]]).request, sink(), { maxRows: 1 }), { code: 'ROW_LIMIT' });
});
test('sanitized staging batches stay bounded independent of page length', async () => {
  const target = sink(); await walk(provider([Array.from({ length: 601 }, (_, i) => raw({ orderlineid: 'synthetic-' + i }))]).request, target, { batchSize: 250 });
  assert.deepEqual(target.sizes, [250, 250, 101]);
  assert.equal(target.lines.length, 601); assert.ok(target.lines.every(line => !Object.hasOwn(line, 'orderlineid')));
});
test('unknown reviewed fields quarantine the full scan and emit only aggregate counts', async () => {
  for (const field of ['productname', 'productgroup', 'paymenttype', 'paymenttypecode']) {
    const progress = [], target = sink(); target.progress = value => progress.push(value);
    await assert.rejects(walk(provider([[raw({ [field]: CANARY })]]).request, target), { code: 'CATALOG_REVIEW' });
    assert.equal(target.lines.length, 0); assert.equal(progress[0].reviewCount, 1);
    assert.ok(!JSON.stringify(progress).includes(CANARY), 'progress privacy check');
  }
});
test('private fields never reach sanitized facts, public serialization, fingerprints or reports', () => {
  const base = normalizeLine(raw(), { ...options, context });
  const candidate = normalizeLine(raw({ customer: CANARY, debtor: CANARY, card: CANARY, clerk: CANARY,
    employee: CANARY, orderid: CANARY, account: CANARY, terminal: CANARY, table: CANARY, pax: CANARY,
    headers: { token: CANARY }, responseBody: CANARY }), { ...options, context });
  assert.ok(base.fingerprint.equals(candidate.fingerprint));
  assert.ok(!JSON.stringify(candidate).includes(CANARY));
  assert.ok(!JSON.stringify(publicLine(candidate, context)).includes(CANARY));
  assert.deepEqual(safeReport({ pages: 1, headers: CANARY, sourceKey: CANARY, payload: CANARY }), { pages: 1 });
});
test('same-ID replay ignores private changes and property order but conflicts on safe changes', async () => {
  const duplicate = raw({ customer: CANARY });
  const result = await importHistory({ config, context, options, request: provider([[raw(), duplicate]]).request });
  assert.equal(result.lineCount, 1);
  await assert.rejects(importHistory({ config, context, options, request: provider([[raw(), raw({ price: '11' })]]).request }), { code: 'SOURCE_CONFLICT' });
});
test('distinct IDs preserve identical-looking purchases', async () => {
  const result = await importHistory({ config, context, options, request: provider([[raw(), raw({ orderlineid: 'synthetic-other' })]]).request });
  assert.equal(result.lineCount, 2); assert.equal(result.revenueExcl, '16');
});
test('missing IDs and a mismatched provider store fail safely', () => {
  for (const orderlineid of [undefined, null, '', '01', '-1', 'synthetic invalid id']) {
    assert.throws(() => normalizeLine(raw({ orderlineid }), { ...options, context }), { code: 'INVALID_LINE', message: 'INVALID_LINE' });
  }
  assert.throws(() => normalizeLine(raw({ firmaid: '54321' }), { ...options, context }), { code: 'STORE_MISMATCH' });
});
test('Copenhagen midnight, fallback, date-only, spring gap and autumn ambiguity remain explicit', () => {
  for (const day of ['2025-03-30', '2025-10-26']) {
    assert.equal(normalizeLine(raw({ timestamp_pay: day + ' 00:00:00' }), { ...options, context }).secondOfDay, 0);
  }
  assert.throws(() => normalizeLine(raw({ timestamp_pay: '2025-03-30 02:30:00' }), { ...options, context }), { code: 'INVALID_LINE' });
  assert.equal(normalizeLine(raw({ timestamp_pay: '2025-10-26 02:30:00' }), { ...options, context }).timeQuality, 'payment_ambiguous');
  assert.equal(normalizeLine(raw({ timestamp_pay: null, datetime: '2025-10-26 02:30:00' }), { ...options, context }).timeQuality, 'fallback_ambiguous');
  assert.equal(normalizeLine(raw({ timestamp_pay: '2025-01-10' }), { ...options, context }).timeQuality, 'missing');
  assert.throws(() => normalizeLine(raw({ timestamp_pay: '2025-02-30 12:00:00' }), { ...options, context }));
});
test('upstream private error bodies are replaced with a fixed code', async () => {
  await assert.rejects(walk(async () => { throw new Error(CANARY); }), error => error.code === 'UPSTREAM_FAILED' && !JSON.stringify(error).includes(CANARY));
});
test('dry validation defaults to no database writes even for unreachable DB URL', async () => {
  assert.equal(parseArgs(['--store', 'norrebro', '--from', start]).apply, false);
  const result = await importHistory({ config, context, options, request: provider([[]]).request });
  assert.equal(result.status, 'validated-only'); assert.equal(result.verified, false);
});
test('CLI rejects contradictory, unknown, incomplete and unsafe flags', () => {
  for (const args of [['--apply', '--dry-run'], ['--apply', '--validate'], ['--unknown'], ['--store'], ['--max-pages', '0'], ['--max-rows', '20000001'], ['--batch-size', '501'], ['--apply', '--apply']]) {
    assert.throws(() => parseArgs(args), { code: 'INVALID_OPTIONS' });
  }
});
test('CLI refuses disabled DB or missing identity and never prints caller values', async () => {
  const output = [], args = ['--store', 'norrebro', '--from', start, '--through', end, '--apply'];
  assert.equal(await main(args, {}, line => output.push(line)), 1);
  assert.ok(output[0].includes('DB_DISABLED'));
  assert.equal(await main(args, { KK_SALES_DB_ENABLED: 'true', KK_SALES_DB_URL: 'postgresql://localhost/synthetic', KK_SALES_IDENTITY_KEY_HEX: CANARY }, line => output.push(line)), 1);
  assert.ok(output.at(-1).includes('INVALID_IDENTITY')); assert.ok(!output.join('').includes(CANARY));
});
test('invalid or incomplete traversal never returns a successful validation message', async () => {
  const reports = [];
  await assert.rejects(importHistory({ config, context, options, request: async () => '{}', report: row => reports.push(row) }));
  assert.ok(!reports.some(row => ['published', 'validated-only'].includes(row.status)));
});
test('HTTP transport refuses unsafe targets before attaching credentials', async () => {
  const request = createHttpRequest({ token: 'synthetic-only', companyId: '12345' });
  await assert.rejects(request('https://example.invalid/'), { code: 'UNSAFE_CONTINUATION' });
  await assert.rejects(request(initial, { maxBytes: 999999999 }), { code: 'INVALID_OPTIONS' });
});
for (const [status, bytes, limit, code] of [[429, Buffer.from(CANARY), 100, 'UPSTREAM_RATE_LIMIT'],
  [302, Buffer.from(CANARY), 100, 'UPSTREAM_FAILED'], [200, Buffer.alloc(20), 10, 'PAGE_TOO_LARGE'],
  [200, Buffer.from([0xff]), 100, 'INVALID_JSON']]) {
  test('bounded raw HTTP transport rejects redirects, rate limits, excess bytes and invalid UTF-8 safely', async () => {
    const original = https.get;
    https.get = (url, opts, callback) => {
      const req = new EventEmitter(); req.destroy = () => req.emit('close');
      queueMicrotask(() => {
        const res = new EventEmitter(); res.statusCode = status; res.headers = {};
        res.destroy = () => { res.emit('aborted'); req.emit('close'); };
        callback(res); if (status === 200) { res.emit('data', bytes); res.emit('end'); req.emit('close'); }
      });
      return req;
    };
    try {
      await assert.rejects(createHttpRequest({ token: 'synthetic-only', companyId: '12345' })(initial, { maxBytes: limit }),
        error => error.code === code && !String(error).includes(CANARY));
    } finally { https.get = original; }
  });
}
test('month buckets cover leap/month/year boundaries exactly once', () => {
  assert.deepEqual(months('2024-02-28', '2024-03-02'), [{ start: '2024-02-28', end: '2024-03-01' }, { start: '2024-03-01', end: '2024-03-02' }]);
  assert.deepEqual(months('2024-12-31', '2025-01-02'), [{ start: '2024-12-31', end: '2025-01-01' }, { start: '2025-01-01', end: '2025-01-02' }]);
});

const diagnose = (pages, extra = {}) => diagnoseCatalog({ context, options, request: provider(pages).request, ...extra });
test('diagnostic classifies review fields across inclusive-start/exclusive-end boundaries without early exit', async () => {
  const mock = provider([
    [raw({ timestamp_pay: end + ' 00:00:00', productname: CANARY })],
    [raw({ timestamp_pay: '2024-12-31 23:59:59', paymenttype: CANARY }),
      raw({ timestamp_pay: start + ' 00:00:00', paymenttypecode: CANARY }),
      raw({ productgroup: CANARY, paymenttypecode: CANARY })],
  ]);
  const result = await diagnose(undefined, { request: mock.request });
  assert.equal(mock.calls.length, 2); assert.equal(result.terminal, true);
  assert.equal(result.pages, 2); assert.equal(result.rows, 4); assert.equal(result.reviewCount, 4);
  assert.deepEqual(result.reviews, [
    { interval: 'before', field: 'payment-type', affectedRows: 1 },
    { interval: 'inside', field: 'product', affectedRows: 1 },
    { interval: 'inside', field: 'payment-type-code', affectedRows: 2 },
    { interval: 'after', field: 'product', affectedRows: 1 },
  ]);
  assert.equal(result.verified, false); assert.equal(result.status, 'catalog-diagnostic');
});
test('synthetic 2351-row reproduction diagnoses a late unknown while ordinary import excludes it', async () => {
  const rows = Array.from({ length: 2350 }, (_, i) => raw({ orderlineid: 'synthetic-' + i }));
  rows.push(raw({ orderlineid: 'synthetic-unknown', timestamp_pay: end + ' 12:00:00', productname: CANARY }));
  const result = await diagnose([rows]);
  assert.equal(result.pages, 1); assert.equal(result.rows, 2351); assert.equal(result.reviewCount, 1);
  assert.deepEqual(result.reviews, [{ interval: 'after', field: 'product', affectedRows: 1 }]);
  const imported = await importHistory({ config, context, options, request: provider([rows]).request });
  assert.equal(imported.lineCount, 2350); assert.equal(imported.sanitizedRows, 2350);
});
test('diagnostic returns no values, identities, protected hashes or private payload fields', async () => {
  const item = raw({ orderlineid: CANARY, productname: CANARY, paymenttype: CANARY,
    customer: CANARY, card: CANARY, clerk: CANARY, headers: { token: CANARY } });
  const result = await diagnose([[item]]), text = JSON.stringify(result);
  assert.ok(!text.includes(CANARY), 'diagnostic privacy scan');
  assert.ok(!text.includes(context.identity.protect(options.storeSlug, CANARY).toString('hex')), 'diagnostic protected identity scan');
  assert.deepEqual(Object.keys(result).sort(), ['end', 'pages', 'reviewCount', 'reviews', 'rows', 'start', 'status', 'store', 'terminal', 'timezone', 'verified'].sort());
  assert.ok(result.reviews.every(review => Object.keys(review).join(',') === 'interval,field,affectedRows'));
  assert.throws(() => normalizeLine(item, { ...options, context }), { code: 'CATALOG_REVIEW' });
});
test('diagnostic preserves validated Copenhagen dates, DST ambiguity and primary/fallback rules', async () => {
  for (const [day, endDate, middle] of [['2025-03-30', '2025-03-31', '03:30:00'], ['2025-10-26', '2025-10-27', '02:30:00']]) {
    const result = await diagnose([[
      raw({ timestamp_pay: day + ' 00:00:00', productname: CANARY }),
      raw({ timestamp_pay: null, datetime: day + ' ' + middle, productname: CANARY }),
      raw({ timestamp_pay: day, productname: CANARY }),
      raw({ timestamp_pay: endDate + ' 00:00:00', productname: CANARY }),
    ]], { options: { ...options, start: day, end: endDate } });
    assert.deepEqual(result.reviews, [{ interval: 'inside', field: 'product', affectedRows: 3 },
      { interval: 'after', field: 'product', affectedRows: 1 }]);
  }
});
test('diagnostic fails closed on malformed rows even before or after the requested dates', async () => {
  for (const override of [
    { timestamp_pay: undefined, datetime: undefined }, { timestamp_pay: null, datetime: null },
    { timestamp_pay: '2025-02-30 12:00:00' }, { timestamp_pay: '2025-03-30 02:30:00' },
    { timestamp_pay: '2024-12-31 24:00:00' }, { timestamp_pay: CANARY, datetime: start + ' 00:00:00' },
    { timestamp_pay: '2025-02-01T00:00:00Z' }, { orderlineid: null }, { price: '1e3' },
    { productname: null }, { productgroup: '\n' }, { paymenttypecode: 'bad/code' },
  ]) {
    await assert.rejects(diagnose([[raw({ productname: CANARY, ...override })]]), { code: 'INVALID_LINE' });
  }
  await assert.rejects(diagnose([[raw({ firmaid: '99999', productname: CANARY })]]), { code: 'STORE_MISMATCH' });
});
test('diagnostic requires genuine terminal pagination and consistent declared totals after review candidates', async () => {
  for (const tail of [{}, { data: [], current_page: 2, next_page_url: null, total: 2 },
    { data: [], current_page: 2, next_page_url: null, last_page: 3 },
    { data: [], current_page: 2, next_page_url: initial + '?page=2' }]) {
    let calls = 0;
    await assert.rejects(diagnose(undefined, { request: async () => {
      if (++calls === 1) return body([raw({ productname: CANARY })], 1, initial + '?page=2');
      return JSON.stringify(tail);
    } }));
    assert.equal(calls, 2);
  }
  let calls = 0;
  await assert.rejects(diagnose(undefined, { request: async () => { calls++; throw new ImportError('CATALOG_REVIEW'); } }), { code: 'CATALOG_REVIEW' });
  assert.equal(calls, 1, 'no retries on an upstream failure');
  await assert.rejects(diagnose([[raw({ productname: CANARY })], []], { limits: { maxPages: 1 } }), { code: 'PAGE_LIMIT' });
  await assert.rejects(diagnose([[raw(), raw()]], { limits: { maxRows: 1 } }), { code: 'ROW_LIMIT' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(diagnose([[]], { signal: controller.signal }), { code: 'INTERRUPTED' });
});
test('diagnostic reports reviewed and empty traversals without claiming verification', async () => {
  for (const rows of [[], [raw()]]) {
    const result = await diagnose([rows]);
    assert.equal(result.rows, rows.length); assert.equal(result.reviewCount, 0);
    assert.deepEqual(result.reviews, []); assert.equal(result.verified, false);
    assert.equal(result.status, 'catalog-diagnostic');
  }
});
test('diagnostic CLI is explicit and cannot be combined with publication or verification modes', async () => {
  assert.equal(parseArgs(['--diagnose-catalog']).diagnose, true);
  for (const mode of [['--apply'], ['--validate'], ['--dry-run'], ['--verify-run', 'synthetic'], ['--resume-publication', 'synthetic']]) {
    assert.throws(() => parseArgs(['--diagnose-catalog', ...mode]), { code: 'INVALID_OPTIONS' });
  }
  for (const extra of [{ verificationOf: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' },
    { resumePublication: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }, { end: start }]) {
    let calls = 0;
    await assert.rejects(diagnose(undefined, { options: { ...options, ...extra }, request: async () => { calls++; } }), { code: 'INVALID_OPTIONS' });
    assert.equal(calls, 0);
  }
});

test('ordinary traversal includes exact start and last second, excluding before start and exact end', async () => {
  const target = sink(), progress = [];
  target.progress = value => progress.push(value);
  const times = ['2024-12-31 23:59:59', start + ' 00:00:00', '2025-01-31 23:59:59', end + ' 00:00:00'];
  const result = await walk(provider([times.map((timestamp_pay, i) => raw({ timestamp_pay, orderlineid: 'synthetic-boundary-' + i }))]).request, target);
  assert.equal(result.rows, 4); assert.equal(result.reviewCount, 0); assert.equal(result.terminal, true);
  assert.deepEqual(target.lines.map(line => line.saleLocal), times.slice(1, 3));
  assert.equal(progress[0].sanitizedRows, 2);
});
for (const field of ['productid', 'productname', 'productgroup', 'paymenttype', 'paymenttypecode']) {
  test('unknown ' + field + ' is ignored only outside the interval', async () => {
    const target = sink();
    const outside = ['2024-12-31 23:59:59', end + ' 00:00:00', end + ' 12:00:00'];
    const result = await walk(provider([outside.map(timestamp_pay => raw({ timestamp_pay, [field]: CANARY }))]).request, target);
    assert.equal(result.rows, 3); assert.equal(result.reviewCount, 0); assert.equal(target.lines.length, 0);
    await assert.rejects(walk(provider([[raw({ [field]: CANARY })]]).request), { code: 'CATALOG_REVIEW' });
  });
}
test('time prefilter reads no identity, product, payment or monetary fields', () => {
  const item = { timestamp_pay: end + ' 00:00:00', firmaid: options.companyId };
  for (const key of ['orderlineid', 'productid', 'productname', 'productgroupid', 'productgroup', 'count', 'price', 'priceexclvat', 'paymenttype', 'paymenttypecode']) {
    Object.defineProperty(item, key, { get() { assert.fail('Fact field read before range filtering'); } });
  }
  assert.equal(readLineTime(item, options.companyId).businessDate, end);
});
test('outside rows cannot create identities, consult catalogue or contribute malformed fact values', async () => {
  let identities = 0, reviews = 0;
  const ctx = { identity: { ...context.identity, protect() { identities++; assert.fail('Unexpected identity'); } },
    catalog: { validate() { reviews++; assert.fail('Unexpected catalogue validation'); } } };
  const outside = ['2024-12-31', end].map(timestamp_pay => raw({ timestamp_pay,
    orderlineid: null, productid: null, productname: { private: CANARY }, productgroup: null,
    count: '1e3', price: 'not-money', priceexclvat: null, paymenttype: null, paymenttypecode: 'invalid/code' }));
  const result = await importHistory({ config, context: ctx, options, request: provider([outside]).request,
    limits: { inspectAllDates: true } }); // Diagnostic behaviour cannot leak through import limits.
  assert.equal(identities, 0); assert.equal(reviews, 0);
  assert.equal(result.lineCount, 0); assert.equal(result.sanitizedRows, 0);
  assert.equal(result.revenueIncl, '0'); assert.equal(result.revenueExcl, '0');
});
test('ordinary prefilter fails closed on missing, malformed, invalid calendar and DST-gap times', async () => {
  for (const overrides of [
    { timestamp_pay: undefined, datetime: undefined }, { timestamp_pay: null, datetime: null },
    { timestamp_pay: '', datetime: start + ' 12:00:00' },
    { timestamp_pay: CANARY, datetime: start + ' 12:00:00' },
    { timestamp_pay: '2025-02-30' }, { timestamp_pay: '2024-12-32 12:00:00' },
    { timestamp_pay: '2025-02-30 12:00:00', datetime: start + ' 12:00:00' },
    { timestamp_pay: '2025-03-30 02:30:00' }, { timestamp_pay: '2024-12-31 24:00:00' },
    { timestamp_pay: end + 'T00:00:00Z' },
  ]) await assert.rejects(walk(provider([[raw(overrides)]]).request), { code: 'INVALID_LINE' });
  for (const item of [null, [], 'invalid']) await assert.rejects(walk(provider([[item]]).request), { code: 'INVALID_LINE' });
});
test('ordinary traversal preserves valid fallback, ambiguous autumn time and explicit date-only time', async () => {
  const target = sink();
  await walk(provider([[raw({ timestamp_pay: '2025-10-26 02:30:00' }),
    raw({ orderlineid: 'synthetic-fallback', timestamp_pay: null, datetime: '2025-10-26 02:30:00' }),
    raw({ orderlineid: 'synthetic-missing-time', timestamp_pay: '2025-10-26' })]]).request, target,
  { start: '2025-10-26', end: '2025-10-27' });
  assert.deepEqual(target.lines.map(line => line.timeQuality), ['payment_ambiguous', 'fallback_ambiguous', 'missing']);
  assert.equal(target.lines[2].saleLocal, null); assert.equal(target.lines[2].secondOfDay, null);
});
test('company mismatch fails closed before, inside and after the interval', async () => {
  for (const timestamp_pay of ['2024-12-31', start, end]) {
    await assert.rejects(walk(provider([[raw({ timestamp_pay, firmaid: '99999' })]]).request), { code: 'STORE_MISMATCH' });
  }
});
test('nonchronological pages after an ignored unknown still require terminal proof and all-row totals', async () => {
  const pages = [[raw({ timestamp_pay: end, productname: CANARY }), raw()],
    [raw({ timestamp_pay: start, orderlineid: 'synthetic-retroactive' }), raw({ timestamp_pay: '2024-12-31', paymenttype: CANARY })]];
  for (const total of [4, 2]) {
    let calls = 0;
    const request = async () => {
      const page = ++calls;
      return JSON.stringify({ data: pages[page - 1], current_page: page, next_page_url: page === 1 ? initial + '?page=2' : null,
        last_page: 2, per_page: 2, total });
    };
    if (total === 2) await assert.rejects(walk(request), { code: 'INVALID_PAGE' });
    else {
      const target = sink(), result = await walk(request, target);
      assert.equal(calls, 2); assert.equal(result.pages, 2); assert.equal(result.rows, 4);
      assert.equal(result.reviewCount, 0); assert.equal(target.lines.length, 2);
      assert.deepEqual(target.lines.map(line => line.businessDate), ['2025-01-10', start]);
    }
  }
  let calls = 0;
  await assert.rejects(walk(async () => ++calls === 1 ? body(pages[0], 1, initial + '?page=2') : '{}'), { code: 'INVALID_PAGE' });
  assert.equal(calls, 2);
  await assert.rejects(walk(async () => JSON.stringify({ data: pages[0], current_page: 1, next_page_url: null, total: 1 })), { code: 'INVALID_PAGE' });
});
test('ignored rows still obey row, page, byte, page-size, interruption and pagination-loop limits', async () => {
  const row = raw({ timestamp_pay: end, productname: CANARY });
  await assert.rejects(walk(provider([[row, row]]).request, sink(), { maxRows: 1 }), { code: 'ROW_LIMIT' });
  await assert.rejects(walk(provider([[row], []]).request, sink(), { maxPages: 1 }), { code: 'PAGE_LIMIT' });
  await assert.rejects(walk(provider([[row]]).request, sink(), { maxBytes: 10 }), { code: 'PAGE_TOO_LARGE' });
  await assert.rejects(walk(async () => JSON.stringify({ data: [row, row], current_page: 1, next_page_url: null, per_page: 1 })), { code: 'INVALID_PAGE' });
  await assert.rejects(walk(async () => body([row], 1, initial)), { code: 'PAGINATION_LOOP' });
  const controller = new AbortController();
  await assert.rejects(walk(async () => { controller.abort(); return body([row]); }, sink(), { signal: controller.signal }), { code: 'INTERRUPTED' });
  for (const range of [{ end: undefined }, { end: start }, { start: 'invalid' }]) {
    let calls = 0;
    await assert.rejects(walk(async () => { calls++; }, sink(), range), { code: 'INVALID_OPTIONS' });
    assert.equal(calls, 0);
  }
});
