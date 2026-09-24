'use strict';
const { period, nextDate, cphDate, processPayroll, DEPARTMENTS } = require('./planday-payroll');
const { normalizePayroll } = require('./planday-normalize');

// Fetch monetary documents per calendar month. The provider's salary proration
// can depend on the first month in a query; the overnight lookup must not change
// the salary interval. This server-only loader is also used by reconciliation.
async function loadPayrollSources({ client, window, now = Date.now, workerRules }) {
  const from = window.start;
  const to = cphDate(Math.max(window.from, window.until - 1));
  const segments = [];
  for (let start = from; start <= to;) {
    const end = nextDate(start.slice(0, 7) + '-28', 4).slice(0, 7) + '-01';
    segments.push({ from: start, to: to < end ? to : nextDate(end, -1) });
    start = end;
  }
  async function documents(ranges) {
    const all = [], approved = [];
    for (let offset = 0; offset < ranges.length; offset += 3) {
      const calls = await Promise.allSettled(ranges.slice(offset, offset + 3).map(async range => {
        const params = { ...range, departmentIds: Object.keys(DEPARTMENTS).join(','), returnFullSalaryForMonthlyPaid: false };
        const pair = await Promise.allSettled([client.get('/payroll/v1/payroll', params), client.get('/payroll/v1/payroll', { ...params, shiftStatus: 'Approved' })]);
        const failed = pair.find(x => x.status === 'rejected'); if (failed) throw failed.reason;
        return pair.map(x => x.value);
      }));
      const failed = calls.find(x => x.status === 'rejected'); if (failed) throw failed.reason;
      for (const call of calls) { all.push(call.value[0]); approved.push(call.value[1]); }
    }
    function combine(rows) {
      if (rows.some(r => !r || ['shiftsPayroll', 'salariedPayroll', 'supplementsPayroll'].some(k => !Array.isArray(r[k])))) throw new Error('INVALID_SCHEMA');
      return { currencySymbol: rows.every(r => r.currencySymbol === rows[0].currencySymbol) ? rows[0].currencySymbol : null,
        shiftsPayroll: rows.flatMap(r => r.shiftsPayroll), salariedPayroll: rows.flatMap(r => r.salariedPayroll), supplementsPayroll: rows.flatMap(r => r.supplementsPayroll) };
    }
    return [combine(all), combine(approved)];
  }
  const calls = await Promise.allSettled([
    client.all('/hr/v1/departments', {}, 50),
    client.all('/scheduling/v1/shifts', { from: nextDate(from, -1), to }),
    documents(segments),
  ]);
  const failed = calls.find(x => x.status === 'rejected'); if (failed) throw failed.reason;
  const [departments, shifts, [payroll, approved]] = calls.map(x => x.value);
  const { localInstant, storeForDepartment } = require('./planday-payroll');
  const crossing = shifts.filter(s => storeForDepartment(s.departmentId) && s.date < from &&
    !['Open', 'Draft', 'Cancelled', 'Deleted'].includes(s.status) && localInstant(s.endDateTime) > window.from);
  if (crossing.length) {
    const ids = new Set(crossing.map(s => s.id));
    const extra = await documents([{ from: nextDate(from, -1), to: nextDate(from, -1) }]);
    for (const [i, target] of [payroll, approved].entries()) target.shiftsPayroll.push(...extra[i].shiftsPayroll.filter(s => ids.has(s.id)));
  }
  const allocations = new Map(), memberships = new Map();
  let allocationShifts = shifts, allocationCoverage;
  const employees = [...new Set((Array.isArray(payroll?.salariedPayroll) ? payroll.salariedPayroll : []).map(r => r.employeeId))];
  if (employees.length || workerRules) {
    const monthStart = window.start.slice(0, 7) + '-01';
    const monthEnd = nextDate(to.slice(0, 7) + '-28', 4).slice(0, 7) + '-01';
    try {
      allocationShifts = await client.all('/scheduling/v1/shifts', { from: workerRules ? nextDate(monthStart, -1) : monthStart, to: nextDate(monthEnd, -1) });
      allocationCoverage = { from: monthStart, end: monthEnd };
    } catch (err) {
      // Retain the independently verified period schedule. Confirmed home
      // salaries can use calendar weights; other policies require full coverage.
      if (!workerRules) throw err;
    }
  }
  // Bound secondary calls. Project profiles immediately; personal fields are
  // neither retained in aggregates nor cached. Membership is only a fallback.
  for (let offset = 0; offset < employees.length; offset += 3) {
    const batch = await Promise.allSettled(employees.slice(offset, offset + 3).map(async id => {
      const body = await client.get('/pay/v1/salaries/scheduling/timeandcost/allocations/' + encodeURIComponent(id) + '/history', { from, to });
      if (!Array.isArray(body?.data)) throw new Error('INVALID_SCHEMA');
      allocations.set(id, body.data);
      if (body.data.every(h => h.departmentDistributions?.length)) return;
      try {
        const { data: profile } = await client.get('/hr/v1/employees/' + encodeURIComponent(id));
        if (!Array.isArray(profile?.departments) || profile.departments.length !== 1) return;
        let validFrom = profile.hiredFrom || profile.hiredDate;
        if (typeof validFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) return;
        if (typeof profile.dateTimeModified !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(profile.dateTimeModified)) return;
        if (profile.dateTimeModified >= window.start) {
          const changes = await client.all('/hr/v1/employees/' + encodeURIComponent(id) + '/history',
            { startDateTime: window.start, endDateTime: nextDate(cphDate(now())) }, 50);
          if (changes.some(h => /department/i.test(h.path))) return;
        }
        memberships.set(id, { departmentIds: profile.departments, validFrom, validTo: profile.deactivationDate || undefined });
      } catch { /* Unproven membership cannot override an allocation rule. */ }
    }));
    const failure = batch.find(call => call.status === 'rejected');
    if (failure) throw failure.reason;
  }
  const input = { payroll, approved, shifts, departments, allocations, memberships, allocationShifts, allocationCoverage };
  return workerRules ? require('./planday-attendance').loadAttendance({ client, input, window, workerRules, now }) : input;
}

function createPayrollService({ client, now = Date.now, maxEntries = 64, maxPending = 16, workerRules }) {
  const cache = new Map(), pending = new Map();
  async function fetchPayroll(window) {
    try {
      return processPayroll(normalizePayroll(await loadPayrollSources({ client, window, now, workerRules }), window), window);
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
          // A completed day/week in the current calendar month still depends
          // on the editable full-month schedule. Reconcile at month close.
          const currentMonth = cphDate(now()).slice(0, 7);
          const revisable = window.active || cphDate(window.until - 1).slice(0, 7) >= currentMonth;
          const ttl = revisable ? 10 * 60000 : 6 * 3600000;
          const nextMonth = nextDate(currentMonth + '-28', 4).slice(0, 7) + '-01';
          cache.set(key, { result, startedAt, expiresAt: Math.min(startedAt + ttl, require('./planday-payroll').midnight(nextMonth)) });
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
module.exports = { createPayrollService, loadPayrollSources };
