'use strict';
const { fail } = require('./errors');

// This module is deliberately not imported by the web server.
function readConfig(env = process.env) {
  if (env.KK_SALES_DB_ENABLED === undefined || env.KK_SALES_DB_ENABLED === 'false') {
    return Object.freeze({ enabled: false });
  }
  if (env.KK_SALES_DB_ENABLED !== 'true') fail('INVALID_CONFIG');
  let url;
  try { url = new URL(env.KK_SALES_DB_URL); } catch { fail('INVALID_CONFIG'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname ||
      url.pathname.length < 2 || url.hash) fail('INVALID_CONFIG');
  return Object.freeze({ enabled: true, connectionString: env.KK_SALES_DB_URL });
}
module.exports = { readConfig };
