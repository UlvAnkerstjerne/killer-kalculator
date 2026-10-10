'use strict';
// Included here so the focused loader checks run in the existing regression
// command and CI without changing dependencies or the suite runner.
require('./catalog.test');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { cphMidnightUnix } = require('../../lib/pos-fetcher');
const { validateScope, nextDate, parseArgs, readOptions, readRuntime, loadCatalog } = require('../../lib/sales-worker/config');
const { main } = require('../../scripts/sales-sync');
const { runWorker } = require('../../lib/sales-worker/worker');
const { scope, STORES } = require('./helpers');
const now = () => new Date('2026-10-27T12:00:00.000Z');

for (const [instant, today] of [
  ['2026-03-28T23:30:00Z', '2026-03-29'], ['2026-03-29T22:30:00Z', '2026-03-30'],
  ['2026-10-24T22:30:00Z', '2026-10-25'], ['2026-10-25T23:30:00Z', '2026-10-26'],
  ['2026-09-20T21:59:59Z', '2026-09-20'], ['2026-09-20T22:00:00Z', '2026-09-21'],
]) test('completed Copenhagen date bound at ' + instant, () => {
  const plan = validateScope({ stores: ['norrebro'] }, new Date(instant));
  assert.equal(plan.end, today); assert.equal(plan.maxDays, 1);
  assert.throws(() => validateScope({ stores: ['norrebro'], start: today }, new Date(instant)), { code: 'INVALID_OPTIONS' });
});
for (const [day, hours] of [['2026-03-29', 23], ['2026-10-25', 25]]) test('calendar unit spans the actual DST day: ' + day, () => {
  const end = nextDate(day);
  assert.equal((cphMidnightUnix(end) - cphMidnightUnix(day)) / 3600, hours);
  assert.equal(nextDate('2024-02-28'), '2024-02-29'); assert.equal(nextDate('2024-02-29'), '2024-03-01');
});
test('bounds, canonical store ordering and maximum units are strictly validated', () => {
  assert.deepEqual(validateScope({ ...scope, stores: [...STORES].reverse(), maxDays: 7 }, now()).stores, STORES);
  for (const change of [{ stores: [] }, { stores: ['missing'] }, { stores: ['norrebro', 'norrebro'] },
    { start: '2026-02-30' }, { start: scope.end }, { start: '2026-09-22' },
    { end: '2026-10-28' }, { maxDays: 0 }, { maxDays: 8 }, { maxDays: 1.1 }, { maxDays: '1' }]) {
    assert.throws(() => validateScope({ ...scope, ...change }, now()), { code: 'INVALID_OPTIONS' });
  }
});
test('CLI accepts explicit scope and rejects ambiguous modes and flags', () => {
  const result = readOptions(parseArgs(['--stores', 'vesterbro,norrebro', '--from', scope.start, '--through', scope.end, '--max-days', '2']), {}, now());
  assert.equal(result.apply, false); assert.equal(result.scope.maxDays, 2);
  for (const args of [['--apply', '--dry-run'], ['--plan', '--dry-run'], ['--store', 'norrebro', '--stores', 'vesterbro'],
    ['--from'], ['--unknown'], ['--apply', '--apply'], ['--concurrency', '2']]) assert.throws(() => parseArgs(args), { code: 'INVALID_OPTIONS' });
  for (const value of ['0', '8', '01', '1.0', 'Infinity']) assert.throws(() => readOptions({ '--max-days': value }, {}, now()), { code: 'INVALID_OPTIONS' });
});
test('unset/false activation returns before database or provider configuration is accessed', async () => {
  for (const flag of [undefined, 'false']) {
    const output = [];
    const env = { KK_SALES_SYNC_ENABLED: flag };
    Object.defineProperty(env, 'KK_SALES_DB_URL', { get() { throw new Error('Must not read database configuration'); } });
    assert.equal(await main(['--apply'], env, x => output.push(JSON.parse(x))), 0);
    assert.equal(output[0].status, 'disabled'); assert.equal(output[0].attempted, 0);
  }
});
test('malformed activation and missing credentials fail without transport invocation or secret logging', async () => {
  const env = { KK_SALES_SYNC_ENABLED: 'true', KK_SALES_DB_ENABLED: 'true', KK_SALES_DB_URL: 'postgresql://unused.invalid/test',
    KK_SALES_IDENTITY_KEY_HEX: '07'.repeat(32), KK_SALES_IDENTITY_KEY_VERSION: '1',
    KK_SYNC_TOKEN_NORREBRO: 'synthetic-token' }; // Missing company ID.
  let calls = 0; const output = [];
  assert.equal(await main(['--apply', '--store', 'norrebro', '--from', scope.start], env, x => output.push(x), { now, requestFor: () => { calls++; } }), 1);
  assert.equal(calls, 0); assert.ok(output.every(x => !x.includes('unused.invalid') && !x.includes('synthetic-token')));
  assert.throws(() => readOptions({}, { KK_SALES_SYNC_ENABLED: 'TRUE' }, now()), { code: 'INVALID_CONFIG' });
});
test('all selected credentials validated before access; unrelated credentials never forwarded', () => {
  const env = { KK_SALES_DB_ENABLED: 'true', KK_SALES_DB_URL: 'postgresql://unused.invalid/test',
    KK_SALES_IDENTITY_KEY_HEX: '07'.repeat(32), KK_SALES_IDENTITY_KEY_VERSION: '1',
    KK_SYNC_TOKEN_NORREBRO: 'synthetic-token', KK_SYNC_COMPANY_ID_NORREBRO: '105' };
  for (const key of ['PLANDAY_REFRESH_TOKEN', 'ONLINEPOS_TOKEN_VESTERBRO', 'KK_SYNC_TOKEN_VESTERBRO']) {
    Object.defineProperty(env, key, { get() { throw new Error('Unselected credential read'); } });
  }
  const result = readRuntime({ apply: true, scope }, env);
  assert.deepEqual([...result.credentials.keys()], ['norrebro']);
  assert.deepEqual(Object.keys(result.credentials.get('norrebro')), ['token', 'companyId']);
});
test('plan configuration needs no provider token, identity key or activation', () => {
  assert.deepEqual(Object.keys(readRuntime({ apply: false }, { KK_SALES_DB_ENABLED: 'true', KK_SALES_DB_URL: 'postgresql://unused.invalid/test' })), ['config']);
  assert.equal(typeof loadCatalog().validate, 'function');
});
test('module imports and configuration validation cause zero network requests or database connections', () => {
  const probe = spawnSync(process.execPath, ['-e', `
    const pg = require('pg'); pg.Client.prototype.connect = () => { throw Error('unexpected connection'); };
    for (const mod of ['http', 'https']) for (const key of ['get', 'request']) require(mod)[key] = () => { throw Error('unexpected request'); };
    require('./scripts/sales-sync'); require('./lib/sales-worker/worker');
    require('./lib/sales-worker/config').loadCatalog();
  `], { cwd: require('node:path').join(__dirname, '../..'), encoding: 'utf8' });
  assert.equal(probe.status, 0);
});
test('pre-fetch interruption and invalid library credentials never invoke provider', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const result = await runWorker({ options: { apply: true, enabled: true, scope }, signal: controller.signal, now, requestFor: () => { calls++; } });
  assert.equal(result.code, 'INTERRUPTED'); assert.equal(calls, 0); assert.equal(result.attempted, 0);
});
test('web startup and Railway remain isolated from the dormant worker', () => {
  const server = fs.readFileSync(require('node:path').join(__dirname, '../../server.js'), 'utf8');
  assert.equal(/sales-worker|sales-sync/.test(server), false);
  // Records imports the pure parser from sales-db. Default web startup must
  // still avoid loading PostgreSQL, migrations or any write-capable modules.
  const probe = spawnSync(process.execPath, ['-e', `
    process.env.NODE_ENV = 'test';
    delete process.env.KK_SALES_READ_SOURCE;
    delete process.env.KK_SALES_READ_POLICY;
    const Module = require('node:module'), load = Module._load;
    Module._load = function(id, ...args) {
      if (/^(pg|pg-pool)$/.test(id) || /sales-(worker|sync)/.test(id) ||
          /sales-db\\/(database|migrate|repository|identity|facts)/.test(id)) throw Error('unexpected database/write module');
      return load.call(this, id, ...args);
    };
    require('./server');
  `], { cwd: require('node:path').join(__dirname, '../..'), encoding: 'utf8', timeout: 10000 });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(require('../../package.json').scripts.start, 'node server.js');
  const toml = fs.readFileSync(require('node:path').join(__dirname, '../../railway.toml'), 'utf8');
  assert.match(toml, /startCommand/); assert.match(toml, /node start\.js/);
});
