'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

process.env.NODE_ENV = 'test';
process.env.KK_USERNAME = 'records-test';
process.env.KK_PASSWORD_HASH = bcrypt.hashSync('synthetic-password', 4);
process.env.KK_SESSION_SECRET = 'synthetic-session-only';

let received = null;
let databaseError = null;
require.cache[require.resolve('../lib/sales-read-source')] = { exports: { createSalesReadSource: () => ({
  policy: 'covered-history',
  async records(query, today) {
    if (databaseError) throw databaseError;
    received = { query, today };
    return [{ date: '2026-09-21', weekdayIso: 1, revenueExVat: 600,
      stores: [{ slug: 'norrebro', name: 'Nørrebro', revenueExVat: 100 }] }];
  },
}) } };

const app = require('../server');
let server, url, cookie, csrf;
before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  url = 'http://127.0.0.1:' + server.address().port;
  const response = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'records-test', password: 'synthetic-password' }) });
  const body = await response.json();
  cookie = response.headers.get('set-cookie').split(';')[0];
  csrf = body.csrfToken;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

test('records endpoint requires a session and CSRF token', async () => {
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Best Monday across the chain' }) };
  assert.equal((await fetch(url + '/api/records/query', options)).status, 401);
  assert.equal((await fetch(url + '/api/records/query', { ...options, headers: { ...options.headers, Cookie: cookie } })).status, 403);
});

test('records endpoint returns structured database results', async () => {
  const response = await fetch(url + '/api/records/query', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf },
    body: JSON.stringify({ question: 'Best Monday across the chain' }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.meta.source, 'database');
  assert.equal(body.meta.todayExcluded, true);
  assert.equal(body.results[0].revenueExVat, 600);
  assert.equal(received.query.weekday.iso, 1);
  assert.match(received.today, /^\d{4}-\d{2}-\d{2}$/);
});

test('records endpoint rejects unsupported questions before database access', async () => {
  received = null;
  const response = await fetch(url + '/api/records/query', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf },
    body: JSON.stringify({ question: 'Tell me something interesting' }) });
  assert.equal(response.status, 400);
  assert.equal(received, null);
});

test('records endpoint keeps database failures private', async () => {
  databaseError = new Error('private database diagnostic');
  try {
    const response = await fetch(url + '/api/records/query', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ question: 'Best Monday across the chain' }) });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: 'Records are temporarily unavailable.', code: 'DB_READ_UNAVAILABLE',
    });
  } finally { databaseError = null; }
});
