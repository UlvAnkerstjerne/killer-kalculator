'use strict';
// Run:  npm install   then   node server.js

const express   = require('express');
const axios     = require('axios');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');

const session   = require('express-session');
const MemStore  = require('memorystore')(session);
const bcrypt    = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { fetchSalesRange } = require('./lib/pos-fetcher');
const { computeMetrics } = require('./lib/product-metrics');
const { createSalesRangeCache } = require('./lib/sales-range-cache');
const { deriveSalesSubrange } = require('./lib/sales-range-derivation');

// ── Fail-closed configuration check ──────────────────────────────────────────
// Require all three auth env vars.  In the test environment they are set
// programmatically before the module is loaded; in production they must come
// from Railway environment variables.
const REQUIRED_ENV = [
  'KK_SESSION_SECRET', 'KK_USERNAME', 'KK_PASSWORD_HASH',
  'PLANDAY_APP_ID', 'PLANDAY_REFRESH_TOKEN',
  'ONLINEPOS_TOKEN_INDRE_BY', 'ONLINEPOS_TOKEN_VESTERBRO',
  'ONLINEPOS_TOKEN_CHRISTIANSHAVN', 'ONLINEPOS_TOKEN_FISKETORVET',
  'ONLINEPOS_TOKEN_FREDERIKSBERG', 'ONLINEPOS_TOKEN_NORREBRO'
];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);

if (missingEnv.length && process.env.NODE_ENV !== 'test') {
  console.error('[auth] Missing required environment variables:', missingEnv.join(', '));
  console.error('[auth] Set them before starting the server.  See README for setup instructions.');
  process.exit(1);
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

// Trust the first proxy hop (Railway reverse-proxy) so rate-limiter and
// secure-cookie logic see the real client IP and the correct protocol.
app.set('trust proxy', 1);

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// ── Session middleware ────────────────────────────────────────────────────────
// memorystore prunes expired sessions automatically and does not leak memory
// (unlike the default MemoryStore).  Appropriate for a single-instance
// internal tool.  Migrate to connect-redis if Railway ever runs >1 instance.
const SESSION_MAX_AGE = 8 * 60 * 60 * 1000; // 8 hours

app.use(session({
  secret:            process.env.KK_SESSION_SECRET || 'dev-placeholder-not-used-in-production',
  name:              'kk_sid',
  resave:            false,
  saveUninitialized: false,
  rolling:           true,       // extend session on each request
  store: new MemStore({ checkPeriod: SESSION_MAX_AGE }),
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   SESSION_MAX_AGE
  }
}));

// ── Auth / CSRF middleware ────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Verify CSRF token for all state-changing requests.
// The token is generated on login and returned to the client; the client
// includes it as X-CSRF-Token on every POST/PUT/DELETE.
function requireCsrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  const headerToken  = req.headers['x-csrf-token'];
  const sessionToken = req.session?.csrfToken;
  if (!headerToken || !sessionToken || headerToken !== sessionToken) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}

// Login throttle: max 5 attempts per 15 minutes per IP.
const loginLimiter = rateLimit({
  windowMs:         15 * 60 * 1000,
  max:              5,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Too many login attempts, please try again later.' },
  skipSuccessfulRequests: true
});

// ── Frontend ──────────────────────────────────────────────────────────────────
// Serve only the single-page frontend — never the repository root.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Serve the canonical product-metrics module for browser use.
// No auth required: the product ID classification contains no secrets —
// only the public OnlinePOS product IDs for the menu items.
// The UMD wrapper makes this module work in both Node.js and the browser.
// Served via a specific hardcoded route, NOT express.static, so no other
// repository files are reachable through this path.
app.get('/js/product-metrics.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.sendFile(path.join(__dirname, 'lib', 'product-metrics.js'));
});

// ── Auth routes ───────────────────────────────────────────────────────────────

// POST /api/auth/login — verify credentials, create session
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const expectedUser = process.env.KK_USERNAME;
  const expectedHash = process.env.KK_PASSWORD_HASH;

  // If env vars are absent (should have been caught at startup but guard here
  // for belt-and-braces) — fail closed rather than allowing anonymous access.
  if (!expectedUser || !expectedHash) {
    console.error('[auth] Auth configuration missing at login time — rejecting.');
    return res.status(503).json({ error: 'Authentication not configured.' });
  }

  const usernameMatch  = username === expectedUser;
  const passwordMatch  = usernameMatch && await bcrypt.compare(password, expectedHash);

  if (!usernameMatch || !passwordMatch) {
    // Identical response for both wrong-username and wrong-password to prevent
    // username enumeration.
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  // Rotate session ID on login to prevent session fixation.
  await new Promise((resolve, reject) =>
    req.session.regenerate(err => err ? reject(err) : resolve())
  );

  req.session.userId   = expectedUser;
  req.session.csrfToken = crypto.randomBytes(24).toString('hex');

  console.log('[auth] Login:', expectedUser);
  return res.json({ ok: true, csrfToken: req.session.csrfToken });
});

