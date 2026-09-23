'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPlandayClient } = require('../lib/planday-client');
const { createPayrollService } = require('../lib/planday-service');
const { fixture } = require('./fixtures/planday.fixture');
const auth = { appId: 'fixture-app', refreshToken: 'fixture-refresh' };
const token = () => ({ data: { access_token: 'fixture-access', expires_in: 3600 } });

test('retrieves every page including a final short page', async () => {
  const offsets = [];
  const c = createPlandayClient({ ...auth, http: { post: async () => token(), get: async (_url, { params }) => {
    offsets.push(params.offset); const n = Math.min(100, 203 - params.offset);
    return { data: { data: Array.from({ length: n }, (_, i) => ({ id: params.offset + i })), paging: { offset: params.offset, total: 203 } } };
  } } });
  assert.equal((await c.all('/scheduling/v1/shifts')).length, 203); assert.deepEqual(offsets, [0, 100, 200]);
});
for (const kind of ['no-total', 'empty-middle', 'changing-total', 'repeated-offset', 'oversize']) test(`pagination fails closed: ${kind}`, async () => {
  const c = createPlandayClient({ ...auth, http: { post: async () => token(), get: async (_url, { params }) => {
    const offset = params.offset; return { data: { data: offset ? [] : [{ id: 'fixture-row' }], paging: {
      offset: kind === 'repeated-offset' ? 0 : offset,
      total: kind === 'no-total' ? undefined : kind === 'oversize' ? 10001 : kind === 'changing-total' && offset ? 3 : 2,
    } } };
  } } });
  await assert.rejects(c.all('/scheduling/v1/shifts'), /PAGINATION_INCOMPLETE/);
});
test('coalesces token refresh and retries expired authorization once', async () => {
  let posts = 0, gets = 0;
  const c = createPlandayClient({ ...auth, http: { post: async () => { posts++; return token(); }, get: async () => {
    gets++; if (gets === 1) throw Object.assign(new Error('fixture-sensitive-error'), { response: { status: 401 } }); return { data: [] };
  } } });
  await Promise.all([c.get('/a'), c.get('/b')]); assert.ok(posts <= 2); assert.equal(gets, 3);
});
test('credentials and upstream errors never enter logs or escaped errors', async () => {
  const lines = [], saved = {};
  for (const k of ['log', 'warn', 'error']) { saved[k] = console[k]; console[k] = (...x) => lines.push(x); }
  try {
    const c = createPlandayClient({ ...auth, http: { post: async () => token(), get: async () => {
      throw Object.assign(new Error('fixture-PII'), { config: { headers: { Authorization: 'fixture-token' } }, response: { data: { employeeId: 'fixture-employee' } } });
    } } });
    await assert.rejects(c.get('/a'), err => err.message === 'UPSTREAM_UNAVAILABLE' && !err.config && !err.response);
    assert.deepEqual(lines, []);
  } finally { for (const k of Object.keys(saved)) console[k] = saved[k]; }
});
function serviceFixture({ now = () => Date.parse('2026-09-24T12:00:00Z'), maxEntries = 64 } = {}) {
  const f = fixture(); let calls = 0, fail = false, pause = null;
  const c = { all: async path => { calls++; if (pause) await pause; if (fail) throw Error('fixture-sensitive'); return path.includes('departments') ? f.departments : f.shifts; },
    get: async (_path, params) => { calls++; if (pause) await pause; if (fail) throw Error('fixture-sensitive'); return params.shiftStatus ? f.approved : f.payroll; } };
  const s = createPayrollService({ client: c, now, maxEntries });
  return { service: s, calls: () => calls, failure: value => { fail = value; }, pause: value => { pause = value; } };
}
const args = { start: '2026-09-22', end: '2026-09-23' };
test('concurrent identical salary requests perform one upstream sequence', async () => {
  const f = serviceFixture(); let release; f.pause(new Promise(r => { release = r; }));
  const a = f.service.get(args), b = f.service.get(args); assert.equal(f.calls(), 4); release();
  const [x, y] = await Promise.all([a, b]); assert.deepEqual(x, y); assert.equal(f.calls(), 4);
});
test('failed and incomplete salary responses are never cached as success', async () => {
  const f = serviceFixture(); f.failure(true);
  assert.equal((await f.service.get(args)).chain.cost, null); await f.service.get(args); assert.equal(f.calls(), 8);
  assert.equal(f.service.sizes().cache, 0); f.failure(false); assert.equal((await f.service.get(args)).chain.cost, 1200);
});
for (const [name, date, range, ttl] of [
  ['historical', '2026-09-24T12:00:00Z', args, 6 * 3600000],
  ['current', '2026-09-22T19:00:00Z', { ...args, cutoff: '2026-09-22T18:00:00Z' }, 10 * 60000],
]) test(`${name} TTL expires on the boundary`, async () => {
  let now = Date.parse(date); const f = serviceFixture({ now: () => now });
  await f.service.get(range); const originalCalls = f.calls(); now += ttl - 1; await f.service.get(range); assert.equal(f.calls(), originalCalls);
  now++; await f.service.get(range); assert.equal(f.calls(), originalCalls + 4);
});
test('payroll LRU is bounded and evicts the oldest range', async () => {
  const f = serviceFixture({ maxEntries: 2 });
  await f.service.get(args); await f.service.get({ start: '2026-09-21', end: '2026-09-23' }); await f.service.get({ start: '2026-09-20', end: '2026-09-23' });
  assert.equal(f.service.sizes().cache, 2); const calls = f.calls(); await f.service.get(args); assert.equal(f.calls(), calls + 4);
});
