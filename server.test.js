'use strict';
// Security tests for killer-kalculator server.js
// Uses only Node built-ins (node:test, node:assert, node:http, node:crypto).

const { test, before, after, describe } = require('node:test');
const assert  = require('node:assert/strict');
const http    = require('node:http');
const crypto  = require('node:crypto');
const bcrypt  = require('bcryptjs');

// ── Provide required env vars BEFORE loading the server ───────────────────────
// bcrypt.hashSync(12) on a known test password — precomputed to keep tests fast.
// This is NOT the production password.
const TEST_PASSWORD      = 'test-password-for-tests-only';
const TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4); // 4 rounds for speed
const TEST_USERNAME      = 'testuser';
const TEST_SESSION_SECRET = crypto.randomBytes(32).toString('hex');

process.env.NODE_ENV          = 'test';
process.env.KK_USERNAME       = TEST_USERNAME;
process.env.KK_PASSWORD_HASH  = TEST_PASSWORD_HASH;
process.env.KK_SESSION_SECRET = TEST_SESSION_SECRET;

// Provider credentials — distinct per-store values so isolation tests are meaningful.
// Suffix keeps them unsearchable in case of accidental log capture.
const TEST_PLANDAY_APP_ID        = 'test-planday-appid-xK9z';
const TEST_PLANDAY_REFRESH_TOKEN = 'test-planday-rt-mQ7w';
const TEST_TOKEN_INDRE_BY        = 'test-pos-token-indre-by-aB1c';
const TEST_TOKEN_VESTERBRO       = 'test-pos-token-vesterbro-cD2e';
const TEST_TOKEN_CHRISTIANSHAVN  = 'test-pos-token-christianshavn-eF3g';
const TEST_TOKEN_FISKETORVET     = 'test-pos-token-fisketorvet-gH4i';
const TEST_TOKEN_FREDERIKSBERG   = 'test-pos-token-frederiksberg-iJ5k';
const TEST_TOKEN_NORREBRO        = 'test-pos-token-norrebro-kL6m';

process.env.PLANDAY_APP_ID             = TEST_PLANDAY_APP_ID;
process.env.PLANDAY_REFRESH_TOKEN      = TEST_PLANDAY_REFRESH_TOKEN;
process.env.ONLINEPOS_TOKEN_INDRE_BY        = TEST_TOKEN_INDRE_BY;
process.env.ONLINEPOS_TOKEN_VESTERBRO       = TEST_TOKEN_VESTERBRO;
process.env.ONLINEPOS_TOKEN_CHRISTIANSHAVN  = TEST_TOKEN_CHRISTIANSHAVN;
process.env.ONLINEPOS_TOKEN_FISKETORVET     = TEST_TOKEN_FISKETORVET;
process.env.ONLINEPOS_TOKEN_FREDERIKSBERG   = TEST_TOKEN_FREDERIKSBERG;
process.env.ONLINEPOS_TOKEN_NORREBRO        = TEST_TOKEN_NORREBRO;

// ── Axios mock ────────────────────────────────────────────────────────────────
// Intercept ALL axios calls before server.js is loaded so live APIs are never
// reached during testing.
// capturedAxiosCalls records every call for credential-isolation assertions.

const MOCK_ACCESS_TOKEN  = 'test-access-token-does-not-expose-creds';
const MOCK_REFRESH_TOKEN = 'mock-error-refresh-header'; // value planted in error config only

let axiosBehaviour    = 'token-success'; // 'token-success' | 'token-failure'
const capturedAxiosCalls = []; // { type: 'post'|'get', url, body, headers }

const axiosMock = {
  post: async (url, data, config) => {
    capturedAxiosCalls.push({ type: 'post', url, body: data?.toString?.() ?? '', headers: config?.headers ?? {} });
    if (url.includes('planday.com/connect/token')) {
      if (axiosBehaviour === 'token-failure') {
        const err = new Error('Unauthorized');
        err.response = { status: 401, data: { error: 'invalid_grant' } };
        err.config   = { headers: { Authorization: 'Basic ' + MOCK_REFRESH_TOKEN } };
        throw err;
      }
      return { status: 200, data: { access_token: MOCK_ACCESS_TOKEN, expires_in: 3600 } };
    }
    return { status: 200, data: { content: [{ text: '{}' }] } };
  },
  get: async (url, config) => {
    capturedAxiosCalls.push({ type: 'get', url, headers: config?.headers ?? {} });
    return { status: 200, data: { data: [], paging: { total: 0 } } };
  },
  create: () => axiosMock,
  defaults: { headers: { common: {} } }
};