// POST /api/auth/logout — destroy session
app.post('/api/auth/logout', requireAuth, requireCsrf, (req, res) => {
  const user = req.session.userId;
  req.session.destroy(err => {
    if (err) console.error('[auth] Session destroy error:', err.message);
    res.clearCookie('kk_sid');
    console.log('[auth] Logout:', user);
    res.json({ ok: true });
  });
});

// GET /api/auth/session — check whether session is active; returns CSRF token
app.get('/api/auth/session', requireAuth, (req, res) => {
  res.json({ ok: true, csrfToken: req.session.csrfToken });
});

// ── Health (unprotected — used by uptime monitors) ───────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Planday credentials (from environment) ────────────────────────────────────
const PLANDAY_APP_ID        = process.env.PLANDAY_APP_ID;
const PLANDAY_REFRESH_TOKEN = process.env.PLANDAY_REFRESH_TOKEN;

// In-memory token cache — refreshed automatically when expired
let plandayToken = null; // { accessToken, expiresAt }

async function getPlandayToken() {
  if (plandayToken && Date.now() < plandayToken.expiresAt - 60_000) {
    return plandayToken.accessToken;
  }

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: PLANDAY_REFRESH_TOKEN,
    client_id:     PLANDAY_APP_ID
  });

  console.log('[Planday] Requesting token from https://id.planday.com/connect/token');

  let res;
  try {
    res = await axios.post('https://id.planday.com/connect/token', body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });
  } catch (err) {
    console.error('[Planday] Token request failed, HTTP', err.response?.status ?? '(no response)');
    throw err;
  }

  console.log('[Planday] Token response status:', res.status);

  plandayToken = {
    accessToken: res.data.access_token,
    expiresAt:   Date.now() + res.data.expires_in * 1000
  };

  console.log('[Planday] Token refreshed, expires in', res.data.expires_in, 's');
  return plandayToken.accessToken;
}

// Authenticated GET against the Planday OpenAPI
function plandayGet(path, token, params = {}) {
  return axios.get('https://openapi.planday.com' + path, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'X-ClientId':    PLANDAY_APP_ID,
      'Accept':        'application/json'
    },
    params,
    timeout: 15000
  });
}

// Fetch ALL pages of a paginated Planday endpoint
async function plandayGetAll(endpoint, token, params = {}) {
  const all   = [];
  let offset  = 0;
  const limit = 100;

  while (true) {
    const r    = await plandayGet(endpoint, token, { ...params, limit, offset });
    const data = r.data.data || [];
    all.push(...data);

    const total = r.data.paging?.total ?? 0;
    offset += data.length;
    if (data.length === 0 || offset >= total) break;
  }

  return all;
}

// Hardcoded Planday department ID → store ID mapping
const DEPT_TO_STORE = {
  148561: 'vesterbro',
  149668: 'indre-by',
  149700: 'norrebro',
  149715: 'frederiksberg',
  149725: 'fisketorvet',
  149748: 'christianshavn'
};

const HOURLY_RATE = 160; // DKK/hr fixed rate for all employees

// ── Store configuration (tokens from environment) ─────────────────────────────
const STORES = {
  'indre-by':       { name: 'Indre By',       firmaid: 15143, token: process.env.ONLINEPOS_TOKEN_INDRE_BY },
  'vesterbro':      { name: 'Vesterbro',      firmaid: 13205, token: process.env.ONLINEPOS_TOKEN_VESTERBRO },
  'christianshavn': { name: 'Christianshavn', firmaid: 21331, token: process.env.ONLINEPOS_TOKEN_CHRISTIANSHAVN },
  'fisketorvet':    { name: 'Fisketorvet',    firmaid: 18926, token: process.env.ONLINEPOS_TOKEN_FISKETORVET },
  'frederiksberg':  { name: 'Frederiksberg',  firmaid: 18924, token: process.env.ONLINEPOS_TOKEN_FREDERIKSBERG },
  'norrebro':       { name: 'Nørrebro',       firmaid: 18095, token: process.env.ONLINEPOS_TOKEN_NORREBRO }
};

const API_BASE = 'https://api.onlinepos.dk/api';

