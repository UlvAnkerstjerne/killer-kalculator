'use strict';

// Uses the actual server cache configuration. No listener or provider requests.
// node scripts/simulate-production-cache-admission.js
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const app = require('../server');
const { simulateProductionAdmission } = require('../test/helpers/production-cache-admission');
const cache = app.locals.salesRangeCache;
try {
  const report = simulateProductionAdmission(cache);
  assert.equal(report.maxBytes, 48 * 1024 * 1024);
  assert.equal(report.maxEntries, 120);
  assert.equal(report.entries, 30);
  assert.equal(report.estimatedBytes, 41_767_495);
  assert.equal(report.headroomBytes, 8_564_153);
  assert.equal(report.allLastMonthAdmitted, true);
  assert.equal(report.currentEntriesRetained, true);
  console.log(JSON.stringify(report, null, 2));
} finally {
  cache.clear();
}
