'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../../lib/sales-db/config');
const { createDatabase } = require('../../lib/sales-db/database');
const { createIdentity } = require('../../lib/sales-db/identity');
const { createReviewedCatalog, createSafeLine, validateSafeLine, publicLine } = require('../../lib/sales-db/facts');
const { decimal, date, range, saleTime, identifier, paymentCode } = require('../../lib/sales-db/values');
const { sanitized } = require('../../lib/sales-db/errors');
const { identity, context, input, line } = require('./helpers');

test('immutable migration files match the recovered production checksums', () => {
  const { readFileSync } = require('node:fs');
  const { createHash } = require('node:crypto');
  const path = require('node:path');
  for (const expected of require('./migration-checksums.json')) {
    const bytes = readFileSync(path.join(__dirname, '../../migrations/sales-db', expected.version));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.checksum);
  }
});
test('payment codes preserve reviewed ASCII spaces without widening product identifiers', () => {
  for (const value of ['mixed 1', ' mixed  1 ', 'A_b-9', 'x'.repeat(64)]) assert.equal(paymentCode(value), value);
  assert.throws(() => identifier('mixed 1'), { code: 'INVALID_INPUT' });
  for (const value of ['', 'x'.repeat(65), 'mixed\t1', 'mixed\n1', 'mixed\u00a01', 'mixed/1', 'mixed\0', null, 1]) {
    assert.throws(() => paymentCode(value), { code: 'INVALID_INPUT' });
  }
});
test('spaced payment codes still require exact reviewed catalog membership', () => {
  const product = input();
  const catalog = createReviewedCatalog({
    products: [{ storeSlug: product.storeSlug, productId: product.productId, productLabel: product.productLabel,
      groupId: product.groupId, groupLabel: product.groupLabel }],
    payments: [{ paymentType: product.paymentType, paymentCode: 'mixed 1' }],
  });
  const ctx = { identity, catalog };
  const safe = line({ paymentCode: 'mixed 1' }, ctx);
  assert.equal(publicLine(safe, ctx).paymentCode, 'mixed 1');
  for (const value of ['mixed 2', 'mixed  1', ' mixed 1', 'mixed 1 ']) {
    assert.throws(() => line({ paymentCode: value }, ctx), { code: 'UNREVIEWED_CATALOG' });
  }
});

