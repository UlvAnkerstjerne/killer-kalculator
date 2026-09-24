'use strict';
const { nextDate, midnight, localInstant, cphDate, storeForDepartment, safeCode, dateValid } = require('./planday-payroll');
const OMIT = new Set(['Open', 'Draft', 'Cancelled', 'Deleted']);
const HOUR = 3600000;
const WORKING = new Set(['Assigned', 'Approved', 'ForSale', 'OnDuty', 'PendingSwapAcceptance', 'PendingApproval', 'PunchclockStarted', 'PunchclockFinished', 'PunchclockApproved']);
// Build a union, split at Copenhagen midnight. Same-location overlaps count
// once; conflicting locations cannot be resolved by inventing a percentage.
function union(rows, from, until) {
  const clipped = rows.map(s => ({ ...s, start: Math.max(from, s.start), end: Math.min(until, s.end) })).filter(s => s.end > s.start);
  const points = new Set(clipped.flatMap(s => [s.start, s.end]));
  for (let date = cphDate(from); midnight(date) < until; date = nextDate(date)) points.add(midnight(date));
  const sorted = [...points].filter(t => t >= from && t <= until).sort((a, b) => a - b), out = [];
  for (let i = 1; i < sorted.length; i++) {
    const start = sorted[i - 1], end = sorted[i];
    const active = clipped.filter(s => s.start <= start && s.end >= end);
    const ids = [...new Set(active.map(s => s.departmentId))];
    if (ids.length > 1) throw new Error('OVERLAPPING_WORK');
    if (ids.length) {
      const actual = active.some(s => s.source === 'actual');
      out.push({ start, end, departmentId: ids[0], source: actual ? 'actual' : 'estimated',
        fallbackKeys: actual ? [] : [...new Set(active.flatMap(s => s.fallbackKeys || []))] });
    }
  }
  return out;
}
function normalizeConfirmed(input, window, standard) {
  const hours = [], estimatedDepartments = new Set();
  const failures = [], warnings = new Set(), storeWarnings = [], extra = [];
  const coverage = { attendanceRequired: 0, attendanceMatched: 0, attendanceMissing: 0,
    attendanceUnapproved: 0, attendanceInvalid: 0, sickLeaveExcluded: 0 };
  const reconciliation = { excludedOverheadOre: 0, expectedSalaryOre: 0, allocatedSalaryOre: 0,
    outsideSalaryOre: 0, reconciledMonths: 0, blockedMonths: 0 };
  const fail = (code, departmentId) => failures.push({ code: safeCode(code), departmentId });
  const knownDepartments = new Set(input.departments.map(d => d.id));
  const absenceTypes = input.absenceTypes || input.sickTypes;
  const outside = id => knownDepartments.has(id) && !storeForDepartment(id);
  const salaryRows = (input.monthly || []).flatMap(m => (m?.payroll.salariedPayroll || []).map(p => ({ p, month: m })));
  const ruleFor = s => {
    const rule = input.workerRules.resolve(s.employeeId), date = s.date || s.start?.slice(0, 10);
    return rule && date >= rule.from && salaryRows.some(({ p }) => p.employeeId === s.employeeId && p.start <= date && p.end >= date) ? rule : undefined;
  };
  const absenceExclusions = new Set(), monetaryAbsences = new Set(input.shifts.filter(s =>
    absenceTypes?.has(input.shiftDetails?.get(s.id)?.shiftTypeId)).map(s => s.id));
  for (const s of new Map(input.shifts.map(s => [s.id, s])).values()) {
    if (OMIT.has(s.status) || !storeForDepartment(s.departmentId) || input.payroll.shiftsPayroll.some(p => p.id === s.id)) continue;
    if (!input.sickTypes?.has(input.shiftDetails?.get(s.id)?.shiftTypeId)) continue;
    try {
      const start = localInstant(s.startDateTime), end = localInstant(s.endDateTime);
      if (start >= window.until || end <= window.from) continue;
      absenceExclusions.add(s.id);
      // Monthly managed salaries and central actual-work rates are handled below.
      const managed = ruleFor(s);
      const values = input.timeCosts?.get(s.departmentId)?.filter(c => c.shiftId === s.id && c.employeeId === s.employeeId);
      const distinct = [...new Map((values || []).map(c => [JSON.stringify([c.cost, c.date, c.duration, c.shiftTypeId]), c])).values()];
      if (distinct.length > 1) { fail('CONFLICTING_DUPLICATE', s.departmentId); continue; }
      const monetary = distinct[0];
      if (monetary && Number.isFinite(monetary.cost) && monetary.date === s.date &&
          monetary.shiftTypeId === input.shiftDetails.get(s.id).shiftTypeId) {
        if (!managed) extra.push({ id: 'absence:' + s.id, departmentId: s.departmentId, start, end,
          amount: monetary.cost, source: 'scheduled', component: 'hourly' });
      } else {
        storeWarnings.push({ code: 'SICK_LEAVE_WITHOUT_MONETARY_PAY', departmentId: s.departmentId }); coverage.sickLeaveExcluded++;
      }
    } catch (err) { fail(err.message, s.departmentId); }
  }
  const normalized = standard({ ...input, outsideDepartment: outside, absenceExclusions, monetaryAbsences,
    ignoreShift: s => !!ruleFor(s), skipSalaryAllocation: p => !input.workerRules.resolve(p.employeeId) || p.end >= input.workerRules.resolve(p.employeeId).from }, window);
  const hourlyByEmployee = new Map();
  for (const p of new Map(input.payroll.shiftsPayroll.filter(p => !ruleFor(p)).map(p => [p.id, p])).values()) {
    try {
      const start = Math.max(localInstant(p.start), window.from), end = Math.min(localInstant(p.end), window.until);
      if (end <= start) continue;
      if (!hourlyByEmployee.has(p.employeeId)) hourlyByEmployee.set(p.employeeId, []);
      hourlyByEmployee.get(p.employeeId).push({ start, end, departmentId: p.departmentId });
    } catch (err) { fail(err.message, p.departmentId); }
  }
  for (const rows of hourlyByEmployee.values()) {
    let active = [];
    for (const row of rows.sort((a, b) => a.start - b.start)) {
      active = active.filter(a => a.end > row.start);
      for (const prior of active) { fail('OVERLAPPING_WORK', prior.departmentId); fail('OVERLAPPING_WORK', row.departmentId); }
      active.push(row);
    }
  }
  if (!input.workerRules.valid && salaryRows.length) fail('WORKER_RULE_CONFIGURATION');
  if (!input.monthly?.length || input.monthly.some(m => !m)) fail('SALARY_MONTH_UNAVAILABLE');
  const uniqueSchedules = new Map();
  for (const s of [...input.allocationShifts, ...input.shifts]) {
    const previous = uniqueSchedules.get(s.id);
    if (previous && ['employeeId', 'departmentId', 'date', 'timeZone', 'startDateTime', 'endDateTime', 'status', 'shiftTypeId'].some(k => (previous[k] ?? null) !== (s[k] ?? null))) fail('CONFLICTING_DUPLICATE', s.departmentId);
    else uniqueSchedules.set(s.id, s);
  }
  const allSchedules = [...uniqueSchedules.values()].filter(s => !OMIT.has(s.status));
  function punchedOverlap(s, from, until) {
    return (input.attendance || []).some(a => {
      if (a.shiftId !== s.id || a.isApproved !== true) return false;
      try { return localInstant(a.startDateTime) < until && localInstant(a.endDateTime) > from; } catch { return false; }
    });
  }
  const uniqueSalaries = new Map();
  for (const row of salaryRows) {
    const key = JSON.stringify([row.p.employeeId, row.month.from]);
    const prev = uniqueSalaries.get(key);
    if (prev && JSON.stringify(prev.p) !== JSON.stringify(row.p)) { fail('CONFLICTING_DUPLICATE'); continue; }
    uniqueSalaries.set(key, row);
  }
  function selectedHours(s) {
    coverage.attendanceRequired++;
    if (!s.employeeId || !knownDepartments.has(s.departmentId) || !dateValid(s.date) || s.timeZone !== 'Europe/Copenhagen' || !WORKING.has(s.status)) throw new Error('ACTUAL_HOURS_MISSING');
    const detail = input.shiftDetails?.get(s.id);
    if (!detail) throw new Error('SHIFT_TYPE_UNAVAILABLE');
    if (detail.shiftTypeId != null && !input.workingTypes?.has(detail.shiftTypeId)) {
      if (absenceTypes?.has(detail.shiftTypeId)) return [];
      throw new Error('SHIFT_TYPE_UNAVAILABLE');
    }
    const manual = (input.monthly || []).flatMap(m => m?.payroll.shiftsPayroll || []).filter(p => p.id === s.id);
    if (manual.some(p => !Array.isArray(p.breaks) || p.breaks.some(b => !(b.duration === 0 && b.amount === 0)))) throw new Error('UNVERIFIED_BREAK_OR_SUPPLEMENT');
    const matches = (input.attendance || []).filter(a => a.shiftId === s.id);
    const unique = [...new Map(matches.map(a => [a.id, a])).values()];
    if (unique.length > 1 || (unique.length && matches.some(a => JSON.stringify(a) !== JSON.stringify(unique[0])))) throw new Error('ATTENDANCE_CONFLICT');
    const a = unique[0];
    if (a && (a.employeeId !== s.employeeId || a.departmentId !== s.departmentId)) throw new Error('ATTENDANCE_CONFLICT');
    let worked;
    if (!a) coverage.attendanceMissing++;
    else if (a.isApproved !== true) coverage.attendanceUnapproved++;
    else {
      try {
        const start = localInstant(a.startDateTime), end = localInstant(a.endDateTime);
        if (!(end > start) || end > input.evaluatedAt) throw new Error();
        const breaks = input.attendanceBreaks?.get(a.id);
        if (!Array.isArray(breaks)) throw new Error();
        const intervals = breaks.map(b => ({ start: localInstant(b.startDateTime), end: localInstant(b.endDateTime) }));
        if (intervals.some(b => !(b.end > b.start) || b.start < start || b.end > end)) throw new Error();
        const points = [...new Set([start, end, ...intervals.flatMap(b => [b.start, b.end])])].sort((a, b) => a - b);
        worked = [];
        for (let i = 1; i < points.length; i++) if (!intervals.some(b => b.start <= points[i - 1] && b.end >= points[i])) {
          worked.push({ start: points[i - 1], end: points[i], departmentId: s.departmentId, source: 'actual', fallbackKeys: [] });
        }
        coverage.attendanceMatched++;
      } catch { coverage.attendanceInvalid++; }
    }
    if (worked) return worked;
    // Missing, open, partial or unapproved punches do not defeat a verified
    // working schedule. Only that schedule is used, never a fabricated rate.
    try {
      const start = localInstant(s.startDateTime), end = localInstant(s.endDateTime);
      if (!(end > start) || cphDate(start) !== s.date) throw new Error();
      return [{ start, end, departmentId: s.departmentId, source: 'estimated', fallbackKeys: [s.id] }];
    } catch { throw new Error('ACTUAL_HOURS_MISSING'); }
  }
  function collectHours(parts, from, until) {
    for (const s of union(parts, from, until)) if (storeForDepartment(s.departmentId)) hours.push(s);
  }
  // Ordinary hourly wages keep their authoritative monetary Payroll amount.
  // Their independently selected working hours have the same safe provenance
  // as the hours used for central costs and monthly salary allocations.
  const ordinary = new Map();
  for (const s of allSchedules) if (!ruleFor(s) && storeForDepartment(s.departmentId) && input.payroll.shiftsPayroll.some(p => p.id === s.id) &&
      !monetaryAbsences.has(s.id)) {
    try {
      let scheduledOutside = false;
      try { scheduledOutside = localInstant(s.startDateTime) >= window.until || localInstant(s.endDateTime) <= window.from; } catch { /* approved punches can still be usable */ }
      if (scheduledOutside && !punchedOverlap(s, window.from, window.until)) continue;
      const parts = selectedHours(s);
      if (!ordinary.has(s.employeeId)) ordinary.set(s.employeeId, []);
      ordinary.get(s.employeeId).push(...parts);
    } catch (err) { fail(err.message, s.departmentId); }
  }
  for (const parts of ordinary.values()) {
    try { collectHours(parts, window.from, window.until); }
    catch (err) { for (const id of new Set(parts.map(s => s.departmentId))) fail(err.message, id); }
  }
  for (const [index, { p, month }] of [...uniqueSalaries.values()].entries()) {
    const rule = input.workerRules.resolve(p.employeeId);
    if (!rule) { fail(input.workerRules.valid ? 'WORKER_RULE_UNAVAILABLE' : 'WORKER_RULE_CONFIGURATION'); continue; }
    if (p.end < rule.from) continue; // Preserve dated provider allocation before the authorized rule.
    const monthFrom = midnight(month.from), monthUntil = midnight(nextDate(month.to));
    const own = allSchedules.filter(s => s.employeeId === p.employeeId &&
      (s.date >= month.from && s.date <= month.to || punchedOverlap(s, monthFrom, monthUntil) ||
        (() => { try { return localInstant(s.startDateTime) < monthUntil && localInstant(s.endDateTime) > monthFrom; } catch { return false; } })()));
    const targets = rule.kind === 'home' ? [rule.departmentId] : [...new Set(own.filter(s => storeForDepartment(s.departmentId)).map(s => s.departmentId))];
    const failSalary = code => targets.length ? targets.forEach(id => fail(code, id)) : fail(code);
    try {
      if (!Number.isFinite(p.salary) || !['central', 'home', 'regional'].includes(rule.kind) || p.start < month.from || p.end > month.to || p.start < rule.from) throw new Error('SALARY_MONTH_UNAVAILABLE');
      if (!input.allocationCoverage || input.allocationCoverage.from > month.from || input.allocationCoverage.end < nextDate(month.to)) throw new Error('SALARY_HOURS_UNAVAILABLE');
      const agreementFrom = Math.max(monthFrom, midnight(p.start)), agreementUntil = Math.min(monthUntil, midnight(nextDate(p.end)));
      const completed = monthUntil <= input.evaluatedAt;
      const work = []; let invalid = false;
      for (const s of own) {
        let start, end;
        try { start = localInstant(s.startDateTime); end = localInstant(s.endDateTime); } catch { start = midnight(s.date); end = midnight(nextDate(s.date)); }
        if ((end <= agreementFrom || start >= agreementUntil) && !punchedOverlap(s, agreementFrom, agreementUntil)) continue;
        const actualOverlaps = punchedOverlap(s, window.from, window.until);
        if (rule.kind === 'central' && (!storeForDepartment(s.departmentId) || (!actualOverlaps && (start >= window.until || end <= window.from)))) continue;
        try {
          if (!knownDepartments.has(s.departmentId)) throw new Error('UNKNOWN_DEPARTMENT');
          const detail = input.shiftDetails?.get(s.id);
          if (!detail) throw new Error('SHIFT_TYPE_UNAVAILABLE');
          if (detail.shiftTypeId !== null && !input.sickTypes) throw new Error('SHIFT_TYPE_UNAVAILABLE');
          if (absenceTypes?.has(detail.shiftTypeId)) continue;
          const parts = selectedHours(s);
          work.push(...parts.map(part => ({ ...part, departmentId: rule.kind === 'home' ? rule.departmentId : part.departmentId })));
        } catch (err) {
          invalid = true;
          if (rule.kind === 'central') fail(err.message, s.departmentId);
          else failSalary(err.message);
        }
      }
      // Attendance without a matching scheduled identity must not disappear from
      // the monthly denominator, or inflate a central worker's apparent zero.
      for (const a of input.attendance || []) if (a.employeeId === p.employeeId && !own.some(s => s.id === a.shiftId) && a.startDateTime &&
          localInstant(a.startDateTime) < agreementUntil && (!a.endDateTime || localInstant(a.endDateTime) > agreementFrom)) {
        if (rule.kind !== 'central' || (storeForDepartment(a.departmentId) && localInstant(a.startDateTime) < window.until &&
            (!a.endDateTime || localInstant(a.endDateTime) > window.from))) { invalid = true; failSalary('ATTENDANCE_CONFLICT'); }
      }
      if (rule.kind === 'central') {
        reconciliation.excludedOverheadOre += Math.round(p.salary * 100);
        const portions = union(work, Math.max(agreementFrom, window.from), Math.min(agreementUntil, window.until));
        hours.push(...portions);
        for (const [i, s] of portions.entries()) extra.push({ ...s, id: 'central:' + index + ':' + i,
          amount: (s.end - s.start) / HOUR * 225, component: 'hourly' });
        continue;
      }
      if (invalid) { reconciliation.blockedMonths++; continue; }
      const portions = union(work, agreementFrom, agreementUntil), duration = portions.reduce((n, s) => n + s.end - s.start, 0);
      if (!(duration > 0)) throw new Error('ACTUAL_HOURS_MISSING');
      const fallback = portions.some(s => s.source === 'estimated');
      collectHours(portions, window.from, window.until);
      if (fallback) for (const id of targets) { estimatedDepartments.add(id); storeWarnings.push({ code: 'SCHEDULED_HOURS_FALLBACK', departmentId: id }); }
      const totalOre = Math.round(p.salary * 100); let elapsed = 0;
      reconciliation.expectedSalaryOre += totalOre;
      for (const [i, s] of portions.entries()) {
        const weight = s.end - s.start;
        const fullOre = Math.round(totalOre * (elapsed + weight) / duration) - Math.round(totalOre * elapsed / duration);
        reconciliation.allocatedSalaryOre += fullOre;
        if (outside(s.departmentId)) reconciliation.outsideSalaryOre += fullOre;
        const start = Math.max(s.start, window.from), end = Math.min(s.end, window.until);
        if (end > start && storeForDepartment(s.departmentId)) extra.push({ id: 'salary-hours:' + index + ':' + i,
          departmentId: s.departmentId, start, end, component: 'salaried', source: completed && !fallback ? 'actual' : 'estimated',
          amount: (Math.round(totalOre * (elapsed + end - s.start) / duration) - Math.round(totalOre * (elapsed + start - s.start) / duration)) / 100 });
        elapsed += weight;
      }
      reconciliation.reconciledMonths++;
      if (!completed || fallback) {
        warnings.add('SALARY_ALLOCATION_ESTIMATE');
        if (window.until > window.from) for (const departmentId of targets) extra.push({ id: 'salary-estimate:' + index + ':' + departmentId,
          departmentId, start: window.from, end: window.until, amount: 0, component: 'salaried', source: 'estimated' });
      }
    } catch (err) { reconciliation.blockedMonths++; failSalary(err.message); }
  }
  return { records: [...normalized.records, ...extra], failures: [...normalized.failures, ...failures],
    warnings: [...new Set([...normalized.warnings, ...warnings])], storeWarnings, coverage, reconciliation, hours, estimatedDepartments: [...estimatedDepartments] };
}
module.exports = { normalizeConfirmed, union };