// Express URL-decodes route params, so 'n%C3%B8rrebro' arrives as 'nørrebro'.
// Normalize Danish characters so the STORES key lookup always succeeds.
function findStore(id) {
  if (STORES[id]) return STORES[id];
  const normalized = id.toLowerCase()
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/å/g, 'aa');
  return STORES[normalized] || null;
}

function posGet(endpoint, store) {
  return axios.get(`${API_BASE}${endpoint}`, {
    headers: {
      'token':   store.token,
      'firmaid': String(store.firmaid),
      'Accept':  'application/json'
    },
    timeout: 20000
  });
}

// ── Business routes (all require authentication) ──────────────────────────────


// ── Sales-range endpoint ──────────────────────────────────────────────────────

// Maximum date range for a single request.  Prevents exhaustive historical
// exports over the paginated exportSales/v20 endpoint.  366 days covers any
// single calendar year including leap years.
const SALES_RANGE_MAX_DAYS = 366;

/**
 * Return true when str is a real YYYY-MM-DD calendar date.
 * Rejects month 13, day 32, Feb 30, etc. via UTC round-trip.
 */
function isValidISODate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth()    === m - 1 &&
    dt.getUTCDate()     === d
  );
}

/**
 * Extract the Copenhagen hour (0–23) directly from a naive CPH-local timestamp
 * string such as "2026-09-20 14:31:00".  The string already encodes CPH local
 * time so the hour component is read without any UTC conversion.
 */
function cphHourFromLine(line) {
  const tsStr = line.timestamp_pay || line.datetime || null;
  if (!tsStr || typeof tsStr !== 'string') return null;
  const m = /[ T](\d{2}):\d{2}:\d{2}/.exec(tsStr.trim());
  return m ? parseInt(m[1], 10) : null;
}