test('database defaults disabled and ignores unrelated/invalid URL when disabled', () => {
  assert.deepEqual(readConfig({ KK_SALES_DB_URL: 'invalid' }), { enabled: false });
  assert.deepEqual(readConfig({ KK_SALES_DB_ENABLED: 'false' }), { enabled: false });
  assert.throws(() => createDatabase(readConfig({})), { code: 'DB_DISABLED' });
});
for (const env of [{ KK_SALES_DB_ENABLED: 'yes' }, { KK_SALES_DB_ENABLED: 'true' },
  { KK_SALES_DB_ENABLED: 'true', KK_SALES_DB_URL: 'https://example.invalid/db' }]) {
  test('enabled configuration fails closed on invalid input', () => assert.throws(() => readConfig(env), { code: 'INVALID_CONFIG' }));
}
test('explicit optional database configuration accepted', () => {
  assert.equal(readConfig({ KK_SALES_DB_ENABLED: 'true', KK_SALES_DB_URL: 'postgresql://localhost/synthetic_test' }).enabled, true);
});
for (const value of ['NaN', 'Infinity', '-Infinity', '1e2', '0.0000000000000000001', '100000000000000000000', '01', '', null, 1, 0.1]) {
  test('exact decimal rejects unsupported values without coercion or rounding', () => assert.throws(() => decimal(value), { code: 'INVALID_INPUT' }));
}
test('decimal strings preserve signed sub-øre amounts and canonical zero', () => {
  assert.equal(decimal('-12.004000'), '-12.004');
  assert.equal(decimal('99999999999999999999.123456789012345678'), '99999999999999999999.123456789012345678');
  assert.equal(decimal('-0.000'), '0');
});
test('signed line totals never multiply quantity or recompute VAT', () => {
  const value = line({ quantity: '-3', revenueIncl: '-99.111', revenueExcl: '-71.004' });
  assert.equal(value.quantity, '-3'); assert.equal(value.revenueExcl, '-71.004'); assert.equal(value.revenueIncl, '-99.111');
});
for (const value of ['2026-02-29', '2026-04-31', '1999-12-31', '2100-01-01', '2026-9-01']) {
  test('business date rejects malformed or unsupported dates', () => assert.throws(() => date(value)));
}
test('calendar range validates leap days and inclusive/exclusive limits', () => {
  assert.deepEqual(range('2024-02-28', '2024-03-01'), ['2024-02-28', '2024-02-29']);
  assert.throws(() => range('2026-01-02', '2026-01-01'));
  assert.throws(() => range('2024-01-01', '2025-01-02'));
});
for (const day of ['2026-03-29', '2026-10-25']) {
  test('Copenhagen midnight remains on the correct DST-transition date', () => {
    assert.equal(saleTime(day, `${day} 00:00:00`, 'payment').secondOfDay, 0);
  });
}
test('spring DST gap is invalid, autumn repeated hour stays explicitly ambiguous', () => {
  assert.throws(() => saleTime('2026-03-29', '2026-03-29 02:30:00', 'payment'));
  const autumn = saleTime('2026-10-25', '2026-10-25 02:30:00', 'fallback');
  assert.equal(autumn.timeQuality, 'fallback_ambiguous');
  assert.equal(autumn.secondOfDay, 9000); assert.equal(Object.hasOwn(autumn, 'utc'), false);
});
for (const time of ['24:00:00', '23:60:00', '12:00:60']) {
  test('invalid wall-clock time is rejected', () => assert.throws(() => saleTime('2026-09-20', `2026-09-20 ${time}`, 'payment')));
}
test('missing time is distinct from midnight and mismatched dates fail', () => {
  assert.equal(line({ saleLocal: null, timeSource: 'missing' }).secondOfDay, null);
  assert.throws(() => line({ saleLocal: '2026-09-19 12:00:00' }));
});
for (const id of [null, '', 123, '001', ' 1', '1:2']) {
  test('missing/noncanonical source identity fails closed', () => assert.throws(() => identity.protect('norrebro', id)));
}
test('HMAC identity is deterministic, framed, store scoped and key dependent', () => {
  const key = identity.protect('norrebro', '12');
  assert.equal(key.length, 32); assert.ok(key.equals(identity.protect('norrebro', '12')));
  assert.ok(!key.equals(identity.protect('vesterbro', '12')));
  assert.ok(!key.equals(identity.protect('norrebro', '123')));
  const other = createIdentity({ key: Buffer.alloc(32, 8), version: 1 });
  assert.ok(!other.check().equals(identity.check()));
  assert.ok(!other.protect('norrebro', '12').equals(key));
});
test('fingerprints normalize decimals but preserve safe content changes', () => {
  assert.ok(line({ revenueExcl: '8.00' }).fingerprint.equals(line().fingerprint));
  assert.ok(!line({ revenueExcl: '8.001' }).fingerprint.equals(line().fingerprint));
});
const prohibited = ['customer', 'card', 'clerk', 'employee', 'account', 'order', 'orderlineid', 'rawResponse', 'credentials', 'freeText'];
for (const field of prohibited) {
  test(`persistence rejects prohibited ${field} field and sanitized errors hide its canary`, () => {
    const canary = 'SYNTHETIC_PRIVATE_CANARY';
    let error;
    try { createSafeLine(input({ [field]: canary }), context); } catch (caught) { error = caught; }
    assert.equal(error?.code, 'INVALID_INPUT'); assert.ok(!String(error).includes(canary));
    assert.throws(() => validateSafeLine({ ...line(), [field]: canary }, context), { code: 'INVALID_INPUT' });
    assert.throws(() => publicLine({ ...line(), [field]: canary }, context), { code: 'INVALID_INPUT' });
  });
}
test('unreviewed product/group/payment labels cannot enter facts', () => {
  for (const field of ['productLabel', 'groupLabel', 'paymentType']) {
    assert.throws(() => line({ [field]: 'SYNTHETIC_PRIVATE_CANARY' }), { code: 'UNREVIEWED_CATALOG' });
  }
});
test('source identity and fingerprints never enter public serialization', () => {
  const serialized = JSON.stringify(publicLine(line(), context));
  for (const term of ['sourceKey', 'sourceLineId', 'fingerprint', 'synthetic-line-1', 'keyVersion']) assert.ok(!serialized.includes(term));
});
test('unknown driver error messages and causes are never retained', () => {
  const error = sanitized(new Error('SYNTHETIC_PRIVATE_CANARY'));
  assert.equal(error.code, 'DB_OPERATION_FAILED'); assert.equal(error.cause, undefined);
  assert.ok(!JSON.stringify(error).includes('SYNTHETIC_PRIVATE_CANARY'));
});
