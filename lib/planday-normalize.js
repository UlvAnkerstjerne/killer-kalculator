'use strict';
const { DEPARTMENTS, nextDate, midnight, localInstant, splitOre, reconstructHourly, safeCode, storeForDepartment } = require('./planday-payroll');
const OMIT = new Set(['Open', 'Draft', 'Cancelled', 'Deleted']);
function normalizePayroll({ payroll, approved, shifts, departments, allocations }, window) {
  const records = [], failures = [], warnings = new Set();
  const fail = (code, departmentId) => failures.push({ code: safeCode(code), departmentId });
  function unique(rows, signature) {
    const out = new Map();
    for (const row of rows) {
      if (row.id === undefined) { fail('INVALID_SCHEMA', row.departmentId); continue; }
      if (out.has(row.id) && signature(out.get(row.id)) !== signature(row)) fail('CONFLICTING_DUPLICATE', row.departmentId);
      else out.set(row.id, row);
    }
    return out;
  }
  if (!Array.isArray(departments) || Object.keys(DEPARTMENTS).some(id => !departments.some(d => String(d.id) === id))) fail('MAPPING_UNAVAILABLE');
  if (!payroll || !approved || ['shiftsPayroll', 'salariedPayroll', 'supplementsPayroll'].some(k => !Array.isArray(payroll[k]) || !Array.isArray(approved[k])) || !Array.isArray(shifts)) {
    fail('INVALID_SCHEMA'); return { records, failures, warnings: [] };
  }
  // Live tenant returns kr. No conversion is attempted for another currency.
  if (!['kr.', 'kr', 'DKK'].includes(payroll.currencySymbol)) fail('CURRENCY_UNVERIFIED');
  const shiftKey = r => JSON.stringify([r.departmentId, r.employeeId, r.startDateTime, r.endDateTime, r.status, r.timeZone]);
  const schedule = unique(shifts, shiftKey);
  const payKey = r => JSON.stringify([r.departmentId, r.employeeId, r.start, r.end, r.salary, r.wage, r.breaks, r.supplements]);
  const pays = unique(payroll.shiftsPayroll, payKey);
  const approvedPays = unique(approved.shiftsPayroll, payKey);
  const parsed = [];
  for (const p of pays.values()) {
    try {
      const s = schedule.get(p.id);
      if (!s || s.employeeId !== p.employeeId || s.departmentId !== p.departmentId || OMIT.has(s.status)) { fail('SOURCE_COVERAGE_INCOMPLETE', p.departmentId); continue; }
      if (s.timeZone !== 'Europe/Copenhagen') throw new Error('AMBIGUOUS_LOCAL_TIME');
      const start = localInstant(p.start), end = localInstant(p.end);
      if (!(end > start) || !Number.isFinite(p.salary)) throw new Error('MISSING_PAY_DATA');
      const isApproved = approvedPays.has(p.id);
      if (isApproved && payKey(approvedPays.get(p.id)) !== payKey(p)) throw new Error('CONFLICTING_DUPLICATE');
      const source = isApproved ? 'actual' : 'scheduled';
      if (!isApproved && start < window.until && end > window.from) warnings.add('UNAPPROVED_SHIFTS');
      if (!Array.isArray(p.breaks) || !Array.isArray(p.supplements)) throw new Error('INVALID_SCHEMA');
      if (p.breaks.length || p.supplements.length) throw new Error('UNVERIFIED_BREAK_OR_SUPPLEMENT');
      const row = { id: 'shift:' + p.id, departmentId: p.departmentId, start, end, amount: p.salary, component: 'hourly', source };
      // Only reconstruct a clipped shift when its complete arithmetic reconciles
      // to payroll. Nested break/supplement records were absent in the live audit;
      // they fail closed above until their total and timing semantics are verified.
      if (p.wage?.type === 'Hourly' && Number.isFinite(p.wage.rate) && !p.breaks.length && !p.supplements.length) {
        const hourly = { start, end, rates: [{ start, end, rate: p.wage.rate }], breaks: [] };
        if (Math.abs(reconstructHourly(hourly) - p.salary) <= 0.011) row.hourly = hourly;
      }
      if (p.salary === 0 && !Number.isFinite(p.wage?.rate)) throw new Error('MISSING_PAY_DATA');
      records.push(row); parsed.push({ ...row, employeeId: p.employeeId, date: p.date });
    } catch (err) { fail(err.message, p.departmentId); }
  }
  for (const s of schedule.values()) {
    if (OMIT.has(s.status)) continue;
    try {
      const start = localInstant(s.startDateTime), end = localInstant(s.endDateTime);
      if (end <= window.from || start >= window.until) continue;
      if (!storeForDepartment(s.departmentId)) { fail('UNKNOWN_DEPARTMENT'); continue; }
      if (!pays.has(s.id) && !payroll.salariedPayroll.some(p => p.employeeId === s.employeeId && p.start <= s.date && s.date <= p.end)) fail('SOURCE_COVERAGE_INCOMPLETE', s.departmentId);
      if (!pays.has(s.id) && s.employeeId) parsed.push({ employeeId: s.employeeId, departmentId: s.departmentId, start, end, date: s.date });
    } catch (err) { fail(err.message, s.departmentId); }
  }
  function weightsFor(employeeId, from, until) {
    const byDepartment = new Map();
    for (const s of parsed) if (s.employeeId === employeeId) {
      const hours = Math.max(0, Math.min(until, s.end) - Math.max(from, s.start));
      if (hours) byDepartment.set(s.departmentId, (byDepartment.get(s.departmentId) || 0) + hours);
    }
    return [...byDepartment].map(([departmentId, weight]) => ({ departmentId, weight }));
  }
  function addAllocated(id, amount, weights, start, end, component, source, prorate) {
    for (const [i, part] of splitOre(Math.round(amount * 100), weights).entries()) records.push({
      id: id + ':' + i, departmentId: part.departmentId, amount: part.amountOre / 100,
      start, end, component, source, ...(prorate ? { prorate } : {}),
    });
  }
  // Period supplements have no stable instance ID. Do not deduplicate by value:
  // two equal deductions can be legitimate. The unpaged payroll document is
  // ingested exactly once; index is only a private, document-local identity.
  for (const [i, p] of payroll.supplementsPayroll.entries()) {
    try {
      const start = localInstant(p.start), end = localInstant(p.end);
      if (end <= window.from || start >= window.until) continue;
      const weights = weightsFor(p.employeeId, start, end);
      if (!weights.length || !Number.isFinite(p.salary)) throw new Error('UNALLOCATED_ADJUSTMENT');
      // Live daily adjustments have a midnight-to-midnight interval and no
      // department. Allocate their signed amount across that employee's shifts
      // on the day, then accrue each share over elapsed shift time. This is an
      // explicit estimate, not a claim about Planday's deduction trigger time.
      if (start !== midnight(p.start.slice(0, 10)) || end !== midnight(nextDate(p.start.slice(0, 10)))) throw new Error('CUTOFF_UNSUPPORTED');
      const matched = parsed.filter(s => s.employeeId === p.employeeId && s.start < end && s.end > start);
      const totalDuration = matched.reduce((sum, s) => sum + Math.min(s.end, end) - Math.max(s.start, start), 0);
      const elapsed = matched.map((s, j) => ({ departmentId: j,
        weight: Math.max(0, Math.min(s.end, end, window.until) - Math.max(s.start, start, window.from)) }));
      const elapsedDuration = elapsed.reduce((sum, s) => sum + s.weight, 0);
      if (elapsedDuration > 0) {
        const accruedOre = Math.round(Math.round(p.salary * 100) * elapsedDuration / totalDuration);
        const portions = splitOre(accruedOre, elapsed.filter(s => s.weight > 0));
        for (const part of portions) {
          const shift = matched[part.departmentId];
          records.push({ id: 'adjustment:' + i + ':' + part.departmentId, departmentId: shift.departmentId,
            amount: part.amountOre / 100, start: Math.max(shift.start, start, window.from), end: Math.min(shift.end, end, window.until),
            component: p.salary < 0 ? 'adjustments' : 'supplements', source: 'estimated' });
        }
      }
      warnings.add('ADJUSTMENT_ALLOCATION_ESTIMATE');
    } catch (err) { fail(err.message); }
  }
  const salaryRecords = new Map();
  for (const p of payroll.salariedPayroll) {
    const key = JSON.stringify([p.employeeId, p.salaryCode, p.start, p.end, p.date]);
    const previous = salaryRecords.get(key);
    if (previous && previous.salary !== p.salary) fail('CONFLICTING_DUPLICATE');
    else salaryRecords.set(key, p);
  }
  for (const [i, p] of [...salaryRecords.values()].entries()) {
    try {
      if (!Number.isFinite(p.salary) || !p.employeeId) throw new Error('MISSING_PAY_DATA');
      const start = midnight(p.start), end = midnight(nextDate(p.end));
      if (end <= window.from || start >= window.until) continue;
      const history = allocations.get(p.employeeId);
      if (!Array.isArray(history) || !history.length) throw new Error('ALLOCATION_HISTORY_UNAVAILABLE');
      const weightsFromShifts = weightsFor(p.employeeId, start, end);
      const days = (Date.parse(nextDate(p.end)) - Date.parse(p.start)) / 86400000;
      if (!(days > 0 && days <= 367)) throw new Error('INVALID_SCHEMA');
      // Payroll's period salary is calendar-prorated. Preserve that total; use
      // configured department weights when explicit, otherwise the existing
      // shift-hours sharing rule. Never infer a contracted-hour divisor.
      for (let date = p.start; date <= p.end; date = nextDate(date)) {
        const dayStart = midnight(date), dayEnd = midnight(nextDate(date));
        if (dayEnd <= window.from || dayStart >= window.until) continue;
        const candidates = history.filter(h => h.validFrom <= date && (!h.validTo || h.validTo >= date)).sort((a, b) => b.validFrom.localeCompare(a.validFrom));
        if (!candidates.length) throw new Error('ALLOCATION_HISTORY_UNAVAILABLE');
        if (candidates.length > 1 && candidates[0].validFrom === candidates[1].validFrom) throw new Error('CONFLICTING_DUPLICATE');
        const h = candidates[0];
        let weights = h.departmentDistributions?.map(d => ({ departmentId: d.department?.id, weight: d.departmentWeight > 0 ? d.departmentWeight : Object.values(d.weekDaysWeight || {}).reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0) }));
        if (!weights?.length) weights = weightsFromShifts;
        if (!weights.length) throw new Error('UNALLOCATED_SALARY');
        if (weights.some(w => !storeForDepartment(w.departmentId))) throw new Error('UNKNOWN_DEPARTMENT');
        // Daily remainder allocation prevents monthly multiplication and makes
        // the sum of all daily salary allocations equal the original period.
        const dayIndex = (Date.parse(date) - Date.parse(p.start)) / 86400000;
        const totalOre = Math.round(p.salary * 100);
        const dailyOre = Math.round(totalOre * (dayIndex + 1) / days) - Math.round(totalOre * dayIndex / days);
        const clippedStart = Math.max(window.from, dayStart), clippedEnd = Math.min(window.until, dayEnd);
        const accruedOre = Math.round(dailyOre * (clippedEnd - clippedStart) / (dayEnd - dayStart));
        addAllocated('salary:' + i + ':' + date, accruedOre / 100, weights, clippedStart, clippedEnd, 'salaried', 'estimated');
      }
      warnings.add('SALARY_ALLOCATION_ESTIMATE');
    } catch (err) { fail(err.message); }
  }
  return { records, failures, warnings: [...warnings] };
}
module.exports = { normalizePayroll };