// Seconds since Copenhagen-local midnight. This retains enough precision for
// point-in-time LY comparisons without exposing the original sale timestamp.
function cphSecondOfDayFromLine(line) {
  const tsStr = line.timestamp_pay || line.datetime || null;
  if (!tsStr || typeof tsStr !== 'string') return null;
  const m = /[ T](\d{2}):(\d{2}):(\d{2})/.exec(tsStr.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Return only the allowlisted fields from a processed sales line.
 * All raw upstream fields not on this list — cardnumber, clerk, orderlineid,
 * firmaid, debtorname, timestamps, order IDs, costing fields, and any other
 * customer/employee fields — are discarded here and never reach the browser.
 */
function sanitiseSalesLine(line) {
  return {
    productid:       line.productid       ?? null,
    productname:     line.productname     ?? null,
    productgroupid:  line.productgroupid  ?? null,
    productgroup:    line.productgroup    ?? null,
    count:           line.count           ?? null,
    price:           line.price           ?? null,
    priceexclvat:    line.priceexclvat    ?? null,
    paymenttype:     line.paymenttype     ?? null,
    paymenttypecode: line.paymenttypecode ?? null,
    date:            line._cphDate        ?? null,
    hour:            cphHourFromLine(line),
    secondOfDay:     cphSecondOfDayFromLine(line),
  };
}

/**
 * Thin axios adapter matching the httpGet signature expected by fetchSalesRange.
 * Credentials travel in the headers object constructed inside fetchSalesRange —
 * never embedded in the URL.
 */
async function posHttpGet(url, headers) {
  return axios.get(url, { headers, timeout: 20000 });
}

// Successful complete ranges are shared across sessions because they contain
// the same allowlisted business data. Current/open data stays fresh for at most
// 10 minutes and is refreshed once shortly before expiry when recently used;
// closed historical ranges remain fresh for 6h. The weighted LRU is bounded to
// 120 entries and 32 MiB of estimated serialized result data.
let salesRangeCache;
salesRangeCache = createSalesRangeCache({
  fetchRange: ({ store, start, end }) => fetchSalesRange({
    store, start, end, httpGet: posHttpGet,
  }),
  onRefreshError: (err, { storeId, start, end }) => {
    console.warn(`[sales-range] background refresh failed for ${storeId} ${start}→${end}:`, err.message);
  },
  onCacheWrite: ({ args, result, entry }) => {
    const today = cphDateStr();
    const tomorrow = cphDateNextDay(today);
    if (args.start !== cphWeekMonday(today) || args.end !== tomorrow) return;

    const derivedToday = deriveSalesSubrange(result, today, tomorrow);
    if (!derivedToday) return;
    salesRangeCache.prime({
      storeId: args.storeId,
      store: args.store,
      start: today,
      end: tomorrow,
    }, derivedToday, {
      fetchedAt: entry.fetchedAt,
      lastAccessedAt: entry.lastAccessedAt,
      refreshArgs: args,
    });
  },
});
app.locals.salesRangeCache = salesRangeCache;

/**
 * GET /api/sales-range/:storeId/:start/:end
 *
 * :start  Inclusive CPH date  YYYY-MM-DD (Europe/Copenhagen)
 * :end    Exclusive CPH date  YYYY-MM-DD (Europe/Copenhagen)
 *
 * Fetches all exportSales/v20 pages for the store over the date range,
 * filters to [start, end) by CPH timestamp_pay, deduplicates by orderlineid,
 * and returns only allowlisted non-sensitive fields plus safe completeness
 * metadata.  Pagination, loop/stall detection and URL validation are performed
 * by lib/pos-fetcher before this route responds.
 *
 * 400  Bad or missing params (invalid date, end ≤ start, range > 366 days)
 * 404  Unknown storeId
 * 502  Any upstream / network / pagination failure
 */
app.get('/api/sales-range/:storeId/:start/:end', requireAuth, async (req, res) => {
  const { storeId, start, end } = req.params;

  const store = findStore(storeId);
  if (!store) return res.status(404).json({ error: 'Unknown store' });

  if (!isValidISODate(start)) {
    return res.status(400).json({ error: 'start must be a valid YYYY-MM-DD date' });
  }
  if (!isValidISODate(end)) {
    return res.status(400).json({ error: 'end must be a valid YYYY-MM-DD date' });
  }
  if (end <= start) {
    return res.status(400).json({ error: 'end must be strictly after start' });
  }

  const diffDays = Math.round(
    (new Date(end + 'T12:00:00Z') - new Date(start + 'T12:00:00Z')) / 86_400_000
  );
  if (diffDays > SALES_RANGE_MAX_DAYS) {
    return res.status(400).json({
      error: `Date range must not exceed ${SALES_RANGE_MAX_DAYS} days`
    });
  }

  try {
    const cached = await salesRangeCache.get({ storeId, store, start, end });
    const result = cached.result;

    const lines = result.lines.map(sanitiseSalesLine);

    // Raw conflict records and orderlineids are never sent to the browser;
    // only the conflict count is exposed so completeness can be assessed.
    const meta = {
      complete:           result.meta.complete,
      pages:              result.meta.pages,
      rawLineCount:       result.meta.rawLineCount,
      processedLineCount: result.meta.processedLineCount,
      outOfRange:         result.meta.outOfRange,
      duplicatesRemoved:  result.meta.duplicatesRemoved,
      invalidCount:       result.meta.invalidCount,
      conflictCount:      result.meta.conflicts.length,
      start:              result.meta.start,
      end:                result.meta.end,
      storeId,
      cacheStatus:        cached.cacheStatus,
      stale:              cached.stale,
      cacheAgeMs:         cached.fetchedAt === null ? 0 : Math.max(0, Date.now() - cached.fetchedAt),
    };

    return res.json({ lines, meta });
  } catch (err) {
    // Log the message only — never the store token, firmaid or upstream body
    console.error('[sales-range] upstream error:', err.message);
    return res.status(502).json({ error: 'Upstream data fetch failed' });
  }
});

// ── Invoice image scanning via Claude API ─────────────────────────────────────
app.post('/api/scan-invoice', requireAuth, requireCsrf, async (req, res) => {
  const { base64, mediaType } = req.body;
  if (!base64 || !mediaType) return res.status(400).json({ error: 'Missing base64 or mediaType' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });

  try {
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-opus-4-6',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: 'Extract the invoice details and respond with ONLY a JSON object (no markdown, no code blocks) with these exact fields: supplier (string, the vendor/supplier name), date (string in YYYY-MM-DD format), amount (number, total price excluding VAT / ex moms in DKK). Use null for any field you cannot determine.' }
        ]
      }]
    }, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 30000
    });
    res.json(r.data);
  } catch (err) {
    console.error('[scan-invoice] Error:', err.response?.status ?? err.message);
    res.status(err.response?.status || 500).json({ error: err.message, upstream: err.response?.data });
  }
});

// All 6 department IDs as a comma-separated string for the payroll endpoint
const ALL_DEPT_IDS = Object.keys(DEPT_TO_STORE).join(',');

