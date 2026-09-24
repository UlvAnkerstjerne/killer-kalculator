'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { fixture } = require('./fixtures/planday.fixture');
process.env.NODE_ENV = 'test';
process.env.KK_USERNAME = 'fixture-payroll-user';
process.env.KK_PASSWORD_HASH = bcrypt.hashSync('fixture-payroll-password', 4);
process.env.KK_SESSION_SECRET = 'fixture-payroll-session-secret';
process.env.PLANDAY_APP_ID = 'fixture-payroll-app';
process.env.PLANDAY_REFRESH_TOKEN = 'fixture-payroll-refresh';
let failure = false, gets = 0;
const data = fixture();
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: {
  post: async () => ({ data: { access_token: 'fixture-secret-access', expires_in: 3600 } }),
  get: async (url, { params }) => {
    gets++;
    if (failure) throw Object.assign(new Error('fixture-secret-raw-error'), { response: { status: 403, data: { employeeId: 'fixture-sensitive-employee' } } });
    if (url.endsWith('/departments')) return { data: { data: data.departments, paging: { offset: params.offset, total: data.departments.length } } };
    if (url.endsWith('/punchclockshifts') || url.endsWith('/shifttypes')) return { data: { data: [], paging: { offset: params.offset, total: 0 } } };
    if (url.endsWith('/shifts')) return { data: { data: data.shifts, paging: { offset: params.offset, total: data.shifts.length } } };
    return { data: params.shiftStatus ? data.approved : data.payroll };
  },
} };
const app = require('../server');
let server, base, cookie, csrf;
before(async () => {
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = 'http://127.0.0.1:' + server.address().port;
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'fixture-payroll-user', password: 'fixture-payroll-password' }) });
  cookie = r.headers.get('set-cookie').split(';')[0]; csrf = (await r.json()).csrfToken;
});
after(() => new Promise(resolve => server.close(resolve)));
const get = path => fetch(base + path, { headers: { Cookie: cookie } });
const route = '/api/planday/salaries/2026-09-22/2026-09-23';
test('salary requires the existing session authentication', async () => {
  assert.equal((await fetch(base + route)).status, 401);
});
test('GET needs no CSRF token, and its JSON contains only the aggregate allowlist', async () => {
  const r = await get(route); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  const body = await r.json(); assert.equal(body.chain.cost, 1200);
  assert.deepEqual(Object.keys(body).sort(), ['chain', 'coverage', 'meta', 'period', 'stores', 'warnings']);
  for (const row of Object.values(body.stores)) assert.deepEqual(Object.keys(row).sort(), ['actualHours', 'complete', 'components', 'cost', 'cutoff', 'estimated', 'scheduledFallbackHours', 'scheduledFallbackShifts', 'source', 'warnings']);
  const json = JSON.stringify(body); for (const text of ['employeeId', 'shiftId', 'fixture-', 'wage', 'rate', 'headers', 'Authorization']) assert.ok(!json.includes(text));
});
for (const suffix of ['/garbage/2026-01-02', '/2026-02-30/2026-03-01', '/2026-09-22/2026-09-22', '/2024-01-01/2026-01-01', '/2026-09-22/2026-09-23?store=unknown', '/2026-09-22/2026-09-23?cutoff=garbage', '/2026-09-22/2026-09-23?cutoff=2099-01-01T00:00:00Z', '/2026-09-22/2026-09-23?debug=1']) test(`rejects invalid request before calling Planday: ${suffix}`, async () => {
  const before = gets; assert.equal((await get('/api/planday/salaries' + suffix)).status, 400); assert.equal(gets, before);
});
test('upstream failures stay aggregate, incomplete and sanitized', async () => {
  failure = true;
  try {
    const r = await get('/api/planday/salaries/2026-09-20/2026-09-21'); const body = await r.json();
    assert.equal(body.chain.complete, false); assert.equal(body.chain.cost, null);
    assert.ok(body.warnings.includes('UPSTREAM_UNAVAILABLE')); assert.ok(!JSON.stringify(body).includes('fixture-'));
  } finally { failure = false; }
});
test('existing mutating CSRF rules remain enforced', async () => {
  const r = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } }); assert.equal(r.status, 403);
  const session = await get('/api/auth/session'); assert.equal((await session.json()).csrfToken, csrf);
});
