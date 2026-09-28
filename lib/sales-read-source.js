'use strict';
// Default path does not even load pg or database/catalogue modules.
function createSalesReadSource(env = process.env) {
  const source = env.KK_SALES_READ_SOURCE || 'onlinepos';
  if (!['onlinepos','database'].includes(source)) throw new Error('INVALID_SALES_READ_SOURCE');
  if (source === 'onlinepos') return null;
  let url;
  try { url = new URL(env.KK_SALES_READ_DB_URL); } catch { throw new Error('INVALID_SALES_READ_CONFIG'); }
  if (!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2 || url.hash) throw new Error('INVALID_SALES_READ_CONFIG');
  const { createDatabase } = require('./sales-db/database');
  const { createDashboardReader } = require('./sales-db/dashboard');
  return createDashboardReader(createDatabase({ enabled: true, connectionString: env.KK_SALES_READ_DB_URL }));
}
module.exports = { createSalesReadSource };