// Hybrid salary calculation:
// - Salaried employees: cost comes from payroll/v1/payroll (their actual wage for the day)
// - Hourly employees (not in payroll): shifts x HOURLY_RATE
// Both groups are mapped to stores via shift departmentId
async function fetchPayrollByStore(from, to, token) {
  // Fetch payroll and shifts in parallel.
  // Payroll endpoint does NOT support limit/offset — call plandayGet directly.
  const [payrollRes, shifts] = await Promise.all([
    plandayGet('/payroll/v1/payroll', token, { departmentIds: ALL_DEPT_IDS, from, to }),
    plandayGetAll('/scheduling/v1/shifts', token, { from, to })
  ]);

  const payrollRows = payrollRes.data.data || [];
  console.log('[Planday] payroll rows: ' + payrollRows.length + ', shifts: ' + shifts.length);

  // Build set of employee IDs covered by payroll (salaried)
  // and a map of empId → total payroll cost for the period
  const payrollCost = {};
  for (const row of payrollRows) {
    const empId = row.employeeId ?? row.EmployeeId;
    if (empId == null) continue;
    const cost = row.totalCost ?? row.total ?? row.amount ?? row.salaryAmount
               ?? row.cost    ?? row.salary ?? row.wage   ?? 0;
    payrollCost[empId] = (payrollCost[empId] || 0) + cost;
  }
  console.log('[Planday] salaried employees with cost data: ' + Object.keys(payrollCost).length);

  // Build empId → [{departmentId, hours}] from shifts
  const empShifts = {};
  for (const s of shifts) {
    const empId = s.employeeId;
    if (empId == null) continue;
    const hours = (s.startDateTime && s.endDateTime)
      ? (new Date(s.endDateTime) - new Date(s.startDateTime)) / 3600000
      : 0;
    if (!empShifts[empId]) empShifts[empId] = [];
    empShifts[empId].push({ departmentId: s.departmentId, hours });
  }

  const byStore = {};
  let salariedCount = 0, hourlyCount = 0, unmatchedCount = 0;

  // All employees with shifts get processed
  for (const [empId, depts] of Object.entries(empShifts)) {
    const totalHours = depts.reduce((s, d) => s + d.hours, 0);

    // Determine cost: use payroll wage if available, else hours x rate
    let cost;
    if (payrollCost[empId] != null) {
      cost = payrollCost[empId];
      salariedCount++;
    } else {
      cost = totalHours * HOURLY_RATE;
      hourlyCount++;
    }

    // Distribute cost across departments proportional to hours
    for (const { departmentId, hours } of depts) {
      const storeId = DEPT_TO_STORE[departmentId];
      if (!storeId) { unmatchedCount++; continue; }
      const share = totalHours > 0 ? hours / totalHours : 1 / depts.length;
      byStore[storeId] = (byStore[storeId] || 0) + cost * share;
    }
  }

  for (const k of Object.keys(byStore)) byStore[k] = Math.round(byStore[k]);

  console.log('[Planday] salaried: ' + salariedCount + ', hourly (' + HOURLY_RATE + ' DKK/hr): ' + hourlyCount + ', unmatched depts: ' + unmatchedCount);
  console.log('[Planday] byStore:', JSON.stringify(byStore));
  return { byStore, payrollRows, shifts };
}

// ── Planday: scheduled salary costs grouped by department ─────────────────────
// :from and :to are YYYY-MM-DD strings
app.get('/api/planday/salaries/:from/:to', requireAuth, async (req, res) => {
  const { from, to } = req.params;
  const token = await getPlandayToken();
  // Primary: payroll endpoint cross-referenced with shifts for department mapping
  try {
    const { byStore } = await fetchPayrollByStore(from, to, token);
    console.log('[Planday] salaries (payroll) result:', byStore);
    return res.json(byStore);
  } catch (err) {
    console.warn('[Planday] payroll endpoint failed (' + err.response?.status + '), falling back to shift hours');
  }
  // Fallback: shifts x fixed hourly rate
  try {
    const shifts  = await plandayGetAll('/scheduling/v1/shifts', token, { from, to });
    const byStore = {};
    let skipped   = 0;
    for (const shift of shifts) {
      const storeId = DEPT_TO_STORE[shift.departmentId];
      if (!storeId) { skipped++; continue; }
      const hours = (shift.startDateTime && shift.endDateTime)
        ? (new Date(shift.endDateTime) - new Date(shift.startDateTime)) / 3600000
        : 0;
      byStore[storeId] = (byStore[storeId] || 0) + Math.round(hours * HOURLY_RATE);
    }
    console.log('[Planday] salaries fallback: ' + shifts.length + ' shifts, ' + skipped + ' skipped');
    return res.json(byStore);
  } catch (err) {
    console.error('[Planday] salaries fallback also failed:', err.response?.status, err.message);
    return res.status(err.response?.status || 500).json({ error: err.message, upstream: err.response?.data });
  }
});

// ── Katering recipes ──────────────────────────────────────────────────────────

const KATERING_RECIPES_PATH = '/mnt/data/katering-recipes.json';

