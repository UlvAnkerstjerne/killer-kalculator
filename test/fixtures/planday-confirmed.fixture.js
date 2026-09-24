'use strict';
const { fixture } = require('./planday.fixture');
const { createWorkerRules, digest } = require('../../lib/planday-worker-rules');
const { nextDate } = require('../../lib/planday-payroll');
function confirmedFixture({ kind = 'home', month = '2026-08', from = '2025-01-01', amount = 1000.01 } = {}) {
  const f = fixture(), employeeId = 'fixture-managed', secret = 'fixture-only-policy-key';
  f.payroll.shiftsPayroll = []; f.approved.shiftsPayroll = [];
  f.departments.push({ id: 149750 }, { id: 149683 }, { id: 999 });
  const end = nextDate(month + '-28', 4).slice(0, 7) + '-01';
  const salary = { employeeId, start: month + '-01', end: nextDate(end, -1), salary: amount, salaryCode: 'fixture-salary' };
  f.payroll.salariedPayroll = [salary];
  f.shifts = [2, 3].map((day, i) => ({ id: 'fixture-shift-' + i, employeeId, departmentId: i ? 149750 : 149748,
    date: month + '-0' + day, startDateTime: month + '-0' + day + 'T10:00:00', endDateTime: month + '-0' + day + 'T14:00:00',
    status: 'Approved', timeZone: 'Europe/Copenhagen' }));
  f.allocationShifts = f.shifts;
  f.allocationCoverage = { from: month + '-01', end };
  f.monthly = [{ from: month + '-01', to: nextDate(end, -1), payroll: structuredClone(f.payroll) }];
  f.workerRules = createWorkerRules(secret, { keyCheck: digest(secret, 'key-check'), policies: [{ token: digest(secret, employeeId), kind, from,
    ...(kind === 'home' ? { departmentId: 149748 } : {}) }] });
  f.evaluatedAt = Date.parse('2026-09-24T12:00:00Z');
  f.attendance = f.shifts.map((s, i) => ({ id: 'fixture-clock-' + i, shiftId: s.id, employeeId, departmentId: s.departmentId,
    startDateTime: s.startDateTime, endDateTime: s.endDateTime, isApproved: true }));
  f.attendanceBreaks = new Map(f.attendance.map(a => [a.id, []]));
  f.shiftDetails = new Map(f.shifts.map(s => [s.id, { shiftTypeId: null }]));
  f.sickTypes = new Set(['fixture-sickness']); f.timeCosts = new Map();
  return f;
}
module.exports = { confirmedFixture };
