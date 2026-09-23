'use strict';
const { DEPARTMENTS, nextDate, midnight, localInstant, splitOre, reconstructHourly, safeCode, storeForDepartment, excludedDepartment, cphDate } = require('./planday-payroll');
const OMIT = new Set(['Open', 'Draft', 'Cancelled', 'Deleted']);
function normalizePayroll({ payroll, approved, shifts, departments, allocations, memberships = new Map(), allocationShifts = shifts, allocationCoverage }, window) {
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
  if (!payroll || !approved || ['shiftsPayroll', 'salariedPayroll', 'supplementsPayroll'].some(k => !Array.isArray(payroll[k]) || !Array.isArray(approved[k])) || !Array.isArray(shifts) || !Array.isArray(allocationShifts)) {
    fail('INVALID_SCHEMA'); return { records, failures, warnings: [] };
  }
  // Live tenant returns kr. No conversion is attempted for another currency.
  if (!['kr.', 'kr', 'DKK'].includes(payroll.currencySymbol)) fail('CURRENCY_UNVERIFIED');
  const salariedEmployees = new Set(payroll.salariedPayroll.map(r => r.employeeId));
  const adjustedEmployees = new Set(payroll.supplementsPayroll.map(r => r.employeeId));
  const shiftKey = r => JSON.stringify([r.departmentId, r.employeeId, r.startDateTime, r.endDateTime, r.status, r.timeZone]);
  const schedule = unique(shifts.filter(s => !excludedDepartment(s.departmentId) || salariedEmployees.has(s.employeeId) || adjustedEmployees.has(s.employeeId)), shiftKey);
  const payKey = r => JSON.stringify([r.departmentId, r.employeeId, r.start, r.end, r.salary, r.wage, r.breaks, r.supplements]);
  const pays = unique(payroll.shiftsPayroll.filter(s => !excludedDepartment(s.departmentId)), payKey);
  const approvedPays = unique(approved.shiftsPayroll.filter(s => !excludedDepartment(s.departmentId)), payKey);
  const parsed = [];
  const salarySchedule = [];
  for (const p of pays.values()) {
    try {
      const start = localInstant(p.start), end = localInstant(p.end);
      if (end <= window.from || start >= window.until) continue;
      const s = schedule.get(p.id);
      if (!s || s.employeeId !== p.employeeId || s.departmentId !== p.departmentId || OMIT.has(s.status)) { fail('SOURCE_COVERAGE_INCOMPLETE', p.departmentId); continue; }
      if (s.timeZone !== 'Europe/Copenhagen') throw new Error('AMBIGUOUS_LOCAL_TIME');
      if (!(end > start) || !Number.isFinite(p.salary)) throw new Error('MISSING_PAY_DATA');
      const isApproved = approvedPays.has(p.id);
      if (isApproved && payKey(approvedPays.get(p.id)) !== payKey(p)) throw new Error('CONFLICTING_DUPLICATE');
      const source = isApproved ? 'actual' : 'scheduled';
      if (!isApproved && start < window.until && end > window.from) warnings.add('UNAPPROVED_SHIFTS');
      if (!Array.isArray(p.breaks) || !Array.isArray(p.supplements)) throw new Error('INVALID_SCHEMA');
      // Zero-duration/zero-value details cannot change the amount. Unknown or
      // nonzero nested arithmetic remains unsupported; never add it twice.
      const hasBreakCost = p.breaks.some(b => !(b.duration === 0 && b.amount === 0));
      const hasSupplementCost = p.supplements.some(s => !(Number.isFinite(s.duration) && Number.isFinite(s.modification) && s.duration * s.modification === 0));
      if (hasBreakCost || hasSupplementCost) throw new Error('UNVERIFIED_BREAK_OR_SUPPLEMENT');
      const row = { id: 'shift:' + p.id, departmentId: p.departmentId, start, end, amount: p.salary, component: 'hourly', source };
      // Only reconstruct a clipped shift when its complete arithmetic reconciles
      // to payroll. Nested break/supplement records were absent in the live audit;
      // they fail closed above until their total and timing semantics are verified.
      if (p.wage?.type === 'Hourly' && Number.isFinite(p.wage.rate) && !hasBreakCost && !hasSupplementCost) {
        const hourly = { start, end, rates: [{ start, end, rate: p.wage.rate }], breaks: [] };
        if (Math.abs(reconstructHourly(hourly) - p.salary) <= 0.011) row.hourly = hourly;
      }
      if (p.salary === 0 && !Number.isFinite(p.wage?.rate)) throw new Error('MISSING_PAY_DATA');
      records.push(row);
    } catch (err) { fail(err.message, p.departmentId); }
  }
  for (const s of schedule.values()) {
    if (OMIT.has(s.status)) continue;
    try {
      const pay = pays.get(s.id);
      const start = localInstant(pay?.start || s.startDateTime), end = localInstant(pay?.end || s.endDateTime);
      if (adjustedEmployees.has(s.employeeId)) parsed.push({ employeeId: s.employeeId, departmentId: s.departmentId, start, end, date: s.date });
      if (end <= window.from || start >= window.until) continue;
      if (excludedDepartment(s.departmentId)) continue;
      if (!storeForDepartment(s.departmentId)) { fail('UNKNOWN_DEPARTMENT'); continue; }
      if (!pays.has(s.id) && !payroll.salariedPayroll.some(p => p.employeeId === s.employeeId && p.start <= s.date && s.date <= p.end)) fail('SOURCE_COVERAGE_INCOMPLETE', s.departmentId);
    } catch (err) { fail(err.message, s.departmentId); }
  }
  // Use complete month schedules for salary sharing, including independently
  // scoped operations. Their shares must not be redistributed to the six stores.
  const invalidSalarySchedule = new Set(), unknownSalaryScope = new Set();
  for (const s of unique(allocationShifts.filter(s => salariedEmployees.has(s.employeeId)), shiftKey).values()) {
    if (OMIT.has(s.status) || !salariedEmployees.has(s.employeeId)) continue;
    try {
      if (s.timeZone !== 'Europe/Copenhagen') throw new Error();
      const start = localInstant(s.startDateTime), end = localInstant(s.endDateTime);
      if (!storeForDepartment(s.departmentId) && !excludedDepartment(s.departmentId)) { unknownSalaryScope.add(s.employeeId); throw new Error(); }
      if (!(end > start)) throw new Error();
      salarySchedule.push({ employeeId: s.employeeId, departmentId: s.departmentId, start, end });
    } catch { invalidSalarySchedule.add(s.employeeId); }
  }
  function weightsFor(employeeId, from, until, source = parsed) {
    const byDepartment = new Map();
    for (const s of source) if (s.employeeId === employeeId) {
      const hours = Math.max(0, Math.min(until, s.end) - Math.max(from, s.start));
      if (hours) byDepartment.set(s.departmentId, (byDepartment.get(s.departmentId) || 0) + hours);
    }
    return [...byDepartment].map(([departmentId, weight]) => ({ departmentId, weight }));
  }
  function salaryWeights(employeeId, from, until, monthlyAmount) {
    const shifts = salarySchedule.filter(s => s.employeeId === employeeId && s.start < until && s.end > from);
    const points = [...new Set(shifts.flatMap(s => [Math.max(from, s.start), Math.min(until, s.end)]))].sort((a, b) => a - b);
    const weights = new Map(); let overlap = 0, duration = 0;
    for (let i = 1; i < points.length; i++) {
      const start = points[i - 1], end = points[i], active = shifts.filter(s => s.start <= start && s.end >= end);
      if (!active.length) continue;
      const departments = [...new Set(active.map(s => s.departmentId))];
      duration += end - start;
      if (active.length > 1) overlap += end - start;
      for (const id of departments) weights.set(id, (weights.get(id) || 0) + (end - start) / departments.length);
    }
    // Scheduling has minute precision. A single overlapping minute is shared
    // equally, only when its conservative monthly allocation bound is <= 5 DKK.
    // This is a labelled estimate; larger conflicts remain incomplete.
    if (overlap > 60000 || (overlap && Math.abs(monthlyAmount) * overlap / duration > 5)) throw new Error('SALARY_HOURS_UNAVAILABLE');
    if (overlap) warnings.add('MINUTE_OVERLAP_ESTIMATE');
    return [...weights].map(([departmentId, weight]) => ({ departmentId, weight }));
  }
  function addAllocated(id, amount, weights, start, end, component, source, prorate) {
    for (const [i, part] of splitOre(Math.round(amount * 100), weights).entries()) {
      if (excludedDepartment(part.departmentId)) continue;
      records.push({
        id: id + ':' + i, departmentId: part.departmentId, amount: part.amountOre / 100,
        start, end, component, source, ...(prorate ? { prorate } : {}),
      });
    }
  }
  // Period supplements have no stable instance ID. Do not deduplicate by value:
  // two equal deductions can be legitimate. The unpaged payroll document is
  // ingested exactly once; index is only a private, document-local identity.
  for (const [i, p] of payroll.supplementsPayroll.entries()) {
    try {
      const start = localInstant(p.start), end = localInstant(p.end);
      if (end <= window.from || start >= window.until) continue;
      const weights = weightsFor(p.employeeId, start, end);
      if (p.salary === 0) continue;
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
          if (excludedDepartment(shift.departmentId)) continue;
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
      if (p.salary === 0) continue;
      const history = allocations.get(p.employeeId);
      if (!Array.isArray(history) || !history.length) throw new Error('ALLOCATION_HISTORY_UNAVAILABLE');
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
        const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(date + 'T12:00:00Z').getUTCDay()];
        const distributions = h.departmentDistributions || [];
        const weekdayTotal = distributions.reduce((n, d) => n + (d.weekDaysWeight?.[weekday] || 0), 0);
        let weights = distributions.map(d => ({ departmentId: d.department?.id,
          weight: d.departmentWeight > 0 ? d.departmentWeight : weekdayTotal > 0 ? (d.weekDaysWeight?.[weekday] || 0)
            : Object.values(d.weekDaysWeight || {}).reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0) }));
        if (!weights.length) {
          const membership = memberships.get(p.employeeId);
          // Current access to many departments is not a salary allocation rule.
          // A sole assignment is usable only when verified for this date range.
          if (membership?.validFrom <= date && (!membership.validTo || date <= membership.validTo) && membership.departmentIds?.length === 1) {
            weights = [{ departmentId: membership.departmentIds[0], weight: 1 }];
          } else {
            if (h.costAllocation === 'NoAllocation') throw new Error('SALARY_SCOPE_UNDECIDED');
            if (!['ScheduledHours', 'MonthlySalary'].includes(h.costAllocation)) throw new Error('UNALLOCATED_SALARY');
            const monthStart = date.slice(0, 7) + '-01';
            const monthEnd = nextDate(date.slice(0, 7) + '-28', 4).slice(0, 7) + '-01';
            // Tests/adapters may supply an explicitly bounded period schedule;
            // the live service always supplies the complete calendar month.
            const from = allocationCoverage ? monthStart : cphDate(Math.max(window.from, start));
            const until = allocationCoverage ? monthEnd : cphDate(Math.min(window.fullEnd, end));
            if (invalidSalarySchedule.has(p.employeeId) || (allocationCoverage && (allocationCoverage.from > monthStart || allocationCoverage.end < monthEnd))) throw new Error('SALARY_HOURS_UNAVAILABLE');
            const nextRule = history.map(rule => rule.validFrom).filter(value => value > date).sort()[0];
            const effectiveEnd = [until, h.validTo && nextDate(h.validTo), nextRule].filter(Boolean).sort()[0];
            weights = salaryWeights(p.employeeId, midnight(from > h.validFrom ? from : h.validFrom), midnight(effectiveEnd),
              p.salary / days * ((Date.parse(monthEnd) - Date.parse(monthStart)) / 86400000));
            if (!weights.length) throw new Error('SALARY_HOURS_UNAVAILABLE');
          }
        }
        weights = weights.filter(w => w.weight !== 0);
        if (weights.some(w => !storeForDepartment(w.departmentId) && !excludedDepartment(w.departmentId))) throw new Error('UNKNOWN_DEPARTMENT');
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
    } catch (err) {
      const targets = [...new Set(salarySchedule.filter(s => s.employeeId === p.employeeId && storeForDepartment(s.departmentId)).map(s => s.departmentId))];
      if (err.message === 'SALARY_HOURS_UNAVAILABLE' && targets.length && !unknownSalaryScope.has(p.employeeId)) targets.forEach(id => fail(err.message, id));
      else fail(err.message);
    }
  }
  return { records, failures, warnings: [...warnings] };
}
module.exports = { normalizePayroll };