const KATERING_RECIPES_DEFAULT = {
  hummus:    { name: 'Hummus',                  defaultPortion: 80,  batchSize: 80,    ingredients: [{ name: 'Hummus',             grams: 80   }] },
  couscous:  { name: 'Pearl Couscous Salad',    defaultPortion: 150, batchSize: 3075,  ingredients: [{ name: 'Pearl couscous',     grams: 400  }, { name: 'Aubergine',     grams: 1200 }, { name: 'Roasted peppers', grams: 500  }, { name: 'Parsley',       grams: 40   }, { name: 'Olive oil',     grams: 130  }, { name: "Za'atar",       grams: 100  }, { name: 'Garlic',        grams: 8    }, { name: 'Honey',         grams: 6    }, { name: 'Salt',          grams: 5    }] },
  koleslaw:  { name: 'Killer Coleslaw',         defaultPortion: 100, batchSize: 1310,  ingredients: [{ name: 'Cabbage',           grams: 1000 }, { name: 'Apple',         grams: 260  }, { name: 'Parsley',       grams: 50   }] },
  rodbeder:  { name: 'Roasted Beetroot',        defaultPortion: 50,  batchSize: 2165,  ingredients: [{ name: 'Beetroot',          grams: 1000 }, { name: 'Olive oil',     grams: 30   }, { name: 'Dill, frozen',  grams: 100  }, { name: 'Salt',          grams: 1000 }, { name: 'Cumin',         grams: 5    }, { name: 'Lemon juice',   grams: 30   }] },
  labneh:    { name: 'Beetroot Labneh',         defaultPortion: 75,  batchSize: 1950,  ingredients: [{ name: 'Labneh',            grams: 1000 }, { name: 'Beetroot',      grams: 500  }, { name: 'Salt',          grams: 400  }, { name: 'Cumin',         grams: 50   }] },
  falafel:   { name: 'Falafel',                 defaultPortion: 100, batchSize: 8930,  ingredients: [{ name: 'Chickpeas',         grams: 6000 }, { name: 'Onion',         grams: 1000 }, { name: 'Salt',          grams: 140  }, { name: 'Lemon juice',   grams: 200  }, { name: 'Parsley',       grams: 1400 }, { name: 'Ground coriander', grams: 50 }, { name: 'Cumin',         grams: 50   }, { name: 'Chili flakes',  grams: 50   }, { name: 'Baking soda',   grams: 40   }] },
  harissa:   { name: 'Harissa Chili Sauce',     defaultPortion: 30,  batchSize: 10020, ingredients: [{ name: 'Peeled tomatoes',  grams: 5000 }, { name: 'Tomato paste',  grams: 1760 }, { name: 'Olive oil',     grams: 1600 }, { name: 'Fresh chili',   grams: 1000 }, { name: 'Garam masala',  grams: 100  }, { name: 'Dried chili',   grams: 500  }, { name: 'Salt',          grams: 60   }] },
  flatbread: { name: 'Flatbread',               defaultPortion: 1,   batchSize: 1,     ingredients: [{ name: 'Flatbread',         grams: 1    }] },
  lam:       { name: 'Lam',                     defaultPortion: 80,  batchSize: 80,    ingredients: [{ name: 'Lamb shoulder',     grams: 80   }] },
  kylling:   { name: 'Kyllingekød (tilvalg)',   defaultPortion: 80,  batchSize: 80,    ingredients: [{ name: 'Chicken thighs',   grams: 80   }] },
  lemonade:  { name: 'Killer Lemonade (tilvalg)', defaultPortion: 1, batchSize: 36,    ingredients: [{ name: 'Lemon juice',      grams: 1000 }, { name: 'Lime juice',    grams: 1000 }, { name: 'Sugar',         grams: 1550 }, { name: 'Lemon zest',    grams: 3000 }] }
};

const KATERING_DISH_RENAMES = {
  'Perle Cous Cous Salat': 'Pearl Couscous Salad',
  'Killer Koleslaw':        'Killer Coleslaw',
  'Bagte Rødbeder':         'Roasted Beetroot',
  'Fladbrød':               'Flatbread',
  'Lammekød (tilvalg)':     'Lam',
};

