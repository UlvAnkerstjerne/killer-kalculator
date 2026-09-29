'use strict';
const { selectSalesRead } = require('./sales-read-policy');

// Reuse the dashboard's whole-range policy. Database errors remain errors;
// only an explicit coverage miss permits a background provider fetch.
function createWarmingSelector(reader, today) {
  if (!reader) return async () => ({ source: 'onlinepos' });
  if (reader.policy !== 'covered-history') return async () => ({ source: 'database' });
  const coverageReader = { policy: reader.policy, read: args => reader.coverage(args) };
  return ({ storeId, start, end }) => selectSalesRead(coverageReader,
    { storeSlug: storeId, start, end, today });
}

module.exports = { createWarmingSelector };