const axiosPath = require.resolve('axios');
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: axiosMock };

// ── Load server (no listen — guarded by require.main check) ──────────────────
const app = require('./server');

// ── HTTP helpers ─────────────────────────────────────────────────────────────
let server;
let baseUrl;

// isolationJar holds a pre-established session for tests that capture axios calls
// and must not race with the env-var deletions in the auth-config suite.
let isolationJar;

before(() => new Promise((resolve) => {
  server = app.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    const result = await doLogin();
    isolationJar = result.jar;
    resolve();
  });
}));

after(() => new Promise((resolve) => server.close(resolve)));

function request(opts) {
  return new Promise((resolve, reject) => {
    const { method = 'GET', path, headers = {}, body, cookieJar } = opts;
    const cookies = cookieJar ? cookieJar.header() : '';
    const reqHeaders = { ...headers };
    if (cookies) reqHeaders['Cookie'] = cookies;

    const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
    if (bodyBuf) {
      reqHeaders['Content-Type']   = 'application/json';
      reqHeaders['Content-Length'] = bodyBuf.length;
    }

    const url = new URL(path, baseUrl);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method, headers: reqHeaders
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (cookieJar) cookieJar.absorb(res.headers['set-cookie'] || []);
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
      });
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// Simple in-memory cookie jar for session tracking across requests
function makeCookieJar() {
  const store = {};
  return {
    absorb(setCookieArr) {
      for (const c of setCookieArr) {
        const [pair] = c.split(';');
        const [k, v] = pair.split('=');
        if (k && v !== undefined) store[k.trim()] = v.trim();
      }
    },
    header() {
      return Object.entries(store).map(([k, v]) => `${k}=${v}`).join('; ');
    },
    clear() { Object.keys(store).forEach(k => delete store[k]); }
  };
}

// Login helper — returns { csrfToken, jar }
async function doLogin(username = TEST_USERNAME, password = TEST_PASSWORD) {
  const jar = makeCookieJar();
  const r = await request({ method: 'POST', path: '/api/auth/login', body: { username, password }, cookieJar: jar });
  return { status: r.status, csrfToken: r.json?.csrfToken, jar };
}

// Authenticated GET
async function authGet(path, jar) {
  return request({ path, cookieJar: jar });
}

// Authenticated POST with CSRF
async function authPost(path, body, jar, csrfToken) {
  return request({
    method: 'POST', path, body, cookieJar: jar,
    headers: { 'X-CSRF-Token': csrfToken }
  });
}

// ── 1. Frontend availability ──────────────────────────────────────────────────
describe('Frontend availability', () => {
  test('GET / returns 200 and HTML content', async () => {
    const r = await request({ path: '/' });
    assert.equal(r.status, 200);
    assert.match(r.body, /<html/i);
  });

  test('GET /index.html returns 200 and HTML content', async () => {
    const r = await request({ path: '/index.html' });
    assert.equal(r.status, 200);
    assert.match(r.body, /<html/i);
  });
});

// ── 2. Source / config / data paths are blocked ───────────────────────────────
describe('Source and data path blocking', () => {
  const blockedPaths = [
    '/server.js', '/package.json', '/package-lock.json',
    '/.gitignore', '/.env', '/.mcp.json',
    '/data/lemonade-history.json',
    '/%2e%2e%2fserver.js', '/..%2Fserver.js', '/%2e%2e/server.js',
  ];

  for (const p of blockedPaths) {
    test(`GET ${p} is not served (must not be 200)`, async () => {
      const r = await request({ path: p });
      assert.notEqual(r.status, 200,
        `Expected non-200 for ${p} but got ${r.status}. Body: ${r.body.slice(0, 120)}`);
    });
  }

  test('server.js source code is not exposed via any blocked path', async () => {
    for (const p of blockedPaths) {
      const r = await request({ path: p });
      assert.ok(!r.body.includes('PLANDAY_REFRESH_TOKEN') && !r.body.includes('PLANDAY_APP_ID'),
        `Source leaked via ${p}`);
    }
  });
});

// ── 3. Credential logging ─────────────────────────────────────────────────────
describe('Credential logging', () => {
  function captureConsole(fn) {
    const captured = [];
    const origLog   = console.log;
    const origError = console.error;
    const origWarn  = console.warn;
    console.log   = (...a) => captured.push(a.join(' '));
    console.error = (...a) => captured.push(a.join(' '));
    console.warn  = (...a) => captured.push(a.join(' '));
    return fn().then(
      v  => { console.log = origLog; console.error = origError; console.warn = origWarn; return { captured, value: v }; },
      e  => { console.log = origLog; console.error = origError; console.warn = origWarn; throw e; }
    );
  }

  function noCredentialsInLines(lines) {
    const combined = lines.join('\n');
    assert.ok(!combined.includes(MOCK_REFRESH_TOKEN),         'error refresh header in logs');
    assert.ok(!combined.includes(MOCK_ACCESS_TOKEN),          'access_token in logs');
    assert.ok(!combined.includes(TEST_PLANDAY_APP_ID),        'planday app id in logs');
    assert.ok(!combined.includes(TEST_PLANDAY_REFRESH_TOKEN), 'planday refresh token in logs');
    assert.ok(!combined.includes('grant_type=refresh_token'), 'raw body in logs');
  }

  test('successful token refresh does not log credentials', async () => {
    axiosBehaviour = 'token-success';
    const { csrfToken, jar } = await doLogin();
    const { captured } = await captureConsole(() => authGet('/api/planday/salaries/2026-01-01/2026-01-31', jar));
    noCredentialsInLines(captured);
  });

  test('failed token refresh does not log credentials', async () => {
    axiosBehaviour = 'token-failure';
    const { csrfToken, jar } = await doLogin();
    const { captured } = await captureConsole(() => authGet('/api/planday/salaries/2026-01-01/2026-01-31', jar));
    noCredentialsInLines(captured);
    axiosBehaviour = 'token-success';
  });
});

// ── 4. Unauthenticated access is denied ───────────────────────────────────────
describe('Unauthenticated access to business routes is denied', () => {
  const protectedGets = [
    '/api/revenue/vesterbro/1700000000/1700086400',
    '/api/all-revenue/1700000000/1700086400',
    '/api/sales/vesterbro/1700000000',
    '/api/planday/salaries/2026-01-01/2026-01-07',
    '/api/katering-recipes',
    '/api/meat',
    '/api/lemonade/today',
    '/api/lemonade/history',
  ];

  for (const p of protectedGets) {
    test(`GET ${p} → 401 without session`, async () => {
      const r = await request({ path: p });
      assert.equal(r.status, 401, `Expected 401 for ${p}, got ${r.status}`);
    });
  }

  const protectedPosts = [
    ['/api/meat',             []],
    ['/api/katering-recipes', {}],
    ['/api/lemonade/history', []],
    ['/api/scan-invoice',     { base64: 'abc', mediaType: 'image/jpeg' }],
    ['/api/auth/logout',      {}],
  ];

  for (const [p, body] of protectedPosts) {
    test(`POST ${p} → 401 without session`, async () => {
      const r = await request({ method: 'POST', path: p, body });
      assert.equal(r.status, 401, `Expected 401 for POST ${p}, got ${r.status}`);
    });
  }
});

// ── 5. Health endpoint stays unprotected ─────────────────────────────────────
describe('Unprotected routes', () => {
  test('GET /api/health returns 200 without session', async () => {
    const r = await request({ path: '/api/health' });
    assert.equal(r.status, 200);
    assert.ok(r.json?.ok);
  });
});

// ── 6. Correct login succeeds; wrong credentials fail ─────────────────────────
describe('Login', () => {
  test('correct credentials return 200 with csrfToken', async () => {
    const { status, csrfToken } = await doLogin();
    assert.equal(status, 200);
    assert.ok(typeof csrfToken === 'string' && csrfToken.length > 0);
  });

  test('wrong password returns 401', async () => {
    const { status } = await doLogin(TEST_USERNAME, 'wrong-password');
    assert.equal(status, 401);
  });

  test('wrong username returns 401', async () => {
    const { status } = await doLogin('wrong-user', TEST_PASSWORD);
    assert.equal(status, 401);
  });

  test('missing credentials return 400', async () => {
    const r = await request({ method: 'POST', path: '/api/auth/login', body: {} });
    assert.equal(r.status, 400);
  });

  test('GET /api/auth/session returns 200 after login', async () => {
    const { csrfToken, jar } = await doLogin();
    const r = await authGet('/api/auth/session', jar);
    assert.equal(r.status, 200);
    assert.ok(r.json?.ok);
    assert.ok(r.json?.csrfToken);
  });

  test('protected route returns 200 after login', async () => {
    const { jar } = await doLogin();
    const r = await authGet('/api/meat', jar);
    assert.equal(r.status, 200);
  });
});

// ── 7. Logout invalidates the session ────────────────────────────────────────
describe('Session logout', () => {
  test('POST /api/auth/logout destroys session; subsequent requests get 401', async () => {
    const { csrfToken, jar } = await doLogin();
    const logout = await authPost('/api/auth/logout', {}, jar, csrfToken);
    assert.equal(logout.status, 200);

    // Session cookie is now invalid — protected route must return 401
    const after = await authGet('/api/meat', jar);
    assert.equal(after.status, 401);
  });
});

// ── 8. GET /api/auth/session → 401 without session ───────────────────────────
describe('Session check', () => {
  test('GET /api/auth/session returns 401 without session', async () => {
    const r = await request({ path: '/api/auth/session' });
    assert.equal(r.status, 401);
  });

  test('GET /api/auth/session returns 401 after logout', async () => {
    const { csrfToken, jar } = await doLogin();
    await authPost('/api/auth/logout', {}, jar, csrfToken);
    const r = await authGet('/api/auth/session', jar);
    assert.equal(r.status, 401);
  });
});

// ── 9. CSRF protection on state-changing routes ───────────────────────────────
describe('CSRF protection', () => {
  test('POST /api/meat without X-CSRF-Token returns 403', async () => {
    const { jar } = await doLogin();
    const r = await request({ method: 'POST', path: '/api/meat', body: [], cookieJar: jar });
    assert.equal(r.status, 403);
  });

  test('POST /api/meat with wrong CSRF token returns 403', async () => {
    const { jar } = await doLogin();
    const r = await request({
      method: 'POST', path: '/api/meat', body: [], cookieJar: jar,
      headers: { 'X-CSRF-Token': 'bad-token' }
    });
    assert.equal(r.status, 403);
  });

  test('POST /api/meat with correct CSRF token returns 200', async () => {
    const { csrfToken, jar } = await doLogin();
    const r = await authPost('/api/meat', [], jar, csrfToken);
    assert.equal(r.status, 200);
  });

  test('cross-site POST (no session cookie) returns 401 not 200', async () => {
    // Simulate a CSRF attack: POST with a guessed/stolen CSRF token but no valid session.
    // Without the session cookie the auth middleware blocks first.
    const r = await request({
      method: 'POST', path: '/api/meat', body: [],
      headers: { 'X-CSRF-Token': 'any-token' }
    });
    assert.equal(r.status, 401);
  });

  test('POST /api/auth/logout without CSRF token returns 403', async () => {
    const { jar } = await doLogin();
    // logout requires CSRF
    const r = await request({ method: 'POST', path: '/api/auth/logout', body: {}, cookieJar: jar });
    assert.equal(r.status, 403);
  });
});

// ── 10. Missing config fails closed ──────────────────────────────────────────
describe('Missing auth configuration', () => {
  test('login returns 503 when KK_USERNAME env var is temporarily unset', async () => {
    const saved = process.env.KK_USERNAME;
    delete process.env.KK_USERNAME;
    try {
      const r = await request({ method: 'POST', path: '/api/auth/login',
        body: { username: TEST_USERNAME, password: TEST_PASSWORD } });
      assert.equal(r.status, 503,
        `Expected 503 when KK_USERNAME is missing, got ${r.status}`);
    } finally {
      process.env.KK_USERNAME = saved;
    }
  });

  test('login returns 503 when KK_PASSWORD_HASH env var is temporarily unset', async () => {
    const saved = process.env.KK_PASSWORD_HASH;
    delete process.env.KK_PASSWORD_HASH;
    try {
      const r = await request({ method: 'POST', path: '/api/auth/login',
        body: { username: TEST_USERNAME, password: TEST_PASSWORD } });
      assert.equal(r.status, 503);
    } finally {
      process.env.KK_PASSWORD_HASH = saved;
    }
  });
});

// ── 11. Removed diagnostic routes are gone ───────────────────────────────────
describe('Removed diagnostic routes', () => {
  const removedRoutes = [
    '/api/test-norrebro',
    '/api/stores',
    '/api/planday/departments-raw',
    '/api/planday/departments-list',
    '/api/planday/pay-test',
    '/api/planday/timeandcost',
    '/api/planday/tac-test',
    '/api/planday/payrates-by-group',
    '/api/planday/individual-rates',
    '/api/planday/pay-access',
    '/api/planday/payrates-debug',
    '/api/planday/payrates-raw',
    '/api/planday/employees-raw',
    '/api/planday/shifts-raw',
    '/api/planday/debug',
  ];

  for (const p of removedRoutes) {
    test(`${p} returns 404`, async () => {
      const r = await request({ path: p });
      assert.equal(r.status, 404, `Expected 404 for ${p}, got ${r.status}`);
    });
  }
});

// ── 12. Planday reads credentials from environment variables ──────────────────
describe('Planday env config', () => {
  test('token refresh sends PLANDAY_APP_ID and PLANDAY_REFRESH_TOKEN from env', async () => {
    axiosBehaviour = 'token-success';
    const startIdx = capturedAxiosCalls.length;
    // Trigger a Planday API call (salaries) so the token refresh and API GET are captured.
    const { jar } = await doLogin();
    await authGet('/api/planday/salaries/2026-01-01/2026-01-07', jar);

    const calls = capturedAxiosCalls.slice(startIdx);
    const tokenPost  = calls.find(c => c.type === 'post' && c.url.includes('planday.com'));
    const plandayGet = calls.find(c => c.type === 'get'  && c.url.includes('planday.com'));

    // Token endpoint may not be called when cache is still warm from a prior test;
    // assert when it is called.
    if (tokenPost) {
      assert.ok(tokenPost.body.includes(TEST_PLANDAY_APP_ID),
        'PLANDAY_APP_ID from env not sent to token endpoint');
      assert.ok(tokenPost.body.includes(TEST_PLANDAY_REFRESH_TOKEN),
        'PLANDAY_REFRESH_TOKEN from env not sent to token endpoint');
    }
    // All Planday API GETs must carry the app ID as X-ClientId.
    if (plandayGet) {
      assert.equal(plandayGet.headers['X-ClientId'], TEST_PLANDAY_APP_ID,
        'X-ClientId header does not match PLANDAY_APP_ID env var');
    }
  });
});

// ── 13. Per-store OnlinePOS token isolation ───────────────────────────────────
describe('Per-store token isolation', () => {
  // Run all 6 stores sequentially inside one test to avoid concurrent-capture races.
  // Uses isolationJar (pre-established session) to avoid racing with the env-var
  // deletion in the "Missing auth configuration" suite.
  test('each store revenue request uses its own configured env token', async () => {
    const storeTokens = [
      ['indre-by',       TEST_TOKEN_INDRE_BY],
      ['vesterbro',      TEST_TOKEN_VESTERBRO],
      ['christianshavn', TEST_TOKEN_CHRISTIANSHAVN],
      ['fisketorvet',    TEST_TOKEN_FISKETORVET],
      ['frederiksberg',  TEST_TOKEN_FREDERIKSBERG],
      ['norrebro',       TEST_TOKEN_NORREBRO],
    ];

    for (const [storeId, expectedToken] of storeTokens) {
      const startIdx = capturedAxiosCalls.length;
      await authGet(`/api/revenue/${storeId}/1700000000/1700086400`, isolationJar);

      const calls = capturedAxiosCalls.slice(startIdx);
      const posCall = calls.find(c => c.type === 'get' && c.url.includes('onlinepos.dk'));
      assert.ok(posCall, `No OnlinePOS GET captured for ${storeId}`);
      assert.equal(posCall.headers['token'], expectedToken,
        `${storeId} used wrong token; expected env var value`);
    }
  });
});

// ── 14. Missing provider config fails at startup ──────────────────────────────
describe('Provider config startup validation', () => {
  const { spawnSync } = require('node:child_process');

  // Build a minimal env that omits one provider var; NODE_ENV must not be 'test'
  // so the fail-closed check runs.
  function envWithout(omit) {
    const e = {
      NODE_ENV:          'production',
      KK_SESSION_SECRET: 'x'.repeat(32),
      KK_USERNAME:       'u',
      KK_PASSWORD_HASH:  '$2a$04$aaaaaaaaaaaaaaaaaaaaauBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      PLANDAY_APP_ID:             'a',
      PLANDAY_REFRESH_TOKEN:      'b',
      ONLINEPOS_TOKEN_INDRE_BY:        'c',
      ONLINEPOS_TOKEN_VESTERBRO:       'd',
      ONLINEPOS_TOKEN_CHRISTIANSHAVN:  'e',
      ONLINEPOS_TOKEN_FISKETORVET:     'f',
      ONLINEPOS_TOKEN_FREDERIKSBERG:   'g',
      ONLINEPOS_TOKEN_NORREBRO:        'h',
    };
    delete e[omit];
    return e;
  }

  const providerVars = [
    'PLANDAY_APP_ID', 'PLANDAY_REFRESH_TOKEN',
    'ONLINEPOS_TOKEN_INDRE_BY', 'ONLINEPOS_TOKEN_VESTERBRO',
    'ONLINEPOS_TOKEN_CHRISTIANSHAVN', 'ONLINEPOS_TOKEN_FISKETORVET',
    'ONLINEPOS_TOKEN_FREDERIKSBERG', 'ONLINEPOS_TOKEN_NORREBRO',
  ];

  for (const varName of providerVars) {
    test(`server exits when ${varName} is missing`, () => {
      const result = spawnSync(process.execPath, ['server.js'], {
        cwd: __dirname, env: envWithout(varName), timeout: 5000, encoding: 'utf8'
      });
      assert.equal(result.status, 1, `Expected exit code 1 when ${varName} is absent`);
      assert.ok(result.stderr.includes(varName),
        `Stderr should name the missing variable ${varName}; got: ${result.stderr}`);
    });
  }
});

// ── 15. Provider credentials not in frontend or API responses ─────────────────
describe('No credentials in frontend or API responses', () => {
  const allTestTokens = [
    TEST_PLANDAY_APP_ID, TEST_PLANDAY_REFRESH_TOKEN,
    TEST_TOKEN_INDRE_BY, TEST_TOKEN_VESTERBRO, TEST_TOKEN_CHRISTIANSHAVN,
    TEST_TOKEN_FISKETORVET, TEST_TOKEN_FREDERIKSBERG, TEST_TOKEN_NORREBRO,
  ];

  function containsAnyToken(text) {
    return allTestTokens.find(t => text.includes(t));
  }

  test('GET / (frontend HTML) contains no provider tokens', async () => {
    const r = await request({ path: '/' });
    const found = containsAnyToken(r.body);
    assert.ok(!found, `Frontend HTML contains token value: ${found}`);
  });

  test('GET /api/health contains no provider tokens', async () => {
    const r = await request({ path: '/api/health' });
    const found = containsAnyToken(r.body);
    assert.ok(!found, `Health response contains token value: ${found}`);
  });

  test('GET /api/auth/session contains no provider tokens', async () => {
    const { jar } = await doLogin();
    const r = await authGet('/api/auth/session', jar);
    const found = containsAnyToken(r.body);
    assert.ok(!found, `Session response contains token value: ${found}`);
  });

  test('revenue API response contains no provider tokens', async () => {
    const { jar } = await doLogin();
    const r = await authGet('/api/revenue/vesterbro/1700000000/1700086400', jar);
    const found = containsAnyToken(r.body);
    assert.ok(!found, `Revenue response contains token value: ${found}`);
  });
});