const KATERING_INGREDIENT_RENAMES = {
  'Perle-couscous':       'Pearl couscous',
  'Bagte pebre':          'Roasted peppers',
  'Persille':             'Parsley',
  'Olivenolie':           'Olive oil',
  'Zaatar':               "Za'atar",
  'Hvidløg':              'Garlic',
  'Honning':              'Honey',
  'Kål':                  'Cabbage',
  'Æble':                 'Apple',
  'Rødbede':              'Beetroot',
  'Dild, frost':          'Dill, frozen',
  'Spidskommen':          'Cumin',
  'Citronsaft':           'Lemon juice',
  'Kikærter':             'Chickpeas',
  'Løg':                  'Onion',
  'Koriander stødt':      'Ground coriander',
  'Chili flager':         'Chili flakes',
  'Sodium bicarbonate':   'Baking soda',
  'Fritureolie':          'Frying oil',
  'Flåede tomater':       'Peeled tomatoes',
  'Tomatkoncentrat':      'Tomato paste',
  'Friske chili':         'Fresh chili',
  'Tørret chili':         'Dried chili',
  'Fladbrød':             'Flatbread',
  'Lammebov':             'Lamb shoulder',
  'Kyllingelår':          'Chicken thighs',
  'Citronjuice':          'Lemon juice',
  'Limejuice':            'Lime juice',
  'Sukker':               'Sugar',
  'Citron til skal':      'Lemon zest',
};

function migrateKateringRecipes() {
  if (!fs.existsSync(KATERING_RECIPES_PATH)) return;
  try {
    const data = JSON.parse(fs.readFileSync(KATERING_RECIPES_PATH, 'utf8'));
    let changed = false;
    for (const recipe of Object.values(data)) {
      if (KATERING_DISH_RENAMES[recipe.name]) {
        recipe.name = KATERING_DISH_RENAMES[recipe.name];
        changed = true;
      }
      for (const ing of recipe.ingredients || []) {
        if (KATERING_INGREDIENT_RENAMES[ing.name]) {
          ing.name = KATERING_INGREDIENT_RENAMES[ing.name];
          changed = true;
        }
      }
    }
    if (changed) {
      fs.writeFileSync(KATERING_RECIPES_PATH, JSON.stringify(data, null, 2), 'utf8');
      console.log('[katering-recipes] migrated names to English');
    }
  } catch (e) {
    console.error('[katering-recipes] migration error:', e.message);
  }
}
migrateKateringRecipes();

app.get('/api/katering-recipes', requireAuth, (_req, res) => {
  try {
    if (fs.existsSync(KATERING_RECIPES_PATH)) {
      const data = JSON.parse(fs.readFileSync(KATERING_RECIPES_PATH, 'utf8'));
      return res.json(data);
    }
  } catch (e) {
    console.error('[katering-recipes] read error:', e.message);
  }
  res.json(KATERING_RECIPES_DEFAULT);
});

