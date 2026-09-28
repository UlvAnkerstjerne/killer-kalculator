'use strict';
const { STORES, date, cphLocal } = require('../sales-db/values');
const { readConfig } = require('../sales-db/config');
const { createIdentity } = require('../sales-db/identity');
const { loadCatalog } = require('./catalog');
const { createHttpRequest } = require('../sales-sync/http');
const { fail } = require('../sales-sync/errors');
const MAX_DAYS = 7;

function nextDate(value) {
  date(value);
  // Calendar arithmetic on a date label, not 24 hours after a Copenhagen instant.
  const day = new Date(value + 'T00:00:00Z');
  day.setUTCDate(day.getUTCDate() + 1);
  return date(day.toISOString().slice(0, 10));
}
function validateScope(input, now = new Date()) {
  try {
    const today = date(cphLocal(now.getTime()).slice(0, 10));
    const stores = input.stores;
    if (!Array.isArray(stores) || !stores.length || stores.length > 6 ||
        new Set(stores).size !== stores.length || stores.some(s => !STORES.includes(s))) fail('INVALID_OPTIONS');
    const start = input.start === undefined ? null : date(input.start);
    const end = input.end === undefined ? today : date(input.end);
    const maxDays = input.maxDays === undefined ? 1 : input.maxDays;
    if (end > today || (start !== null && start >= end) || !Number.isInteger(maxDays) || maxDays < 1 || maxDays > MAX_DAYS) fail('INVALID_OPTIONS');
    return Object.freeze({ stores: Object.freeze(STORES.filter(s => stores.includes(s))), start, end, maxDays, today });
  } catch { fail('INVALID_OPTIONS'); }
}
function parseArgs(args) {
  const values = {}, flags = new Set(['--apply', '--plan', '--dry-run', '--help']);
  const valued = new Set(['--store', '--stores', '--from', '--through', '--max-days']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (Object.hasOwn(values, arg) || (!flags.has(arg) && !valued.has(arg))) fail('INVALID_OPTIONS');
    if (flags.has(arg)) values[arg] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail('INVALID_OPTIONS');
      values[arg] = value;
    }
  }
  if ((values['--store'] && values['--stores']) ||
      ['--apply', '--plan', '--dry-run'].filter(k => values[k]).length > 1) fail('INVALID_OPTIONS');
  return values;
}
function readOptions(values, env, now) {
  if (![undefined, 'false', 'true'].includes(env.KK_SALES_SYNC_ENABLED)) fail('INVALID_CONFIG');
  const apply = values['--apply'] === true, enabled = env.KK_SALES_SYNC_ENABLED === 'true';
  // Disabled apply does not even inspect database credentials or construct HTTP.
  if (apply && !enabled) return { apply, enabled };
  const maximum = values['--max-days'] ?? env.KK_SALES_SYNC_MAX_DAYS ?? '1';
  if (!/^[1-7]$/.test(maximum)) fail('INVALID_OPTIONS');
  const selection = values['--store'] ?? values['--stores'] ?? env.KK_SALES_SYNC_STORES;
  const scope = validateScope({ stores: typeof selection === 'string' ? selection.split(',') : [],
    start: values['--from'] ?? env.KK_SALES_SYNC_FROM,
    end: values['--through'], maxDays: Number(maximum) }, now);
  return { apply, enabled, scope };
}
function readRuntime(options, env) {
  const config = readConfig(env);
  if (!config.enabled) fail('DB_DISABLED');
  if (!options.apply) return { config };
  if (!/^[a-fA-F0-9]{64}$/.test(env.KK_SALES_IDENTITY_KEY_HEX || '') ||
      !/^[1-9]\d{0,4}$/.test(env.KK_SALES_IDENTITY_KEY_VERSION || '') || Number(env.KK_SALES_IDENTITY_KEY_VERSION) > 32767) fail('INVALID_IDENTITY');
  const identity = createIdentity({ key: Buffer.from(env.KK_SALES_IDENTITY_KEY_HEX, 'hex'), version: Number(env.KK_SALES_IDENTITY_KEY_VERSION) });
  const credentials = new Map();
  for (const store of options.scope.stores) {
    const suffix = store.toUpperCase().replaceAll('-', '_');
    const credential = Object.freeze({ token: env['KK_SYNC_TOKEN_' + suffix], companyId: env['KK_SYNC_COMPANY_ID_' + suffix] });
    // This factory only validates/builds a closure; it performs no request.
    createHttpRequest(credential);
    credentials.set(store, credential);
  }
  return { config, context: { identity, catalog: loadCatalog() }, credentials };
}
module.exports = { MAX_DAYS, nextDate, validateScope, parseArgs, readOptions, readRuntime, loadCatalog };
