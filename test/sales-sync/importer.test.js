'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLossless } = require('../../lib/sales-sync/parse');
const { traverse } = require('../../lib/sales-sync/traverse');
const { normalizeLine } = require('../../lib/sales-sync/normalize');
const { importHistory, safeReport } = require('../../lib/sales-sync/importer');
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
  assert.throws(() => normalizeLine(raw({ orderlineid: undefined }), { ...options, context }), { code: 'INVALID_LINE' });
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
