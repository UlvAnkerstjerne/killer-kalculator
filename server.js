'use strict';
// Run:  npm install express axios   then   node server.js

const express = require('express');
const axios   = require('axios');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(express.static(path.join(__dirname)));

// ── Planday credentials ───────────────────────────────────────────────────────
const PLANDAY_APP_ID        = '5d63af2b-cf46-4d25-94fc-d70f00bbd59a';
const PLANDAY_REFRESH_TOKEN = 'Nm9DPuiLk0araDZ_Ej51Pw';

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

  console.log('[Planday] Token request to https://id.planday.com/connect/token');
  console.log('[Planday] Request body:', body.toString());

  let res;
  try {
    res = await axios.post('https://id.planday.com/connect/token', body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });
  } catch (err) {
    console.error('[Planday] Token request FAILED');
    console.error('[Planday] Status:', err.response?.status);
    console.error('[Planday] Response body:', JSON.stringify(err.response?.data, null, 2));
    console.error('[Planday] Headers sent:', err.config?.headers);
    throw err;
  }

  console.log('[Planday] Token response status:', res.status);
  console.log('[Planday] Token response body:', JSON.stringify(res.data, null, 2));

  plandayToken = {
    accessToken: res.data.access_token,
    expiresAt:   Date.now() + res.data.expires_in * 1000
  };

  console.log('[Planday] Token refreshed, expires in', res.data.expires_in, 's');
  return plandayToken.accessToken;
}

