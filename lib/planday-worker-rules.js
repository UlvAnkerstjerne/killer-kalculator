'use strict';
const { createHmac, timingSafeEqual } = require('node:crypto');
const registry = require('./planday-worker-rules.json');
// Domain-separated keyed digests prevent enumeration of Planday's numeric IDs.
// The existing server secret stays in memory; neither IDs nor the key are stored.
function digest(secret, value) {
  return createHmac('sha256', secret).update('kk/payroll-policy/v1\0' + value).digest('hex');
}
function createWorkerRules(secret, configuration = registry) {
  const tag = typeof secret === 'string' && secret.length ? digest(secret, 'key-check') : '';
  const expected = configuration.keyCheck;
  const valid = typeof expected === 'string' && tag.length === expected.length &&
    timingSafeEqual(Buffer.from(tag), Buffer.from(expected));
  const policies = new Map(configuration.policies.map(p => [p.token, Object.freeze({
    kind: p.kind, from: p.from, ...(p.departmentId ? { departmentId: p.departmentId } : {}),
  })]));
  return Object.freeze({ valid, resolve: employeeId => valid ? policies.get(digest(secret, String(employeeId))) : undefined });
}
module.exports = { createWorkerRules, digest };
