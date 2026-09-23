'use strict';
const { period, nextDate, cphDate, processPayroll, DEPARTMENTS } = require('./planday-payroll');
const { normalizePayroll } = require('./planday-normalize');

function createPayrollService({ client, now = Date.now, maxEntries = 64, maxPending = 16 }) {
  const cache = new Map(), pending = new Map();
  async function fetchPayroll(window) {
    try {
      // Include the previous start date to catch overnight shifts. Payroll date
      // parameters are inclusive; the public API's end is exclusive.
      const from = nextDate(window.start, -1);
      const to = cphDate(Math.max(window.from, window.until - 1));
      const params = { from, to, departmentIds: Object.keys(DEPARTMENTS).join(','), returnFullSalaryForMonthlyPaid: false };
      const calls = await Promise.allSettled([
        client.all('/hr/v1/departments'),
        client.all('/scheduling/v1/shifts', { from, to }),
        client.get('/payroll/v1/payroll', params),
        client.get('/payroll/v1/payroll', { ...params, shiftStatus: 'Approved' }),
      ]);
      const failed = calls.find(call => call.status === 'rejected');
      if (failed) throw failed.reason;
      const [departments, shifts, payroll, approved] = calls.map(call => call.value);
      const allocations = new Map();
      const employees = [...new Set((Array.isArray(payroll?.salariedPayroll) ? payroll.salariedPayroll : []).map(r => r.employeeId))];
      // Bound secondary calls. No employee IDs or raw objects leave this scope.
      for (let offset = 0; offset < employees.length; offset += 3) {
        const batch = await Promise.allSettled(employees.slice(offset, offset + 3).map(async id => {
          const body = await client.get('/pay/v1/salaries/scheduling/timeandcost/allocations/' + encodeURIComponent(id) + '/history', { from, to });
          if (!Array.isArray(body?.data)) throw new Error('INVALID_SCHEMA');
          allocations.set(id, body.data);
        }));
        const failure = batch.find(call => call.status === 'rejected');
        if (failure) throw failure.reason;
      }
      return processPayroll(normalizePayroll({ payroll, approved, shifts, departments, allocations }, window), window);
    } catch (err) {
      return processPayroll({ failures: [{ code: err.code || 'UPSTREAM_UNAVAILABLE' }] }, window);
    }
  }
  async function get(args) {
    const window = period(args, now());
    const key = [window.start, window.end, window.cutoff].join(':');
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) {
      cache.delete(key); cache.set(key, hit); return { ...hit.result, meta: { cacheAgeMs: Math.max(0, now() - hit.startedAt) } };
    }
    cache.delete(key);
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= maxPending) return processPayroll({ failures: [{ code: 'UPSTREAM_UNAVAILABLE' }] }, window);
    const promise = (async () => {
      const startedAt = now();
      try {
        const result = await fetchPayroll(window);
        if (result.chain.complete) {
          const ttl = window.active ? 10 * 60000 : 6 * 3600000;
          cache.set(key, { result, startedAt, expiresAt: startedAt + ttl });
          while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        }
        return { ...result, meta: { cacheAgeMs: Math.max(0, now() - startedAt) } };
      } finally { pending.delete(key); }
    })();
    pending.set(key, promise);
    return promise;
  }
  return { get, sizes: () => ({ cache: cache.size, pending: pending.size }) };
}
module.exports = { createPayrollService };