// Authenticated GET against the Planday OpenAPI
function plandayGet(path, token, params = {}) {
  return axios.get(`https://openapi.planday.com${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
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

// ── Store configuration ───────────────────────────────────────────────────────
const STORES = {
  'indre-by':       { name: 'Indre By',       firmaid: 15143, token: '8201cf3d8b644334350130d8a9f7c731df4f3b730bc45ecd67f8e5fb7f2efa3f' },
  'vesterbro':      { name: 'Vesterbro',      firmaid: 13205, token: 'aa8e5bc66fdec5068e5d3c719715203bcbc6c7531fce401d199891e3838d69db' },
  'christianshavn': { name: 'Christianshavn', firmaid: 21331, token: 'a9c1940396b28a4fa273ec6337c5a7c519631e356b953a8fc9208a363642d79b' },
  'fisketorvet':    { name: 'Fisketorvet',    firmaid: 18926, token: '46cdfedfe2409ee5912327b789fac83efc45eac1c9e3480010cba7b16dfce3e6' },
  'frederiksberg':  { name: 'Frederiksberg',  firmaid: 18924, token: 'd3c3259d8cc26bdeae4560992b15459d3d8f36fd0053f2b659f7c3facf44f62a' },
  'norrebro':       { name: 'Nørrebro',       firmaid: 18095, token: 'a646914ecb1aee1ead6d3eb32a61b90f5c81d534e223047f95cd574d00f676c5' }
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

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Diagnostic route — raw OnlinePOS response for Nørrebro today
app.get('/api/test-norrebro', async (_req, res) => {
  const now   = Math.floor(Date.now() / 1000);
  const today = now - (now % 86400);
  try {
    const r = await axios.get(`${API_BASE}/getByUnixTimeSales/${today}/${now}`, {
      headers: {
        'token':   'a646914ecb1aee1ead6d3eb32a61b90f5c81d534e223047f95cd574d00f676c5',
        'firmaid': '18095',
        'Accept':  'application/json'
      },
      timeout: 20000
    });
    res.json({ status: r.status, from: today, to: now, data: r.data });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      error: err.message, from: today, to: now,
      upstream: err.response?.data, headers: err.response?.headers
    });
  }
});

app.get('/api/stores', (_req, res) => {
  res.json(Object.entries(STORES).map(([id, s]) => ({ id, name: s.name })));
});

// Revenue for one store over a unix time range
app.get('/api/revenue/:storeId/:from/:to', async (req, res) => {
  const store = findStore(req.params.storeId);
  if (!store) return res.status(404).json({ error: 'Unknown store' });
  try {
    const r = await posGet(`/getByUnixTimeSales/${req.params.from}/${req.params.to}`, store);
    res.json(r.data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message, upstream: err.response?.data });
  }
});

// Revenue for ALL 6 stores in parallel
app.get('/api/all-revenue/:from/:to', async (req, res) => {
  const { from, to } = req.params;
  const settled = await Promise.allSettled(
    Object.entries(STORES).map(async ([id, store]) => {
      const r = await posGet(`/getByUnixTimeSales/${from}/${to}`, store);
      return { id, data: r.data };
    })
  );
  const out = {};
  for (const r of settled) {
    if (r.status === 'fulfilled') out[r.value.id] = r.value.data;
    else console.warn('Revenue fetch error:', r.reason?.message);
  }
  res.json(out);
});

// Detailed item-level sales for one store on one day
app.get('/api/sales/:storeId/:unixtime', async (req, res) => {
  const store = findStore(req.params.storeId);
  if (!store) return res.status(404).json({ error: 'Unknown store' });
  try {
    const r = await posGet(`/exportSales/v20/${req.params.unixtime}`, store);
    res.json(r.data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message, upstream: err.response?.data });
  }
});

// ── Invoice image scanning via Claude API ─────────────────────────────────────
app.post('/api/scan-invoice', async (req, res) => {
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
    console.error('Scan error full:', JSON.stringify(err.response?.data));
    res.status(err.response?.status || 500).json({ error: err.message, upstream: err.response?.data });
  }
});

// ── Planday: departments raw ───────────────────────────────────────────────────
app.get('/api/planday/departments-raw', async (_req, res) => {
  try {
    const token = await getPlandayToken();
    const depts = await plandayGetAll('/hr/v1/departments', token);
    console.log('[Planday] departments:', JSON.stringify(depts, null, 2));
    res.json({ count: depts.length, departments: depts });
  } catch (err) {
    console.error('[Planday] departments-raw error:', err.response?.status, err.response?.data);
    res.status(err.response?.status || 500).json({ error: err.message, body: err.response?.data });
  }
});

// ── Planday: departments list (tries multiple endpoints) ───────────────────────
app.get('/api/planday/departments-list', async (_req, res) => {
  const out = {};
  try {
    const token = await getPlandayToken();

    const endpoints = [
      { key: 'hr_v1_departments',           path: '/hr/v1/departments',           params: { limit: 50, offset: 0 } },
      { key: 'scheduling_v1_departments',   path: '/scheduling/v1/departments',   params: { limit: 50, offset: 0 } },
      { key: 'hr_v1_departments_nolimit',   path: '/hr/v1/departments',           params: {} },
    ];

    for (const { key, path, params } of endpoints) {
      try {
        const r = await plandayGet(path, token, params);
        console.log(`[Planday departments-list] ${path} → status ${r.status}`);
        console.log(`[Planday departments-list] ${path} body:`, JSON.stringify(r.data, null, 2));
        out[key] = { status: r.status, params, body: r.data };
      } catch (err) {
        console.error(`[Planday departments-list] ${path} FAILED → status ${err.response?.status}`);
        console.error(`[Planday departments-list] ${path} response:`, JSON.stringify(err.response?.data, null, 2));
        out[key] = { status: err.response?.status, params, error: err.message, body: err.response?.data };
      }
    }
  } catch (err) {
    out.token_error = { error: err.message, body: err.response?.data };
  }

  res.json(out);
});

// ── Planday: pay test ─────────────────────────────────────────────────────────
app.get('/api/planday/pay-test', async (_req, res) => {
  const out = {};
  try {
    const token = await getPlandayToken();
    out.token_first10 = token.slice(0, 10);
    out.app_id        = PLANDAY_APP_ID;

    const endpoints = [
      { key: 'pay_v1_payrates',      path: '/pay/v1/payrates',      params: { limit: 50, offset: 0 } },
      { key: 'pay_v1_employeerates', path: '/pay/v1/employeerates', params: { limit: 50, offset: 0 } },
      { key: 'pay_v1_salaryrates',   path: '/pay/v1/salaryrates',   params: { limit: 50, offset: 0 } },
      { key: 'shifts_with_cost',     path: '/scheduling/v1/shifts', params: { from: '2026-03-25', to: '2026-03-25', limit: 50, offset: 0 } },
    ];

    for (const { key, path, params } of endpoints) {
      try {
        const r = await plandayGet(path, token, params);
        // For shifts: highlight any cost/salary/wage/rate fields present on the objects
        let costFields = null;
        if (key === 'shifts_with_cost' && Array.isArray(r.data.data) && r.data.data.length) {
          const keys = Object.keys(r.data.data[0]);
          costFields = keys.filter(k => /cost|salary|wage|rate|pay|amount/i.test(k));
        }
        console.log(`[Planday pay-test] ${path} → ${r.status}`);
        console.log(`[Planday pay-test] ${path} body:`, JSON.stringify(r.data, null, 2));
        out[key] = { status: r.status, paging: r.data.paging, data: r.data.data, costFields };
      } catch (err) {
        console.error(`[Planday pay-test] ${path} → ${err.response?.status}`);
        console.error(`[Planday pay-test] ${path} body:`, JSON.stringify(err.response?.data, null, 2));
        out[key] = { status: err.response?.status, error: err.message, body: err.response?.data };
      }
    }
  } catch (err) {
    out.token_error = { error: err.message, body: err.response?.data };
  }

  res.json(out);
});

// ── Planday: time and cost debug ───────────────────────────────────────────────
app.get('/api/planday/timeandcost', async (_req, res) => {
  const out = {};
  const date = '2026-03-25';
  try {
    const token = await getPlandayToken();
    out.token_first10 = token.slice(0, 10);

    const endpoints = [
      { key: 'timeandcost_v1',   path: '/timeandcost/v1/timeandcost', params: { from: date, to: date, departmentIds: ALL_DEPT_IDS } },
      { key: 'scheduling_tac',   path: '/scheduling/v1/timeandcost',  params: { from: date, to: date } },
      { key: 'hr_tac',           path: '/hr/v1/timeandcost',          params: { from: date, to: date } },
    ];

    for (const { key, path, params } of endpoints) {
      try {
        const r = await plandayGet(path, token, params);
        console.log(`[Planday timeandcost] ${path} → ${r.status}`);
        console.log(`[Planday timeandcost] ${path} body:`, JSON.stringify(r.data, null, 2));
        out[key] = { status: r.status, body: r.data };
      } catch (err) {
        console.error(`[Planday timeandcost] ${path} → ${err.response?.status}`);
        console.error(`[Planday timeandcost] ${path} body:`, JSON.stringify(err.response?.data, null, 2));
        out[key] = { status: err.response?.status, error: err.message, body: err.response?.data };
      }
    }
  } catch (err) {
    out.token_error = { error: err.message, body: err.response?.data };
  }
  res.json(out);
});

// ── Planday: tac-test ─────────────────────────────────────────────────────────
app.get('/api/planday/tac-test', async (_req, res) => {
  const out = {};
  const date  = '2026-03-25';
  const deptId = 149668; // Indre By as test department
  try {
    const token = await getPlandayToken();
    out.token_first10 = token.slice(0, 10);

    const endpoints = [
      { key: 'shifts_timeandcost',   path: '/scheduling/v1/shifts/timeandcost', params: { departmentId: deptId, from: date, to: date } },
      { key: 'scheduling_timeandcost', path: '/scheduling/v1/timeandcost',      params: { departmentId: deptId, from: date, to: date } },
      { key: 'shifts_includecost',   path: '/scheduling/v1/shifts',             params: { departmentId: deptId, from: date, to: date, includeCost: true, limit: 10, offset: 0 } },
    ];

    for (const { key, path, params } of endpoints) {
      try {
        const r = await plandayGet(path, token, params);
        console.log(`[Planday tac-test] ${path} → ${r.status}`);
        console.log(`[Planday tac-test] ${path} body:`, JSON.stringify(r.data, null, 2));
        out[key] = { status: r.status, body: r.data };
      } catch (err) {
        console.error(`[Planday tac-test] ${path} → ${err.response?.status}`);
        console.error(`[Planday tac-test] ${path} body:`, JSON.stringify(err.response?.data, null, 2));
        out[key] = { status: err.response?.status, error: err.message, body: err.response?.data };
      }
    }
  } catch (err) {
    out.token_error = { error: err.message, body: err.response?.data };
  }
  res.json(out);
});

// ── Planday: payrates by group/employee ───────────────────────────────────────
app.get('/api/planday/payrates-by-group', async (_req, res) => {
  const out = {};
  try {
    const token = await getPlandayToken();
    out.token_first10 = token.slice(0, 10);

    const endpoints = [
      { key: 'employeegroup_payrates',     path: '/pay/v1/employeegroups/252005/payrates'        },
      { key: 'employee_payrates',          path: '/pay/v1/employees/1220291/payrates'             },
      { key: 'employee_payrates_by_group', path: '/pay/v1/employees/1220291/payrates/252005'      },
    ];

    for (const { key, path } of endpoints) {
      try {
        const r = await plandayGet(path, token, {});
        console.log(`[Planday payrates-by-group] ${path} → ${r.status}`);
        console.log(`[Planday payrates-by-group] ${path} body:`, JSON.stringify(r.data, null, 2));
        out[key] = { status: r.status, body: r.data };
      } catch (err) {
        console.error(`[Planday payrates-by-group] ${path} → ${err.response?.status}`);
        console.error(`[Planday payrates-by-group] ${path} body:`, JSON.stringify(err.response?.data, null, 2));
        out[key] = { status: err.response?.status, error: err.message, body: err.response?.data };
      }
    }
  } catch (err) {
    out.token_error = { error: err.message, body: err.response?.data };
  }
  res.json(out);
});

// ── Planday: individual pay rates ─────────────────────────────────────────────
app.get('/api/planday/individual-rates', async (_req, res) => {
  const out = {};
  try {
    const token = await getPlandayToken();
    out.app_id        = PLANDAY_APP_ID;
    out.token_first10 = token.slice(0, 10);

    for (const { key, path } of [
      { key: 'pay_v1_payrates',  path: '/pay/v1/payrates'  },
      { key: 'pay_v1_salaries',  path: '/pay/v1/salaries'  },
    ]) {
      try {
        const r = await plandayGet(path, token, { limit: 200, offset: 0 });
        console.log(`[Planday individual-rates] ${path} → ${r.status}`);
        console.log(`[Planday individual-rates] ${path} paging:`, JSON.stringify(r.data.paging));
        console.log(`[Planday individual-rates] ${path} data:`, JSON.stringify(r.data.data, null, 2));
        out[key] = { status: r.status, paging: r.data.paging, data: r.data.data };
      } catch (err) {
        console.error(`[Planday individual-rates] ${path} → ${err.response?.status}`);
        console.error(`[Planday individual-rates] ${path} body:`, JSON.stringify(err.response?.data, null, 2));
        out[key] = { status: err.response?.status, error: err.message, body: err.response?.data };
      }
    }
  } catch (err) {
    out.token_error = { error: err.message, body: err.response?.data };
  }
  res.json(out);
});

// ── Planday: pay access test (new credentials) ────────────────────────────────
app.get('/api/planday/pay-access', async (_req, res) => {
  const out = {};
  try {
    const token = await getPlandayToken();
    out.token_first10 = token.slice(0, 10);
    out.app_id        = PLANDAY_APP_ID;
    console.log('[Planday pay-access] app_id:', PLANDAY_APP_ID);
    console.log('[Planday pay-access] token prefix:', token.slice(0, 10));

    for (const { key, path } of [
      { key: 'pay_v1_payrates',      path: '/pay/v1/payrates'      },
      { key: 'pay_v1_employeetypes', path: '/pay/v1/employeetypes' },
    ]) {
      try {
        const r = await plandayGet(path, token, { limit: 50, offset: 0 });
        console.log(`[Planday pay-access] ${path} → ${r.status}`);
        console.log(`[Planday pay-access] ${path} body:`, JSON.stringify(r.data, null, 2));
        out[key] = { status: r.status, paging: r.data.paging, data: r.data.data };
      } catch (err) {
        console.error(`[Planday pay-access] ${path} → ${err.response?.status}`);
        console.error(`[Planday pay-access] ${path} body:`, JSON.stringify(err.response?.data, null, 2));
        out[key] = { status: err.response?.status, error: err.message, body: err.response?.data };
      }
    }
  } catch (err) {
    out.token_error = { error: err.message, body: err.response?.data };
  }
  res.json(out);
});

// ── Planday: payrates debug ────────────────────────────────────────────────────
app.get('/api/planday/payrates-debug', async (_req, res) => {
  const out = {};
  try {
    const token = await getPlandayToken();
    out.token_first10 = token.slice(0, 10);
    out.app_id        = PLANDAY_APP_ID;
    console.log('[Planday payrates-debug] token prefix:', token.slice(0, 10));
    console.log('[Planday payrates-debug] app_id:', PLANDAY_APP_ID);

    const endpoints = [
      { key: 'pay_v1_payrates',    path: '/pay/v1/payrates',    params: { limit: 200, offset: 0 } },
      { key: 'pay_v1_employees',   path: '/pay/v1/employees',   params: { limit: 200, offset: 0 } },
      { key: 'hr_v1_employees',    path: '/hr/v1/employees',    params: { limit: 200, offset: 0 } },
    ];

    for (const { key, path, params } of endpoints) {
      try {
        const r = await plandayGet(path, token, params);
        console.log(`[Planday payrates-debug] ${path} → status ${r.status}`);
        console.log(`[Planday payrates-debug] ${path} body:`, JSON.stringify(r.data, null, 2));
        out[key] = { status: r.status, paging: r.data.paging, data: r.data.data, raw: r.data };
      } catch (err) {
        console.error(`[Planday payrates-debug] ${path} → status ${err.response?.status}`);
        console.error(`[Planday payrates-debug] ${path} body:`, JSON.stringify(err.response?.data, null, 2));
        out[key] = { status: err.response?.status, error: err.message, body: err.response?.data };
      }
    }
  } catch (err) {
    out.token_error = { error: err.message, body: err.response?.data };
  }

  res.json(out);
});

// ── Planday: payrates raw ──────────────────────────────────────────────────────
app.get('/api/planday/payrates-raw', async (_req, res) => {
  const out = {};
  try {
    const token = await getPlandayToken();

    const endpoints = [
      { key: 'pay_v1_payrates',       path: '/pay/v1/payrates',       params: { limit: 10, offset: 0 } },
      { key: 'pay_v1_salaryrates',    path: '/pay/v1/salaryrates',    params: { limit: 10, offset: 0 } },
      { key: 'hr_v1_employees',       path: '/hr/v1/employees',       params: { limit: 3,  offset: 0 } },
      { key: 'payroll_v1_salaries',   path: '/payroll/v1/salaries',   params: { limit: 3,  offset: 0 } },
    ];

    for (const { key, path, params } of endpoints) {
      try {
        const r = await plandayGet(path, token, params);
        console.log(`[Planday payrates-raw] ${path} → ${r.status}`);
        console.log(`[Planday payrates-raw] ${path} body:`, JSON.stringify(r.data, null, 2));
        out[key] = { status: r.status, body: r.data };
      } catch (err) {
        console.error(`[Planday payrates-raw] ${path} → ${err.response?.status}`);
        console.error(`[Planday payrates-raw] ${path} body:`, JSON.stringify(err.response?.data, null, 2));
        out[key] = { status: err.response?.status, error: err.message, body: err.response?.data };
      }
    }
  } catch (err) {
    out.token_error = { error: err.message, body: err.response?.data };
  }

  res.json(out);
});

// ── Planday: employees raw ─────────────────────────────────────────────────────
app.get('/api/planday/employees-raw', async (_req, res) => {
  try {
    const token = await getPlandayToken();

    // Fetch first page only — could be large
    const r = await plandayGet('/hr/v1/employees', token, { limit: 5, offset: 0 });
    console.log('[Planday] employees sample:', JSON.stringify(r.data, null, 2));

    // Also try the employee contract / salary endpoints if they exist
    const extras = {};
    for (const ep of ['/hr/v1/contracts', '/hr/v1/salarytypes', '/payroll/v1/salaries']) {
      try {
        const x = await plandayGet(ep, token, { limit: 3, offset: 0 });
        extras[ep] = { status: x.status, body: x.data };
      } catch (e) {
        extras[ep] = { status: e.response?.status, error: e.message, body: e.response?.data };
      }
    }

    res.json({
      employees_paging: r.data.paging,
      employees_sample: r.data.data,
      extra_endpoints:  extras
    });
  } catch (err) {
    console.error('[Planday] employees-raw error:', err.response?.status, err.response?.data);
    res.status(err.response?.status || 500).json({ error: err.message, body: err.response?.data });
  }
});

// ── Planday: raw shifts debug ──────────────────────────────────────────────────
app.get('/api/planday/shifts-raw', async (_req, res) => {
  const out = {};
  try {
    const token = await getPlandayToken();
    out.token_preview = token.slice(0, 20) + '…';

    const date = '2026-03-25';

    // Try 1: shifts — also compute hours for each shift
    try {
      const r = await plandayGet('/scheduling/v1/shifts', token, { from: date, to: date, limit: 10, offset: 0 });
      const annotated = (r.data.data || []).map(s => ({
        ...s,
        _hours: (s.startDateTime && s.endDateTime)
          ? ((new Date(s.endDateTime) - new Date(s.startDateTime)) / 3_600_000).toFixed(2)
          : null
      }));
      out.shifts = { status: r.status, paging: r.data.paging, shifts: annotated, all_keys: annotated[0] ? Object.keys(annotated[0]) : [] };
    } catch (err) {
      out.shifts = {
        status:          err.response?.status,
        error:           err.message,
        response_body:   err.response?.data,
        request_headers: err.config?.headers,
        request_url:     err.config?.url,
        request_params:  err.config?.params
      };
    }

    // Try 2: shifttypes
    try {
      const r = await plandayGet('/scheduling/v1/shifttypes', token, { limit: 10, offset: 0 });
      out.shifttypes = { status: r.status, body: r.data };
    } catch (err) {
      out.shifttypes = {
        status:        err.response?.status,
        error:         err.message,
        response_body: err.response?.data
      };
    }

    // Try 3: schedules (alternative naming some Planday portals use)
    try {
      const r = await plandayGet('/scheduling/v1/schedules', token, { from: date, to: date, limit: 10, offset: 0 });
      out.schedules = { status: r.status, body: r.data };
    } catch (err) {
      out.schedules = {
        status:        err.response?.status,
        error:         err.message,
        response_body: err.response?.data
      };
    }

  } catch (err) {
    out.token_error = { error: err.message, body: err.response?.data };
  }

  console.log('[Planday shifts-raw]', JSON.stringify(out, null, 2));
  res.json(out);
});

// ── Planday: debug route ───────────────────────────────────────────────────────
app.get('/api/planday/debug', async (_req, res) => {
  const results = {};
  try {
    const token = await getPlandayToken();
    results.token = { ok: true, preview: token.slice(0, 20) + '…' };

    // Test 1: departments
    try {
      const r = await plandayGet('/hr/v1/departments', token, { limit: 5, offset: 0 });
      console.log('[Planday debug] departments status:', r.status);
      console.log('[Planday debug] departments body:', JSON.stringify(r.data, null, 2));
      results.departments = { status: r.status, body: r.data };
    } catch (err) {
      console.error('[Planday debug] departments FAILED:', err.response?.status, JSON.stringify(err.response?.data, null, 2));
      results.departments = { status: err.response?.status, error: err.message, body: err.response?.data };
    }

    // Test 2: shifts for today
    const today = new Date().toISOString().slice(0, 10);
    try {
      const r = await plandayGet('/scheduling/v1/shifts', token, { from: today, to: today, limit: 5, offset: 0 });
      console.log('[Planday debug] shifts status:', r.status);
      console.log('[Planday debug] shifts body:', JSON.stringify(r.data, null, 2));
      results.shifts = { status: r.status, body: r.data };
    } catch (err) {
      console.error('[Planday debug] shifts FAILED:', err.response?.status, JSON.stringify(err.response?.data, null, 2));
      results.shifts = { status: err.response?.status, error: err.message, body: err.response?.data };
    }

  } catch (err) {
    results.token = { ok: false, error: err.message, body: err.response?.data };
  }

  res.json(results);
});

// ── Planday: salary debug ──────────────────────────────────────────────────────
app.get('/api/planday/salary-debug/:from/:to', async (req, res) => {
  try {
    const token = await getPlandayToken();
    const shifts = await plandayGetAll('/scheduling/v1/shifts', token, {
      from: req.params.from,
      to:   req.params.to
    });

    // Per-shift breakdown
    const shiftRows = shifts.map(s => {
      const hours   = (s.startDateTime && s.endDateTime)
        ? (new Date(s.endDateTime) - new Date(s.startDateTime)) / 3_600_000
        : null;
      const cost    = hours != null ? hours * HOURLY_RATE : null;
      const storeId = DEPT_TO_STORE[s.departmentId] ?? null;
      return {
        shiftId:       s.id,
        employeeId:    s.employeeId,
        departmentId:  s.departmentId,
        storeId,
        startDateTime: s.startDateTime,
        endDateTime:   s.endDateTime,
        hours:         hours != null ? +hours.toFixed(4) : null,
        payRate:       HOURLY_RATE,
        cost:          cost != null ? +cost.toFixed(2) : null,
        rawShiftKeys:  Object.keys(s)
      };
    });

    // Totals per department
    const byDept = {};
    for (const row of shiftRows) {
      const key = `${row.departmentId} → ${row.storeId ?? 'UNKNOWN'}`;
      if (!byDept[key]) byDept[key] = { shiftCount: 0, totalHours: 0, totalCost: 0 };
      byDept[key].shiftCount++;
      byDept[key].totalHours = +(byDept[key].totalHours + (row.hours || 0)).toFixed(4);
      byDept[key].totalCost  = +(byDept[key].totalCost  + (row.cost  || 0)).toFixed(2);
    }

    const out = {
      summary: {
        totalShifts: shifts.length,
        hourlyRate:  HOURLY_RATE
      },
      byDepartment: byDept,
      shifts:       shiftRows
    };

    console.log('[Planday salary-debug] summary:', out.summary);
    console.log('[Planday salary-debug] by dept:', byDept);
    res.json(out);
  } catch (err) {
    console.error('[Planday salary-debug] error:', err.message, err.response?.data);
    res.status(err.response?.status || 500).json({ error: err.message, body: err.response?.data });
  }
});

// All 6 department IDs as a comma-separated string for the payroll endpoint
const ALL_DEPT_IDS = Object.keys(DEPT_TO_STORE).join(',');

// Hybrid salary calculation:
// - Salaried employees: cost comes from payroll/v1/payroll (their actual wage for the day)
// - Hourly employees (not in payroll): shifts × HOURLY_RATE
// Both groups are mapped to stores via shift departmentId
async function fetchPayrollByStore(from, to, token) {
  // Fetch payroll and shifts in parallel.
  // Payroll endpoint does NOT support limit/offset — call plandayGet directly.
  const [payrollRes, shifts] = await Promise.all([
    plandayGet('/payroll/v1/payroll', token, { departmentIds: ALL_DEPT_IDS, from, to }),
    plandayGetAll('/scheduling/v1/shifts', token, { from, to })
  ]);

  const payrollRows = payrollRes.data.data || [];
  console.log(`[Planday] payroll rows: ${payrollRows.length}, shifts: ${shifts.length}`);

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
  console.log(`[Planday] salaried employees with cost data: ${Object.keys(payrollCost).length}`);

  // Build empId → [{departmentId, hours}] from shifts
  const empShifts = {};
  for (const s of shifts) {
    const empId = s.employeeId;
    if (empId == null) continue;
    const hours = (s.startDateTime && s.endDateTime)
      ? (new Date(s.endDateTime) - new Date(s.startDateTime)) / 3_600_000
      : 0;
    if (!empShifts[empId]) empShifts[empId] = [];
    empShifts[empId].push({ departmentId: s.departmentId, hours });
  }

  const byStore = {};
  let salariedCount = 0, hourlyCount = 0, unmatchedCount = 0;

  // All employees with shifts get processed
  for (const [empId, depts] of Object.entries(empShifts)) {
    const totalHours = depts.reduce((s, d) => s + d.hours, 0);

    // Determine cost: use payroll wage if available, else hours × rate
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

  console.log(`[Planday] salaried: ${salariedCount}, hourly (${HOURLY_RATE} DKK/hr): ${hourlyCount}, unmatched depts: ${unmatchedCount}`);
  console.log('[Planday] byStore:', JSON.stringify(byStore));
  return { byStore, payrollRows, shifts };
}

// ── Planday: payroll raw debug ─────────────────────────────────────────────────
app.get('/api/planday/payroll-raw/:from/:to', async (req, res) => {
  const { from, to } = req.params;
  try {
    const token = await getPlandayToken();

    const [payrollRes, shiftsRes] = await Promise.allSettled([
      plandayGet('/payroll/v1/payroll', token, {
        departmentIds: ALL_DEPT_IDS, from, to
      }),
      plandayGet('/scheduling/v1/shifts', token, { from, to, limit: 10, offset: 0 })
    ]);

    const out = {};

    if (payrollRes.status === 'fulfilled') {
      console.log('[Planday payroll-raw] payroll status:', payrollRes.value.status);
      console.log('[Planday payroll-raw] payroll body:', JSON.stringify(payrollRes.value.data, null, 2));
      out.payroll = { status: payrollRes.value.status, body: payrollRes.value.data };
    } else {
      const err = payrollRes.reason;
      console.error('[Planday payroll-raw] payroll failed:', err.response?.status, JSON.stringify(err.response?.data, null, 2));
      out.payroll = { status: err.response?.status, error: err.message, body: err.response?.data };
    }

    if (shiftsRes.status === 'fulfilled') {
      console.log('[Planday payroll-raw] shifts status:', shiftsRes.value.status);
      console.log('[Planday payroll-raw] shifts sample:', JSON.stringify(shiftsRes.value.data, null, 2));
      out.shifts_sample = { status: shiftsRes.value.status, body: shiftsRes.value.data };
    } else {
      const err = shiftsRes.reason;
      out.shifts_sample = { status: err.response?.status, error: err.message, body: err.response?.data };
    }

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Planday: scheduled salary costs grouped by department ─────────────────────
// :from and :to are YYYY-MM-DD strings
app.get('/api/planday/salaries/:from/:to', async (req, res) => {
  const { from, to } = req.params;
  const token = await getPlandayToken();

  // Primary: payroll endpoint cross-referenced with shifts for department mapping
  try {
    const { byStore } = await fetchPayrollByStore(from, to, token);
    console.log('[Planday] salaries (payroll) result:', byStore);
    return res.json(byStore);
  } catch (err) {
    console.warn(`[Planday] payroll endpoint failed (${err.response?.status}), falling back to shift hours`);
  }

  // Fallback: shifts × fixed hourly rate
  try {
    const shifts  = await plandayGetAll('/scheduling/v1/shifts', token, { from, to });
    const byStore = {};
    let skipped   = 0;
    for (const shift of shifts) {
      const storeId = DEPT_TO_STORE[shift.departmentId];
      if (!storeId) { skipped++; continue; }
      const hours = (shift.startDateTime && shift.endDateTime)
        ? (new Date(shift.endDateTime) - new Date(shift.startDateTime)) / 3_600_000
        : 0;
      byStore[storeId] = (byStore[storeId] || 0) + Math.round(hours * HOURLY_RATE);
    }
    console.log(`[Planday] salaries (fallback ${HOURLY_RATE} DKK/hr): ${shifts.length} shifts, ${skipped} skipped, result:`, byStore);
    return res.json(byStore);
  } catch (err) {
    console.error('[Planday] salaries fallback also failed:', err.response?.status, err.message);
    return res.status(err.response?.status || 500).json({
      error:    err.message,
      upstream: err.response?.data
    });
  }
});

// ── Katering recipes ──────────────────────────────────────────────────────────

const KATERING_RECIPES_PATH = path.join(__dirname, 'data', 'katering-recipes.json');

const KATERING_RECIPES_DEFAULT = {
  hummus:    { name: 'Hummus',                  defaultPortion: 80,  batchSize: 80,    ingredients: [{ name: 'Hummus',             grams: 80   }] },
  couscous:  { name: 'Perle Cous Cous Salat',   defaultPortion: 150, batchSize: 3075,  ingredients: [{ name: 'Perle-couscous',     grams: 400  }, { name: 'Aubergine',     grams: 1200 }, { name: 'Bagte pebre',    grams: 500  }, { name: 'Persille',      grams: 40   }, { name: 'Olivenolie',    grams: 130  }, { name: 'Zaatar',        grams: 100  }, { name: 'Hvidløg',       grams: 8    }, { name: 'Honning',       grams: 6    }, { name: 'Salt',          grams: 5    }] },
  koleslaw:  { name: 'Killer Koleslaw',          defaultPortion: 100, batchSize: 1310,  ingredients: [{ name: 'Kål',               grams: 1000 }, { name: 'Æble',          grams: 260  }, { name: 'Persille',      grams: 50   }] },
  rodbeder:  { name: 'Bagte Rødbeder',           defaultPortion: 50,  batchSize: 2165,  ingredients: [{ name: 'Rødbede',           grams: 1000 }, { name: 'Olivenolie',    grams: 30   }, { name: 'Dild, frost',   grams: 100  }, { name: 'Salt',          grams: 1000 }, { name: 'Spidskommen',   grams: 5    }, { name: 'Citronsaft',    grams: 30   }] },
  labneh:    { name: 'Beetroot Labneh',          defaultPortion: 75,  batchSize: 1950,  ingredients: [{ name: 'Labneh',            grams: 1000 }, { name: 'Rødbede',       grams: 500  }, { name: 'Salt',          grams: 400  }, { name: 'Spidskommen',   grams: 50   }] },
  falafel:   { name: 'Falafel',                  defaultPortion: 100, batchSize: 8930,  ingredients: [{ name: 'Kikærter',          grams: 6000 }, { name: 'Løg',           grams: 1000 }, { name: 'Salt',          grams: 140  }, { name: 'Citronsaft',    grams: 200  }, { name: 'Persille',      grams: 1400 }, { name: 'Koriander stødt', grams: 50 }, { name: 'Cumin',         grams: 50   }, { name: 'Chili flager',  grams: 50   }, { name: 'Sodium bicarbonate', grams: 40 }] },
  harissa:   { name: 'Harissa Chili Sauce',      defaultPortion: 30,  batchSize: 10020, ingredients: [{ name: 'Flåede tomater',    grams: 5000 }, { name: 'Tomatkoncentrat', grams: 1760 }, { name: 'Olivenolie',  grams: 1600 }, { name: 'Friske chili',  grams: 1000 }, { name: 'Garam masala',  grams: 100  }, { name: 'Tørret chili',  grams: 500  }, { name: 'Salt',          grams: 60   }] },
  flatbread: { name: 'Fladbrød',                 defaultPortion: 1,   batchSize: 1,     ingredients: [{ name: 'Fladbrød',          grams: 1    }] },
  lam:       { name: 'Lammekød (tilvalg)',        defaultPortion: 80,  batchSize: 80,    ingredients: [{ name: 'Lammebov',          grams: 80   }] },
  kylling:   { name: 'Kyllingekød (tilvalg)',     defaultPortion: 80,  batchSize: 80,    ingredients: [{ name: 'Kyllingelår',       grams: 80   }] },
  lemonade:  { name: 'Killer Lemonade (tilvalg)', defaultPortion: 1,   batchSize: 36,    ingredients: [{ name: 'Citronjuice',       grams: 1000 }, { name: 'Limejuice',     grams: 1000 }, { name: 'Sukker',        grams: 1550 }, { name: 'Citron til skal', grams: 3000 }] }
};

app.get('/api/katering-recipes', (_req, res) => {
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

app.post('/api/katering-recipes', (req, res) => {
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

// ── Lemonade tracking ─────────────────────────────────────────────────────────
const LEMONADE_HISTORY_PATH = path.join(__dirname, 'data', 'lemonade-history.json');

function cphDateStr() {
  return new Date().toLocaleDateString('sv', { timeZone: 'Europe/Copenhagen' });
}

function cphMidnightTs() {
  const s    = new Date().toLocaleDateString('sv', { timeZone: 'Europe/Copenhagen' });
  const [y, mo, dy] = s.split('-').map(Number);
  const noonUTC = Date.UTC(y, mo - 1, dy, 12, 0, 0);
  const noonCPH = new Date(noonUTC).toLocaleString('sv', { timeZone: 'Europe/Copenhagen' });
  const off     = parseInt(noonCPH.slice(11, 13), 10) - 12;
  return (Date.UTC(y, mo - 1, dy) - off * 3600000) / 1000;
}

async function fetchLemonadeToday() {
  const midnight = cphMidnightTs();
  const results  = await Promise.allSettled(
    Object.entries(STORES).map(async ([id, store]) => {
      const r     = await posGet(`/exportSales/v20/${midnight}`, store);
      const items = r.data.data || [];
      const count = items.filter(i => (i.productname || '').toLowerCase().includes('lemonade')).length;
      return { id, count };
    })
  );
  const stores = {};
  let total = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') { stores[r.value.id] = r.value.count; total += r.value.count; }
    else console.warn('[lemonade] fetch error:', r.reason?.message);
  }
  return { date: cphDateStr(), stores, total };
}

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

app.get('/api/lemonade/history', (_req, res) => {
  res.json(loadLemonadeHistory());
});

app.post('/api/lemonade/history', (req, res) => {
  try {
    saveLemonadeHistory(req.body);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/lemonade/today', async (_req, res) => {
  try {
    const data = await fetchLemonadeToday();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Scheduled save at 22:00 Copenhagen time
let lemonadeSavedDate = null;
setInterval(() => {
  const cph  = new Date().toLocaleString('sv', { timeZone: 'Europe/Copenhagen' });
  const hour = parseInt(cph.slice(11, 13), 10);
  const min  = parseInt(cph.slice(14, 16), 10);
  const date = cph.slice(0, 10);
  if (hour < 22) return;
  if (lemonadeSavedDate === date) return;
  lemonadeSavedDate = date;
  (async () => {
    try {
      const data    = await fetchLemonadeToday();
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

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(3000, () => {
  console.log('\n  🔪  KILLER KALCULATOR');
  console.log('  ──────────────────────────────');
  console.log('  http://localhost:3000\n');
});
