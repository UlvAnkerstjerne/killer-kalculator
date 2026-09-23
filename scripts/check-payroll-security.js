'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixture, addSalary } = require('../test/fixtures/planday.fixture');
const { normalizePayroll } = require('../lib/planday-normalize');
const { processPayroll, period } = require('../lib/planday-payroll');
const root = path.join(__dirname, '..');
const f = addSalary(fixture());
function inspect(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, v] of Object.entries(value)) {
    if (/employeeId/i.test(key)) assert.match(String(v), /^fixture-/);
    assert.ok(!/email|phone|address|password|access_token|refresh_token/i.test(key), 'unexpected sensitive fixture field');
    inspect(v);
  }
}
inspect(f);
const codeFiles = ['lib/planday-client.js', 'lib/planday-service.js', 'lib/planday-normalize.js', 'lib/planday-payroll.js'];
for (const file of codeFiles) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  assert.ok(!/console\.(?:log|warn|error)\s*\(/.test(text), 'payroll source must not log upstream values');
  assert.ok(!/\.response\?*\.data|JSON\.stringify\(err/.test(text), 'raw upstream errors must not escape');
}
const w = period({ start: '2026-09-22', end: '2026-09-23' }, Date.parse('2026-09-24T12:00:00Z'));
const publicJson = JSON.stringify(processPayroll(normalizePayroll(f, w), w));
assert.ok(!/employeeId|shiftId|fixture-|salaryCode|wage|Authorization|headers/.test(publicJson));
console.log('PASS: synthetic fixture identities, aggregate response allowlist, no payroll credential/error logging');
