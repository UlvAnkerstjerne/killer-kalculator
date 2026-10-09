'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRecordsQuestion, queryRecords } = require('../lib/sales-db/records');

test('parses a store record question', () => {
  const result = parseRecordsQuestion('Best day ever in Frederiksberg');
  assert.equal(result.ok, true);
  assert.equal(result.query.scope, 'store');
  assert.equal(result.query.store.slug, 'frederiksberg');
  assert.equal(result.query.weekday, null);
  assert.equal(result.query.limit, 1);
});

test('parses English and Danish chain weekday questions', () => {
  for (const text of ['Best Monday across the chain', 'Bedste mandag i hele kæden']) {
    const result = parseRecordsQuestion(text);
    assert.equal(result.ok, true);
    assert.equal(result.query.scope, 'chain');
    assert.equal(result.query.weekday.iso, 1);
  }
});

test('supports top 1 through 10 and rejects ambiguous questions', () => {
  const top = parseRecordsQuestion('Top 10 Fridays across all stores');
  assert.equal(top.ok, true);
  assert.equal(top.query.limit, 10);
  assert.equal(top.query.weekday.iso, 5);
  assert.equal(parseRecordsQuestion('Top 11 Fridays across all stores').code, 'INVALID_LIMIT');
  assert.equal(parseRecordsQuestion('Best day').code, 'MISSING_SCOPE');
  assert.equal(parseRecordsQuestion('Best day in Nørrebro across the chain').code, 'AMBIGUOUS_SCOPE');
  assert.equal(parseRecordsQuestion('Worst day in Vesterbro').code, 'UNSUPPORTED_QUESTION');
});

test('store records use completed positive days and return a breakdown', async () => {
  const session = { query: async (sql, params) => {
    assert.match(sql, /d\.line_count > 0/);
    assert.match(sql, /d\.business_date < \$2/);
    assert.deepEqual(params, ['frederiksberg', '2026-10-09', null, 1]);
    return { rows: [{ date: '2026-09-12', weekdayIso: 6, revenueExVat: '123456.78' }] };
  } };
  const parsed = parseRecordsQuestion('Best day in Frederiksberg').query;
  const [result] = await queryRecords(session, parsed, '2026-10-09');
  assert.equal(result.revenueExVat, 123456.78);
  assert.deepEqual(result.stores, [{ slug: 'frederiksberg', name: 'Frederiksberg', revenueExVat: 123456.78 }]);
});

test('chain records require all six stores on the same date and preserve breakdowns', async () => {
  const slugs = ['christianshavn','fisketorvet','frederiksberg','indre-by','norrebro','vesterbro'];
  const session = { query: async (sql, params) => {
    assert.match(sql, /HAVING count\(\*\) = 6/);
    assert.deepEqual(params, ['2026-10-09', 1, 1]);
    return { rows: slugs.map((slug, index) => ({ date: '2026-09-21', weekdayIso: 1,
      revenueExVat: '600', slug, storeRevenueExVat: String(50 + index * 20) })) };
  } };
  const parsed = parseRecordsQuestion('Best Monday across the chain').query;
  const [result] = await queryRecords(session, parsed, '2026-10-09');
  assert.equal(result.revenueExVat, 600);
  assert.equal(result.stores.length, 6);
  assert.equal(result.stores.find(store => store.slug === 'norrebro').name, 'Nørrebro');
});

test('records UI and authenticated endpoint remain present', () => {
  const fs = require('node:fs'), path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /data-view="records"/);
  assert.match(html, /Revenue ex VAT/);
  assert.match(server, /app\.post\('\/api\/records\/query', requireAuth, requireCsrf/);
});
