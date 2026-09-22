'use strict';
// Browser-behavior tests for killer-kalculator security patch.
// Runs against a local test server with synthetic credentials and mocked provider APIs.
// Requires playwright and bcryptjs in node_modules.
// Usage (from project root with node_modules installed):
//   node scripts/run-browser-tests.js

const path   = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { chromium } = require('playwright');

const PASS  = { user: 'bt-user', pw: 'bt-pw-Xk9z-test' };

// ── 1. Env vars (must precede server load) ─────────────────────────────────────
process.env.NODE_ENV          = 'test';
process.env.KK_USERNAME       = PASS.user;
process.env.KK_PASSWORD_HASH  = bcrypt.hashSync(PASS.pw, 4);
process.env.KK_SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.PLANDAY_APP_ID              = 'bt-planday-app';
process.env.PLANDAY_REFRESH_TOKEN       = 'bt-planday-rt';
process.env.ONLINEPOS_TOKEN_INDRE_BY        = 'bt-ib';
process.env.ONLINEPOS_TOKEN_VESTERBRO       = 'bt-vb';
process.env.ONLINEPOS_TOKEN_CHRISTIANSHAVN  = 'bt-ch';
process.env.ONLINEPOS_TOKEN_FISKETORVET     = 'bt-ft';
process.env.ONLINEPOS_TOKEN_FREDERIKSBERG   = 'bt-fr';
process.env.ONLINEPOS_TOKEN_NORREBRO        = 'bt-nb';

// ── 2. Axios mock (patched before server.js is loaded) ─────────────────────────
// Resolve paths relative to the project root (one level up from scripts/)
const projectRoot = path.join(__dirname, '..');
const axiosPath = require.resolve('axios', { paths: [projectRoot] });
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: {
    post: async () => ({ status: 200, data: { access_token: 'bt-tok', expires_in: 3600 } }),
    get:  async () => ({ status: 200, data: { data: [], paging: { total: 0 } } }),
    create: function() { return this; },
    defaults: { headers: { common: {} } }
  }
};

// ── 3. Start server in-process ─────────────────────────────────────────────────
const app = require(path.join(projectRoot, 'server'));
let BASE_URL;