app.post('/api/katering-recipes', requireAuth, requireCsrf, (req, res) => {
  try {
    const dir = path.dirname(KATERING_RECIPES_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(KATERING_RECIPES_PATH, JSON.stringify(req.body, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    console.error('[katering-recipes] write error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Meat tracking ─────────────────────────────────────────────────────────────
const MEAT_PATH = '/mnt/data/meat-tracking.json';

function loadMeat() {
  try {
    if (fs.existsSync(MEAT_PATH)) return JSON.parse(fs.readFileSync(MEAT_PATH, 'utf8'));
  } catch(e) { console.error('[meat] read error:', e.message); }
  return [];
}
function saveMeat(data) {
  try {
    fs.mkdirSync('/mnt/data', { recursive: true });
    fs.writeFileSync(MEAT_PATH, JSON.stringify(data));
  } catch(e) { console.error('[meat] write error:', e.message); }
}

app.get('/api/meat', requireAuth, (_req, res) => {
  res.json(loadMeat());
});

app.post('/api/meat', requireAuth, requireCsrf, (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected array' });
  saveMeat(req.body);
  res.json({ ok: true });
});

// ── Lemonade tracking ─────────────────────────────────────────────────────────
const LEMONADE_HISTORY_PATH = '/mnt/data/lemonade-history.json';

function cphDateStr() {
  return new Date().toLocaleDateString('sv', { timeZone: 'Europe/Copenhagen' });
}

// Return the calendar day after dateStr as "YYYY-MM-DD" (UTC arithmetic; DST-safe).
function cphDateNextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function cphWeekMonday(dateStr) {
  const date = new Date(dateStr + 'T12:00:00Z');
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
  return date.toISOString().slice(0, 10);
}

async function fetchLemonadeToday() {
  const today    = cphDateStr();
  const tomorrow = cphDateNextDay(today);   // exclusive end — today only

  const results = await Promise.allSettled(
    Object.entries(STORES).map(async ([id, store]) => {
      // History snapshots must wait for a fresh result. This still shares any
      // dashboard refresh already in flight for the identical range.
      const { result } = await salesRangeCache.get({
        storeId: id, store, start: today, end: tomorrow,
      });
      // Incomplete result (conflicts / invalids) must not corrupt totals.
      if (!result.meta.complete) {
        throw new Error(`incomplete result (invalidCount=${result.meta.invalidCount} conflicts=${result.meta.conflicts.length})`);
      }
      // Count lemonade units using the canonical product ID engine.
      // computeMetrics handles all three lemonade variants (addon, upgrade,
      // standalone) by product ID — no fuzzy product-name matching.
      const count = computeMetrics(result.lines).lemUnits;
      return { id, count };
    })
  );

  const stores   = {};
  let   total    = 0;
  let   complete = true;

  for (const r of results) {
    if (r.status === 'fulfilled') {
      stores[r.value.id] = r.value.count;
      total += r.value.count;
    } else {
      console.warn('[lemonade] fetch error:', r.reason?.message);
      complete = false;   // partial data — do not save to history
    }
  }

  return { date: today, stores, total, complete };
}

// Warm This Week without delaying server readiness. Every complete weekly
// result safely primes Today from its CPH-dated lines, avoiding a second export.
async function warmCurrentSalesRanges() {
  const today = cphDateStr();
  const tomorrow = cphDateNextDay(today);
  const monday = cphWeekMonday(today);
  const weeklyResults = await Promise.allSettled(
    Object.entries(STORES).map(([storeId, store]) => salesRangeCache.get({
      storeId, store, start: monday, end: tomorrow,
    }))
  );
  // Complete weekly entries make these cache hits. Any weekly failure or
  // incomplete result falls back to an explicit Today fetch, preserving safety.
  const todayResults = await Promise.allSettled(
    Object.entries(STORES).map(([storeId, store]) => salesRangeCache.get({
      storeId, store, start: today, end: tomorrow,
    }))
  );
  const warmedWeeks = weeklyResults.filter(
    result => result.status === 'fulfilled' && result.value.result.meta.complete
  ).length;
  const warmedToday = todayResults.filter(
    result => result.status === 'fulfilled' && result.value.result.meta.complete
  ).length;
  const stats = salesRangeCache.stats();
  console.log(
    `[sales-range] startup warm complete: week ${warmedWeeks}/${weeklyResults.length}, ` +
    `today ${warmedToday}/${todayResults.length}, ` +
    `${stats.entries} entries, ${stats.estimatedBytes} estimated bytes`
  );
}
app.locals.warmCurrentSalesRanges = warmCurrentSalesRanges;

function loadLemonadeHistory() {
  try {
    if (fs.existsSync(LEMONADE_HISTORY_PATH))
      return JSON.parse(fs.readFileSync(LEMONADE_HISTORY_PATH, 'utf8'));
  } catch(e) { console.error('[lemonade] read error:', e.message); }
  return [];
}

function saveLemonadeHistory(history) {
  const dir = path.dirname(LEMONADE_HISTORY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LEMONADE_HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
}

app.get('/api/lemonade/history', requireAuth, (_req, res) => {
  res.json(loadLemonadeHistory());
});

app.post('/api/lemonade/history', requireAuth, requireCsrf, (req, res) => {
  try {
    saveLemonadeHistory(req.body);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/lemonade/today', requireAuth, async (_req, res) => {
  try {
    const data = await fetchLemonadeToday();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log('\n  🔪  KILLER KALCULATOR');
    console.log('  ──────────────────────────────');
    console.log('  http://0.0.0.0:' + PORT + '\n');
    void warmCurrentSalesRanges();
  });

  // Scheduled lemonade save at 22:00 Copenhagen time.
  // Only runs in the live process — not during tests.
  let lemonadeSavedDate = null;
  setInterval(() => {
    const cph  = new Date().toLocaleString('sv', { timeZone: 'Europe/Copenhagen' });
    const hour = parseInt(cph.slice(11, 13), 10);
    const date = cph.slice(0, 10);
    if (hour < 22) return;
    if (lemonadeSavedDate === date) return;
    lemonadeSavedDate = date;
    (async () => {
      try {
        const data = await fetchLemonadeToday();
        if (!data.complete) {
          console.warn('[lemonade] skipping history save: incomplete data for', data.date);
          return;
        }
        const history = loadLemonadeHistory();
        const idx     = history.findIndex(e => e.date === data.date);
        if (idx >= 0) history[idx] = data; else history.push(data);
        saveLemonadeHistory(history);
        console.log('[lemonade] saved daily count:', data);
      } catch(e) {
        console.error('[lemonade] scheduled save error:', e.message);
      }
    })();
  }, 60000);
}

module.exports = app;
