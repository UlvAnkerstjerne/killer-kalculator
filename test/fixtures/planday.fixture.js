'use strict';
// Entirely synthetic. Identifiers are fixture-local, never copied from Planday.
const { DEPARTMENTS } = require('../../lib/planday-payroll');
function fixture() {
  const hourly = { id: 1, employeeId: 'fixture-hourly', departmentId: 149700, employeeGroupId: 1,
    date: '2026-09-22', start: '2026-09-22T10:00:00', end: '2026-09-22T18:00:00',
    salary: 1200, wage: { type: 'Hourly', rate: 150 }, supplements: [], breaks: [], salaryCode: 'fixture-code' };
  return { payroll: { shiftsPayroll: [hourly], supplementsPayroll: [], salariedPayroll: [], currencySymbol: 'kr.' },
    approved: { shiftsPayroll: [structuredClone(hourly)], supplementsPayroll: [], salariedPayroll: [], currencySymbol: 'kr.' },
    shifts: [{ id: 1, employeeId: hourly.employeeId, departmentId: hourly.departmentId, date: hourly.date,
      startDateTime: hourly.start, endDateTime: hourly.end, status: 'Approved', timeZone: 'Europe/Copenhagen' }],
    departments: Object.keys(DEPARTMENTS).map(id => ({ id: Number(id) })), allocations: new Map() };
}
function addSalary(f, { employeeId = 'fixture-hourly', amount = 1000, weights = null } = {}) {
  f.payroll.salariedPayroll.push({ employeeId, salary: amount, salaryCode: 'fixture-salary', date: '2026-09-22', start: '2026-09-22', end: '2026-09-22' });
  f.allocations.set(employeeId, [{ validFrom: '2026-01-01', costAllocation: weights ? 'BusinessDays' : 'ScheduledHours',
    departmentDistributions: weights ? weights.map(x => ({ department: { id: x.departmentId }, departmentWeight: x.weight })) : [] }]);
  return f;
}
module.exports = { fixture, addSalary };