async function main() {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      BASE_URL = `http://127.0.0.1:${s.address().port}`;
      resolve(s);
    });
  });

  const browser = await chromium.launch({ headless: true });
  const results = [];

  function pass(name) { results.push({ name, ok: true }); }
  function fail(name, reason) { results.push({ name, ok: false, reason }); }

  async function newPage() {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    return page;
  }

  // Helper: fill login form and submit
  async function login(page) {
    await page.fill('#username', PASS.user);
    await page.fill('#password', PASS.pw);
    await page.click('.btn-login');
    await page.waitForSelector('#app:not(.hidden)', { timeout: 5000 });
  }

  // Helper: perform logout via the button
  async function logout(page) {
    await page.click('.btn-logout');
    await page.waitForSelector('#login-screen:not(.hidden)', { timeout: 5000 });
  }

  // ── T1: Login shows app, logout shows login screen ───────────────────────────
  try {
    const page = await newPage();
    await page.goto(BASE_URL);
    await page.waitForSelector('#login-screen:not(.hidden)', { timeout: 5000 });
    const appHiddenBefore = await page.$eval('#app', el => el.classList.contains('hidden'));
    assert.ok(appHiddenBefore, 'app should be hidden before login');

    await login(page);
    const loginHiddenAfter = await page.$eval('#login-screen', el => el.classList.contains('hidden'));
    assert.ok(loginHiddenAfter, 'login screen should be hidden after login');

    await logout(page);
    const loginVisibleAfterLogout = await page.$eval('#login-screen', el => !el.classList.contains('hidden'));
    assert.ok(loginVisibleAfterLogout, 'login screen should be visible after logout');
    const appHiddenAfterLogout = await page.$eval('#app', el => el.classList.contains('hidden'));
    assert.ok(appHiddenAfterLogout, 'app should be hidden after logout');

    await page.context().close();
    pass('T1: login shows app; logout shows login screen');
  } catch (e) {
    fail('T1: login shows app; logout shows login screen', e.message);
  }

  // ── T2: Page reload restores session ─────────────────────────────────────────
  try {
    const page = await newPage();
    await page.goto(BASE_URL);
    await login(page);
    await page.reload();
    await page.waitForSelector('#app:not(.hidden)', { timeout: 5000 });
    const loginHidden = await page.$eval('#login-screen', el => el.classList.contains('hidden'));
    assert.ok(loginHidden, 'login screen should be hidden after reload with valid session');
    await page.context().close();
    pass('T2: page reload restores session');
  } catch (e) {
    fail('T2: page reload restores session', e.message);
  }

  // ── T3: Deleting session cookie causes 401 → login screen ────────────────────
  try {
    const page = await newPage();
    await page.goto(BASE_URL);
    await login(page);

    // Delete the session cookie to simulate expiry
    await page.context().clearCookies();

    // Trigger an authenticated API call by navigating to a data view
    // apiFetch('/api/meat') will get 401 → onSessionExpired()
    await page.evaluate(() => window.apiFetch('/api/meat'));
    await page.waitForSelector('#login-screen:not(.hidden)', { timeout: 5000 });

    const errorText = await page.$eval('#login-error', el => el.textContent);
    assert.ok(errorText.includes('Session expired') || errorText === '',
      `Expected session expired message or empty, got: "${errorText}"`);
    // "Session expired" appears for API-triggered expiry; empty string for logout button
    // apiFetch triggers onSessionExpired('Session expired. Please sign in again.')
    assert.ok(errorText.includes('Session expired'), `Expected session expired message, got: "${errorText}"`);

    const appHidden = await page.$eval('#app', el => el.classList.contains('hidden'));
    assert.ok(appHidden, 'app should be hidden after session expiry');

    await page.context().close();
    pass('T3: session expiry (cookie deleted + 401) shows login screen with message');
  } catch (e) {
    fail('T3: session expiry (cookie deleted + 401) shows login screen with message', e.message);
  }

  // ── T4: In-flight request after logout — stale response cannot update state ────
  // Uses page.evaluate to fire a second loadMeat() without any navigation.
  // Distinctive payload lets us assert that state.meat was NOT overwritten.
  try {
    const page = await newPage();
    await page.goto(BASE_URL);
    await login(page);
    // boot() has now completed; the first /api/meat call already resolved.

    // Distinctive payload that must NOT appear in state.meat after logout.
    const STALE_ITEM = { item: 'stale-t4-x7q2', cut: 'ribeye' };

    // Set up intercept AFTER login so boot's call is not affected.
    let deliverStaleResponse = null;
    const responseHeld = new Promise(resolve => {
      page.route('**/api/meat', async route => {
        resolve(); // signal: request received; about to hold with synthetic body
        await new Promise(r => { deliverStaleResponse = r; });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([STALE_ITEM]),
        });
      });
    });

    // Fire a second loadMeat() call from inside the page (fire-and-forget — no navigation)
    await page.evaluate(() => { window.loadMeat(); });

    // Wait until request is intercepted (held before delivery)
    await responseHeld;

    // Logout while response is still held
    await page.evaluate(() => window.doLogout());
    await page.waitForSelector('#login-screen:not(.hidden)', { timeout: 5000 });

    // Release the stale response to the browser
    deliverStaleResponse();
    await page.waitForTimeout(400);

    // Login screen must still be showing; app must still be hidden.
    const loginVisible = await page.$eval('#login-screen', el => !el.classList.contains('hidden'));
    const appHidden    = await page.$eval('#app',          el => el.classList.contains('hidden'));
    assert.ok(loginVisible, 'login screen should be visible after stale response released post-logout');
    assert.ok(appHidden,    'app should remain hidden after stale response released post-logout');

    // state.meat must NOT have been updated with the stale payload.
    const meatAfter = await page.evaluate(() => state.meat);
    assert.ok(
      !JSON.stringify(meatAfter).includes('stale-t4-x7q2'),
      `state.meat must not be updated with stale data after logout; got: ${JSON.stringify(meatAfter)}`
    );

    // No provider credential values in visible DOM
    const bodyText = await page.$eval('body', el => el.innerText);
    assert.ok(!bodyText.includes('bt-ib') && !bodyText.includes('bt-planday-app'),
      'provider token values must not appear in visible DOM after logout');

    await page.unroute('**/api/meat');
    await page.context().close();
    pass('T4: in-flight response after logout — state not updated, login screen stays');
  } catch (e) {
    fail('T4: in-flight response after logout — state not updated, login screen stays', e.message);
  }

  // ── T4b: Delayed 401 from old session does not log out a new session ──────────
  // A request dispatched in session A returns 401 after session B is established.
  // The 401 must not call onSessionExpired for session B.
  try {
    const page = await newPage();
    await page.goto(BASE_URL);
    await login(page);

    // Intercept: hold first /api/meat, return 401; subsequent calls pass through.
    let deliverStale401 = null;
    let t4bCount = 0;
    const firstIntercepted = new Promise(resolve => {
      page.route('**/api/meat', async route => {
        t4bCount++;
        if (t4bCount === 1) {
          resolve(); // signal: request is held
          await new Promise(r => { deliverStale401 = r; });
          await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Unauthorized"}' });
        } else {
          await route.continue();
        }
      });
    });

    // Fire request from old session (fire-and-forget)
    await page.evaluate(() => { window.loadMeat(); });
    await firstIntercepted;

    // Logout (session A ends)
    await page.evaluate(() => window.doLogout());
    await page.waitForSelector('#login-screen:not(.hidden)', { timeout: 3000 });

    // Re-login (session B starts; boot() fires a new loadMeat(), count=2 → continue)
    await login(page);
    const appVisibleBeforeRelease = await page.$eval('#app', el => !el.classList.contains('hidden'));
    assert.ok(appVisibleBeforeRelease, 'app should be visible after re-login (before stale 401 released)');

    // Release the stale 401 into the new session
    deliverStale401();
    await page.waitForTimeout(400);

    // Session B must survive: app still visible, login screen still hidden
    const appStillVisible = await page.$eval('#app',          el => !el.classList.contains('hidden'));
    const loginHidden     = await page.$eval('#login-screen', el => el.classList.contains('hidden'));
    assert.ok(appStillVisible, 'app must remain visible after stale 401 from old session is delivered');
    assert.ok(loginHidden,     'login screen must remain hidden after stale 401 from old session');

    await page.unroute('**/api/meat');
    await page.context().close();
    pass('T4b: delayed 401 from old session does not log out new session');
  } catch (e) {
    fail('T4b: delayed 401 from old session does not log out new session', e.message);
  }

  // ── T5: Stale response released after re-login — state.meat not overwritten ───
  // Distinctive payloads for old and new sessions let us assert that the new
  // session's data survives after the old stale response arrives.
  try {
    const page = await newPage();
    await page.goto(BASE_URL);
    await login(page);

    const OLD_ITEM = { item: 'old-session-t5-a3b', cut: 'brisket' };
    const NEW_ITEM = { item: 'new-session-t5-c4d', cut: 'tenderloin' };

    // Intercept: return OLD_ITEM for call 1 (held); NEW_ITEM for call 2 (boot after re-login).
    let deliverStale = null;
    let t5Count = 0;
    const firstHeld = new Promise(resolve => {
      page.route('**/api/meat', async route => {
        t5Count++;
        if (t5Count === 1) {
          resolve(); // signal: held
          await new Promise(r => { deliverStale = r; });
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([OLD_ITEM]) });
        } else {
          // New session's boot() call — return NEW_ITEM immediately.
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([NEW_ITEM]) });
        }
      });
    });

    // Fire second loadMeat() (fire-and-forget, no navigation)
    await page.evaluate(() => { window.loadMeat(); });
    await firstHeld;

    // Logout
    await page.evaluate(() => window.doLogout());
    await page.waitForSelector('#login-screen:not(.hidden)', { timeout: 3000 });

    // Re-login — boot() fires a new loadMeat() (count=2) which gets NEW_ITEM immediately
    await login(page);
    const appVisible = await page.$eval('#app', el => !el.classList.contains('hidden'));
    assert.ok(appVisible, 'app should be visible after re-login');

    // Confirm new session has NEW_ITEM in state.meat before stale release
    const meatAfterReLogin = await page.evaluate(() => state.meat);
    assert.ok(
      JSON.stringify(meatAfterReLogin).includes('new-session-t5-c4d'),
      `state.meat should contain new-session item after re-login; got: ${JSON.stringify(meatAfterReLogin)}`
    );

    // Release the old stale response (OLD_ITEM) into the active session
    deliverStale();
    await page.waitForTimeout(400);

    // App must remain visible; login screen must remain hidden
    const appStillVisible = await page.$eval('#app',          el => !el.classList.contains('hidden'));
    const loginHidden     = await page.$eval('#login-screen', el => el.classList.contains('hidden'));
    assert.ok(appStillVisible, 'app must remain visible after stale response arrives during active session');
    assert.ok(loginHidden,     'login screen must remain hidden after stale response arrives during active session');

    // state.meat must still reflect the new session's data, not the stale old data
    const meatFinal = await page.evaluate(() => state.meat);
    assert.ok(
      JSON.stringify(meatFinal).includes('new-session-t5-c4d'),
      `state.meat must still contain new-session item after stale release; got: ${JSON.stringify(meatFinal)}`
    );
    assert.ok(
      !JSON.stringify(meatFinal).includes('old-session-t5-a3b'),
      `state.meat must NOT contain stale old-session item after release; got: ${JSON.stringify(meatFinal)}`
    );

    await page.unroute('**/api/meat');
    await page.context().close();
    pass('T5: stale response released into re-logged-in session — state.meat not overwritten');
  } catch (e) {
    fail('T5: stale response released into re-logged-in session — state.meat not overwritten', e.message);
  }

  // ── T6: localStorage invoices survive logout and re-login ─────────────────────
  try {
    const page = await newPage();
    await page.goto(BASE_URL);
    await login(page);

    // Inject a test invoice into localStorage
    const testInvoice = [{ supplier: 'Test Supplier', date: '2026-01-15', amount: 4200 }];
    await page.evaluate(inv => {
      localStorage.setItem('kk_invoices', JSON.stringify(inv));
    }, testInvoice);

    // Logout
    await logout(page);

    // Verify invoice is still in localStorage after logout
    const afterLogout = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('kk_invoices') || '[]'));
    assert.equal(afterLogout.length, 1, 'invoice must remain in localStorage after logout');
    assert.equal(afterLogout[0].supplier, 'Test Supplier');

    // Re-login
    await login(page);

    // Verify invoice still present after re-login
    const afterReLogin = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('kk_invoices') || '[]'));
    assert.equal(afterReLogin.length, 1, 'invoice must remain in localStorage after re-login');
    assert.equal(afterReLogin[0].supplier, 'Test Supplier');
    assert.equal(afterReLogin[0].amount, 4200);

    await page.context().close();
    pass('T6: localStorage invoices survive logout and re-login');
  } catch (e) {
    fail('T6: localStorage invoices survive logout and re-login', e.message);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────────
  await browser.close();
  await new Promise(resolve => server.close(resolve));

  // ── Report ────────────────────────────────────────────────────────────────────
  const pad = Math.max(...results.map(r => r.name.length));
  console.log('\n=== Browser test results ===\n');
  let allPass = true;
  for (const r of results) {
    const status = r.ok ? 'PASS' : 'FAIL';
    console.log(`  [${status}]  ${r.name}`);
    if (!r.ok) {
      console.log(`         Reason: ${r.reason}`);
      allPass = false;
    }
  }
  console.log(`\n${allPass ? 'All browser tests passed.' : 'SOME BROWSER TESTS FAILED.'}\n`);
  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('Browser test runner error:', err.message);
  process.exit(1);
});
