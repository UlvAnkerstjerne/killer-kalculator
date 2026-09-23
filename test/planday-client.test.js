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

test('50-row endpoints use their documented page limit without truncating', async () => {
  const limits = [];
  const c = createPlandayClient({ ...auth, http: { post: async () => token(), get: async (_url, { params }) => {
    limits.push(params.limit); return { data: { data: Array.from({ length: Math.min(50, 73 - params.offset) }, (_, i) => ({ id: params.offset + i })), paging: { offset: params.offset, total: 73 } } };
  } } });
  assert.equal((await c.all('/hr/v1/employees/fixture/history', {}, 50)).length, 73); assert.deepEqual(limits, [50, 50]);
});
const { loadPayrollSources } = require('../lib/planday-service');
const { period } = require('../lib/planday-payroll');
const { addSalary } = require('./fixtures/planday.fixture');
test('Payroll requests split calendar months and keep overnight lookup out of salary dates', async () => {
  const f = fixture(), payrollRanges = [], scheduleRanges = [];
  const c = { all: async (path, params) => { if (path.includes('departments')) return f.departments; scheduleRanges.push(params); return []; },
    get: async (_path, params) => { payrollRanges.push(params); return { ...f.payroll, shiftsPayroll: [] }; } };
  const w = period({ start: '2026-08-31', end: '2026-09-02' }, Date.parse('2026-09-23T12:00Z'));
  await loadPayrollSources({ client: c, window: w });
  assert.deepEqual(scheduleRanges, [{ from: '2026-08-30', to: '2026-09-01' }]);
  assert.deepEqual(payrollRanges.map(x => [x.from, x.to]), [
    ['2026-08-31', '2026-08-31'], ['2026-08-31', '2026-08-31'], ['2026-09-01', '2026-09-01'], ['2026-09-01', '2026-09-01'],
  ]);
});
test('a real overnight shift triggers prior-day payroll without importing prior-day salaries', async () => {
  const f = fixture(), shift = { ...f.shifts[0], date: '2026-09-21', startDateTime: '2026-09-21T23:00', endDateTime: '2026-09-22T01:00' };
  const c = { all: async path => path.includes('departments') ? f.departments : [shift], get: async (_path, params) => {
    if (params.from === '2026-09-21') return { ...f.payroll, salariedPayroll: [{ employeeId: 'fixture-prior-day', salary: 99999 }] };
    return { ...f.payroll, shiftsPayroll: [] };
  } };
  const data = await loadPayrollSources({ client: c, window: period(args, Date.parse('2026-09-24T00:00Z')) });
  assert.equal(data.payroll.shiftsPayroll.length, 1); assert.deepEqual(data.payroll.salariedPayroll, []);
});
test('source loader requests the entire salary month and projects only proven membership', async () => {
  for (const changed of [false, true]) {
    const f = addSalary(fixture()), ranges = [], historyLimits = [];
    const c = { all: async (path, params, limit) => {
      if (path.includes('departments')) return f.departments;
      if (path.endsWith('/history')) { historyLimits.push(limit); return changed ? [{ path: '/departments', modificationDateTime: '2026-09-23' }] : []; }
      ranges.push(params); return f.shifts;
    }, get: async (path, params) => {
      if (path.includes('/allocations/')) return { data: f.allocations.get('fixture-hourly') };
      if (path.includes('/hr/')) return { data: { departments: [149700], hiredFrom: '2020-01-01', dateTimeModified: '2026-09-23T01:00:00Z', firstName: 'fixture-private', email: 'fixture-private' } };
      return params.shiftStatus ? f.approved : f.payroll;
    } };
    const data = await loadPayrollSources({ client: c, window: period(args, Date.parse('2026-09-24T00:00Z')), now: () => Date.parse('2026-09-24T00:00Z') });
    assert.deepEqual(ranges[1], { from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual(historyLimits, [50]); assert.equal(data.memberships.size, changed ? 0 : 1);
    assert.ok(!JSON.stringify([...data.memberships]).includes('fixture-private'));
  }
});
