'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { confirmedFixture } = require('./fixtures/planday-confirmed.fixture');
const { fixture } = require('./fixtures/planday.fixture');
const p = require('../lib/planday-payroll');
const { normalizePayroll } = require('../lib/planday-normalize');
const { createWorkerRules, digest } = require('../lib/planday-worker-rules');
const { loadPayrollSources, createPayrollService } = require('../lib/planday-service');
const windowFor = (f, args = {}) => p.period({ start: f.monthly[0].from, end: p.nextDate(f.monthly.at(-1).to), ...args }, f.evaluatedAt);
const calc = (f, args) => { const w = windowFor(f, args), n = normalizePayroll(f, w); return { n, r: p.processPayroll(n, w) }; };
test('home salary includes Office hours, conserves every øre and uses actual clock times', () => {
  const f = confirmedFixture(); f.attendance[0].endDateTime = '2026-08-02T12:00:00';
  const { n, r } = calc(f); assert.equal(r.stores.christianshavn.cost, 1000.01); assert.equal(r.chain.source, 'actual');
  assert.equal(n.reconciliation.allocatedSalaryOre, n.reconciliation.expectedSalaryOre);
  const first = calc(f, { start: '2026-08-02', end: '2026-08-03' }).r.chain.cost;
  const second = calc(f, { start: '2026-08-03', end: '2026-08-04' }).r.chain.cost;
  assert.equal(first, 333.34); assert.equal(second, 666.67); assert.equal(first + second, 1000.01);
});
test('regional allocation conserves complete salary including a newly verified outside department', () => {
  const f = confirmedFixture({ kind: 'regional' }); f.shifts[1].departmentId = 999; f.attendance[1].departmentId = 999;
  const { n, r } = calc(f); assert.equal(r.chain.cost, 500.01); assert.equal(n.reconciliation.outsideSalaryOre, 50000);
  assert.equal(n.reconciliation.allocatedSalaryOre, 100001);
});
test('active calendar month uses approved punches ahead of schedules in its denominator', () => {
  const f = confirmedFixture({ month: '2026-09' }); f.attendance[0].endDateTime = '2026-09-02T11:00:00';
  const { r } = calc(f, { start: '2026-09-02', end: '2026-09-03' }); assert.equal(r.chain.cost, 200); assert.equal(r.chain.source, 'estimated');
  f.evaluatedAt = Date.parse('2026-10-01T01:00Z');
  const actual = calc(f, { start: '2026-09-02', end: '2026-09-03' }).r; assert.equal(actual.chain.cost, 200); assert.equal(actual.chain.source, 'actual');
});
test('active salary clips at Copenhagen cutoff, future hours only affect denominator', () => {
  const f = confirmedFixture({ month: '2026-09' });
  const { r } = calc(f, { start: '2026-09-02', end: '2026-09-03', cutoff: '2026-09-02T10:00:00Z' });
  assert.equal(r.chain.cost, 250); assert.equal(r.chain.source, 'estimated');
});
test('day with no qualifying hours is estimated zero, not uniform calendar accrual', () => {
  const { r } = calc(confirmedFixture({ month: '2026-09' }), { start: '2026-09-04', end: '2026-09-05' });
  assert.equal(r.chain.cost, 0); assert.equal(r.chain.complete, true); assert.equal(r.stores.christianshavn.source, 'estimated');
});
test('completed month missing Office punches falls back and keeps the home allocation complete', () => {
  const f = confirmedFixture(); f.attendance.pop(); const { r } = calc(f);
  assert.equal(r.stores.christianshavn.cost, 1000.01); assert.equal(r.stores.norrebro.cost, 0); assert.equal(r.chain.cost, 1000.01); assert.equal(r.chain.estimated, true); assert.equal(r.chain.actualHours, 4); assert.equal(r.chain.scheduledFallbackHours, 4);
  assert.equal(r.coverage.attendanceMissing, 1); assert.equal(r.coverage.attendanceRequired, 2);
});
test('regional denominator uses outside scheduled fallback without redistributing its cost', () => {
  const f = confirmedFixture({ kind: 'regional' }); f.attendance.pop(); const { r, n } = calc(f);
  assert.equal(r.stores.christianshavn.cost, 500.01); assert.equal(n.reconciliation.reconciledMonths, 1); assert.equal(n.reconciliation.outsideSalaryOre, 50000); assert.equal(r.chain.estimated, true);
});
test('central salary is excluded and only clocked store work costs exactly 225 per hour', () => {
  const f = confirmedFixture({ kind: 'central' }); f.attendance[0].endDateTime = '2026-08-02T12:00:00';
  const { r, n } = calc(f); assert.equal(r.chain.cost, 450); assert.equal(r.stores.christianshavn.components.salaried, 0);
  assert.equal(n.reconciliation.excludedOverheadOre, 100001); assert.equal(r.coverage.attendanceRequired, 1);
});
test('central missing punches use supported scheduled hours at 225 per hour', () => {
  const f = confirmedFixture({ kind: 'central' }); f.attendance = []; const { r } = calc(f);
  assert.equal(r.stores.christianshavn.cost, 900); assert.equal(r.chain.scheduledFallbackHours, 4); assert.equal(r.chain.scheduledFallbackShifts, 1); assert.equal(r.chain.estimated, true); assert.ok(!r.warnings.includes('ACTUAL_HOURS_MISSING'));
});
test('central outside work needs no clock record and costs zero', () => {
  const f = confirmedFixture({ kind: 'central' }); f.shifts[0].departmentId = 999; f.attendance = [];
  assert.equal(calc(f).r.chain.cost, 0);
});
test('attendance endpoint failure does not charge excluded outside schedules', () => {
  const f = confirmedFixture({ kind: 'central' }); f.shifts[0].departmentId = 999; f.attendance = null;
  assert.equal(calc(f).r.chain.cost, 0);
});
test('future central scheduled work is excluded without demanding future punches', () => {
  const f = confirmedFixture({ kind: 'central', month: '2026-09' }); f.attendance = [];
  const { r } = calc(f, { start: '2026-09-01', end: '2026-09-02' }); assert.equal(r.chain.cost, 0); assert.equal(r.coverage.attendanceRequired, 0);
});
test('central open punch uses scheduled fallback clipped to Copenhagen cutoff', () => {
  const f = confirmedFixture({ kind: 'central', month: '2026-09' }); f.evaluatedAt = Date.parse('2026-09-02T11:00Z');
  f.shifts[0].status = 'PunchclockStarted'; f.attendance[0].endDateTime = null; f.attendance[0].isApproved = false;
  f.attendanceBreaks.set(f.attendance[0].id, [{ startDateTime: '2026-09-02T11:30:00', endDateTime: null }]);
  const { r } = calc(f, { end: '2026-09-03', cutoff: '2026-09-02T10:00:00Z' }); assert.equal(r.chain.cost, 450); assert.equal(r.chain.source, 'estimated'); assert.equal(r.chain.scheduledFallbackHours, 2);
});
test('stale unclosed central punch uses only valid scheduled hours', () => {
  const f = confirmedFixture({ kind: 'central' }); f.attendance[0].endDateTime = null;
  assert.equal(calc(f).r.chain.cost, 900);
});
test('recorded clock breaks reduce actual hour weights; no payroll duration substitution', () => {
  const f = confirmedFixture(); f.attendanceBreaks.set(f.attendance[0].id, [{ startDateTime: '2026-08-02T11:00:00', endDateTime: '2026-08-02T13:00:00' }]);
  assert.equal(calc(f, { start: '2026-08-02', end: '2026-08-03' }).r.chain.cost, 333.34);
});
for (const [name, change, code] of [
  ['manual break semantics', f => { f.monthly[0].payroll.shiftsPayroll.push({ id: f.shifts[0].id, breaks: [{ duration: 1, amount: 0 }] }); }, 'UNVERIFIED_BREAK_OR_SUPPLEMENT'],
  ['mismatched punch department', f => { f.attendance[0].departmentId = 149700; }, 'ATTENDANCE_CONFLICT'],
  ['shift classification gap', f => { f.shiftDetails.delete(f.shifts[0].id); }, 'SHIFT_TYPE_UNAVAILABLE'],
  ['short month coverage', f => { f.allocationCoverage.from = '2026-08-02'; }, 'SALARY_HOURS_UNAVAILABLE'],
]) test(name + ' fails closed locally', () => {
  const f = confirmedFixture({ kind: 'regional' }); change(f); const { r } = calc(f); assert.equal(r.stores.christianshavn.cost, null); assert.ok(r.warnings.includes(code)); assert.equal(r.stores.norrebro.cost, 0);
});
test('home Office overlap is unioned before day weights; it never doubles minutes', () => {
  const f = confirmedFixture({ month: '2026-09' }); f.shifts[1].date = f.shifts[0].date;
  f.shifts[1].startDateTime = f.shifts[0].startDateTime; f.shifts[1].endDateTime = f.shifts[0].endDateTime; f.attendance = [];
  const { r } = calc(f, { start: '2026-09-02', end: '2026-09-03' }); assert.equal(r.chain.cost, 1000.01);
});
test('regional cross-department overlap is incomplete instead of inventing shares', () => {
  const f = confirmedFixture({ kind: 'regional', month: '2026-09' }); Object.assign(f.shifts[1], { date: f.shifts[0].date, startDateTime: f.shifts[0].startDateTime, endDateTime: f.shifts[0].endDateTime }); f.attendance = [];
  const { r } = calc(f); assert.equal(r.chain.cost, null); assert.ok(r.warnings.includes('OVERLAPPING_WORK'));
});
test('duplicate schedules and punch identities cannot double salary or hours', () => {
  const f = confirmedFixture({ kind: 'central' }); f.shifts.push(structuredClone(f.shifts[0])); f.attendance.push(structuredClone(f.attendance[0]));
  assert.equal(calc(f).r.chain.cost, 900);
});
test('rotated/missing policy secret fails closed without falling back to provider allocation', () => {
  const f = confirmedFixture(); f.workerRules = createWorkerRules('fixture-wrong', { keyCheck: digest('fixture-right', 'key-check'), policies: [] });
  const { r } = calc(f); assert.equal(r.chain.cost, null); assert.ok(r.warnings.includes('WORKER_RULE_CONFIGURATION'));
});
test('unknown new salaried worker requires a rule, not inferred current membership', () => {
  const f = confirmedFixture(); f.workerRules = { valid: true, resolve: () => undefined }; const { r } = calc(f);
  assert.equal(r.chain.cost, null); assert.ok(r.warnings.includes('WORKER_RULE_UNAVAILABLE'));
});
test('dated rule leaves earlier provider allocation intact', () => {
  const f = confirmedFixture({ kind: 'central', from: '2026-09-01' });
  f.allocations.set('fixture-managed', [{ validFrom: '2025-01-01', costAllocation: 'BusinessDays', departmentDistributions: [{ department: { id: 149748 }, departmentWeight: 1 }] }]);
  const { r } = calc(f); assert.equal(r.chain.cost, 1000.01); assert.equal(r.stores.christianshavn.components.hourly, 0);
});
function absenceFixture() {
  const f = confirmedFixture({ month: '2026-09' }), h = fixture(); f.payroll = h.payroll; f.approved = h.approved;
  f.shifts = h.shifts; f.allocationShifts = f.shifts; f.payroll.shiftsPayroll = []; f.approved.shiftsPayroll = [];
  f.monthly[0].payroll = structuredClone(f.payroll); f.attendance = [];
  f.shiftDetails = new Map([[f.shifts[0].id, { shiftTypeId: 'fixture-sickness' }]]); return f;
}
test('schedule-only sick leave is zero with safe warning and does not invalidate the store', () => {
  const { r } = calc(absenceFixture()); assert.equal(r.stores.norrebro.cost, 0); assert.equal(r.chain.complete, true);
  assert.ok(r.warnings.includes('SICK_LEAVE_WITHOUT_MONETARY_PAY')); assert.equal(r.coverage.sickLeaveExcluded, 1);
});
test('authoritative Time & Cost sickness amount counts once, never amount times hours', () => {
  const f = absenceFixture(), s = f.shifts[0]; f.timeCosts.set(s.departmentId, [{ shiftId: s.id, employeeId: s.employeeId, shiftTypeId: 'fixture-sickness', date: s.date, cost: 417.13 }]);
  assert.equal(calc(f).r.chain.cost, 417.13);
});
test('Payroll sickness amount wins over Time & Cost without duplication', () => {
  const f = absenceFixture(), h = fixture(); f.payroll.shiftsPayroll = h.payroll.shiftsPayroll; f.approved.shiftsPayroll = h.approved.shiftsPayroll;
  const s = f.shifts[0]; f.timeCosts.set(s.departmentId, [{ shiftId: s.id, employeeId: s.employeeId, date: s.date, cost: 417.13 }]);
  assert.equal(calc(f).r.chain.cost, 1200);
});
test('unclassified missing monetary work still fails closed', () => {
  const f = absenceFixture(); f.shiftDetails.clear(); assert.equal(calc(f).r.chain.cost, null);
});
test('signed deductions remain once alongside central actual work', () => {
  const f = confirmedFixture({ kind: 'central' }); f.payroll.supplementsPayroll = [{ employeeId: 'fixture-managed', salary: -35, start: '2026-08-02T00:00:00', end: '2026-08-03T00:00:00' }];
  assert.equal(calc(f).r.chain.cost, 865);
});
test('aggregate projection never exposes private inputs, rules, internal reconciliation or arbitrary coverage keys', () => {
  const { n } = calc(confirmedFixture()); n.coverage.employeeId = 'fixture-sensitive'; const w = windowFor(confirmedFixture());
  const json = JSON.stringify(p.processPayroll(n, w)); assert.doesNotMatch(json, /fixture-|employee|shiftId|token|SalaryOre|225|keyCheck/);
});
test('separate calendar months reconcile independently across rate changes', () => {
  const f = confirmedFixture(), other = confirmedFixture({ month: '2026-09', amount: 2000 });
  for (const s of other.shifts) s.id += '-next'; for (const a of other.attendance) { a.id += '-next'; a.shiftId += '-next'; }
  f.monthly.push(other.monthly[0]); f.allocationCoverage.end = other.allocationCoverage.end;
  f.shifts.push(...other.shifts); f.attendance.push(...other.attendance);
  for (const s of other.shifts) f.shiftDetails.set(s.id, { shiftTypeId: null }); for (const a of other.attendance) f.attendanceBreaks.set(a.id, []);
  const { r, n } = calc(f); assert.equal(r.chain.cost, 3000.01); assert.equal(n.reconciliation.allocatedSalaryOre, 300001); assert.equal(r.chain.source, 'estimated');
});
test('Punch Clock pagination/break metadata and shift details are verified by the real loader', async () => {
  const f = confirmedFixture(), calls = [];
  const client = { all: async (path, params) => {
    calls.push([path, params]); if (path.includes('departments')) return f.departments;
    if (path.includes('punchclock')) return f.attendance;
    if (path.includes('shifttypes')) return [{ id: 'fixture-sickness', name: 'Sygemelding' }]; return f.shifts;
  }, get: async (path, params) => {
    if (path.endsWith('/breaks')) return { data: [], paging: { total: 0 } };
    if (path.includes('/allocations/')) return { data: [{ validFrom: '2020-01-01', departmentDistributions: [{ department: { id: 149748 }, departmentWeight: 1 }] }] };
    if (path.includes('/shifts/')) { const s = f.shifts.find(s => path.endsWith('/' + s.id)); return { data: { ...s } }; }
    return params?.shiftStatus ? f.approved : f.payroll;
  } };
  const w = windowFor(f), input = await loadPayrollSources({ client, window: w, workerRules: f.workerRules, now: () => f.evaluatedAt });
  assert.equal(input.attendance.length, 4); assert.equal(input.attendanceBreaks.size, 2); assert.equal(input.shiftDetails.size, 2);
  const ranges = calls.filter(([path]) => path.includes('punchclock')).map(([, params]) => params);
  assert.deepEqual(ranges, [{ from: '2026-07-31T00:00', to: '2026-08-01T00:00' }, { from: '2026-08-01T00:00', to: '2026-09-01T00:00' }]);
  assert.equal(p.processPayroll(normalizePayroll(input, w), w).chain.cost, 1000.01);
});

test('authoritative hourly records with distinct IDs cannot double overlapping work', () => {
  const f = absenceFixture(), h = fixture(); f.payroll.shiftsPayroll = h.payroll.shiftsPayroll; f.approved.shiftsPayroll = h.approved.shiftsPayroll;
  f.payroll.shiftsPayroll.push({ ...h.payroll.shiftsPayroll[0], id: 'fixture-other-shift' });
  f.approved.shiftsPayroll.push({ ...h.approved.shiftsPayroll[0], id: 'fixture-other-shift' });
  f.shifts.push({ ...f.shifts[0], id: 'fixture-other-shift' });
  const { r } = calc(f); assert.equal(r.stores.norrebro.cost, null); assert.ok(r.warnings.includes('OVERLAPPING_WORK'));
});
test('recorded central overtime after a scheduled end is included at the cutoff', () => {
  const f = confirmedFixture({ kind: 'central' }); f.shifts[0].endDateTime = '2026-08-02T23:00:00';
  f.attendance[0].startDateTime = '2026-08-02T22:00:00'; f.attendance[0].endDateTime = '2026-08-03T01:00:00';
  const { r } = calc(f, { start: '2026-08-03', end: '2026-08-04' }); assert.equal(r.chain.cost, 225);
});
test('home allocation splits overnight actual work at Copenhagen midnight without losing øre', () => {
  const f = confirmedFixture(); f.attendance[0].startDateTime = '2026-08-02T22:00:00'; f.attendance[0].endDateTime = '2026-08-03T02:00:00';
  const first = calc(f, { start: '2026-08-02', end: '2026-08-03' }).r.chain.cost;
  const second = calc(f, { start: '2026-08-03', end: '2026-08-04' }).r.chain.cost;
  assert.equal(first, 250); assert.equal(second, 750.01); assert.equal(first + second, 1000.01);
});
test('home store change in synthetic policy places every salary øre in its authorized store', () => {
  const f = confirmedFixture(); f.workerRules = { valid: true, resolve: () => ({ kind: 'home', departmentId: 149668, from: '2025-01-01' }) };
  const { r } = calc(f); assert.equal(r.stores['indre-by'].cost, 1000.01); assert.equal(r.stores.christianshavn.cost, 0);
});
test('verified monetary sickness zero needs no invented wage and its exclusion warning stays local', () => {
  const f = absenceFixture(), h = fixture(); f.payroll.shiftsPayroll = h.payroll.shiftsPayroll; f.approved.shiftsPayroll = h.approved.shiftsPayroll;
  f.payroll.shiftsPayroll[0].salary = 0; f.payroll.shiftsPayroll[0].wage.rate = null; f.approved.shiftsPayroll = structuredClone(f.payroll.shiftsPayroll);
  assert.equal(calc(f).r.chain.cost, 0);
  const absent = calc(absenceFixture()).r; assert.ok(absent.stores.norrebro.warnings.includes('SICK_LEAVE_WITHOUT_MONETARY_PAY'));
  assert.ok(!absent.stores.christianshavn.warnings.includes('SICK_LEAVE_WITHOUT_MONETARY_PAY'));
});

for (const [name, change] of [
  ['unapproved', f => { f.attendance[0].isApproved = false; }],
  ['open', f => { f.attendance[0].endDateTime = null; }],
  ['missing start', f => { f.attendance[0].startDateTime = null; }],
  ['missing break coverage', f => { f.attendanceBreaks.delete(f.attendance[0].id); }],
  ['invalid punch duration', f => { f.attendance[0].endDateTime = f.attendance[0].startDateTime; }],
]) test(name + ' punches use valid schedule, retain salary and disclose fallback provenance', () => {
  const f = confirmedFixture(); change(f); const { r } = calc(f);
  assert.equal(r.chain.cost, 1000.01); assert.equal(r.chain.complete, true);
  assert.equal(r.chain.actualHours, 4); assert.equal(r.chain.scheduledFallbackHours, 4);
  assert.equal(r.chain.scheduledFallbackShifts, 1); assert.equal(r.chain.estimated, true);
  assert.equal(r.stores.christianshavn.source, 'estimated');
});
for (const status of ['Open', 'Draft', 'Cancelled', 'Deleted']) test(status + ' central schedule never supplies fallback hours', () => {
  const f = confirmedFixture({ kind: 'central' }); f.shifts[0].status = status; f.attendance = [];
  const { r } = calc(f); assert.equal(r.chain.cost, 0); assert.equal(r.chain.scheduledFallbackHours, 0);
});
for (const change of [f => { f.shifts[0].startDateTime = null; }, f => { f.shifts[0].endDateTime = f.shifts[0].startDateTime; }, f => { f.shifts[0].status = 'fixture-invalid-status'; }, f => { f.shifts[0].date = '2026-08-01'; }]) test('neither usable punch nor trustworthy schedule still fails closed', () => {
  const f = confirmedFixture({ kind: 'central' }); f.attendance = []; change(f);
  const { r } = calc(f); assert.equal(r.stores.christianshavn.cost, null); assert.ok(r.warnings.includes('ACTUAL_HOURS_MISSING'));
});
test('approved punches can supply working hours when scheduled timestamps are incomplete', () => {
  const f = confirmedFixture({ kind: 'central' }); f.shifts[0].startDateTime = null;
  const { r } = calc(f); assert.equal(r.chain.cost, 900); assert.equal(r.chain.actualHours, 4); assert.equal(r.chain.scheduledFallbackHours, 0);
});
test('no future fallback contributes to active numerator or aggregate period hours', () => {
  const f = confirmedFixture({ month: '2026-09' }); f.attendance = [];
  const { r, n } = calc(f, { start: '2026-09-02', end: '2026-09-03', cutoff: '2026-09-02T10:00:00Z' });
  assert.equal(r.chain.cost, 250); assert.equal(r.chain.actualHours, 0); assert.equal(r.chain.scheduledFallbackHours, 2);
  assert.equal(r.chain.scheduledFallbackShifts, 1); assert.equal(n.reconciliation.allocatedSalaryOre, 100001);
});
for (const kind of ['central', 'home', 'regional']) test(kind + ' sickness and other verified absence schedules cannot become working-hour fallback', () => {
  const f = confirmedFixture({ kind }); f.attendance = [];
  f.absenceTypes = new Set(['fixture-sickness', 'fixture-other-absence']);
  f.shiftDetails.set(f.shifts[0].id, { shiftTypeId: 'fixture-other-absence' });
  const { r } = calc(f); assert.equal(r.chain.scheduledFallbackHours, kind === 'home' ? 4 : 0);
  assert.equal(r.stores.christianshavn.components.hourly, 0);
  f.shiftDetails.set(f.shifts[0].id, { shiftTypeId: 'fixture-sickness' });
  const sick = calc(f).r; assert.equal(sick.stores.christianshavn.components.hourly, 0);
  assert.ok(sick.warnings.includes('SICK_LEAVE_WITHOUT_MONETARY_PAY'));
});
test('duplicate schedule fallback never doubles hours, count or money', () => {
  const f = confirmedFixture({ kind: 'central' }); f.attendance = []; f.shifts.push(structuredClone(f.shifts[0]));
  const { r } = calc(f); assert.equal(r.chain.cost, 900); assert.equal(r.chain.scheduledFallbackHours, 4); assert.equal(r.chain.scheduledFallbackShifts, 1);
});
for (const [field, value] of [['date', '2026-08-01'], ['timeZone', 'UTC'], ['shiftTypeId', 'fixture-sickness']]) test('conflicting duplicate schedule ' + field + ' cannot supply fallback', () => {
  const f = confirmedFixture({ kind: 'central' }); f.attendance = [];
  f.shifts.push({ ...f.shifts[0], [field]: value });
  const { r } = calc(f); assert.equal(r.stores.christianshavn.cost, null);
  assert.ok(r.warnings.includes('CONFLICTING_DUPLICATE'));
});
test('ordinary hourly money remains authoritative while punch/fallback hours disclose provenance', () => {
  const f = absenceFixture(), h = fixture(); f.payroll.shiftsPayroll = h.payroll.shiftsPayroll; f.approved.shiftsPayroll = h.approved.shiftsPayroll;
  f.shiftDetails.set(f.shifts[0].id, { shiftTypeId: null });
  const { r } = calc(f); assert.equal(r.chain.cost, 1200); assert.equal(r.chain.scheduledFallbackHours, 8); assert.equal(r.chain.estimated, true);
});
test('malformed incomplete punch falls back instead of failing cutoff selection', () => {
  const f = confirmedFixture({ kind: 'central' }); f.attendance[0].startDateTime = 'fixture-invalid-time';
  assert.equal(calc(f).r.chain.cost, 900);
});
test('approved overtime crossing a month boundary wins over a scheduled end before midnight', () => {
  const f = confirmedFixture({ kind: 'central' });
  Object.assign(f.shifts[0], { date: '2026-07-31', startDateTime: '2026-07-31T22:00:00', endDateTime: '2026-07-31T23:00:00' });
  Object.assign(f.attendance[0], { startDateTime: '2026-07-31T22:00:00', endDateTime: '2026-08-01T01:00:00' });
  const { r } = calc(f); assert.equal(r.chain.cost, 225); assert.equal(r.chain.actualHours, 1);
});

function calendarFixture(options = {}) {
  const f = confirmedFixture({ from: '2020-01-01', ...options });
  f.shifts = []; f.allocationShifts = []; f.attendance = [];
  return f;
}
for (const [month, days] of [['2026-02', 28], ['2024-02', 29], ['2026-04', 30], ['2026-07', 31]]) {
  test(days + '-day calendar fallback conserves the full monthly salary and final-day rounding', () => {
    const f = calendarFixture({ month }), { n, r } = calc(f);
    assert.equal(r.chain.cost, 1000.01); assert.equal(r.chain.complete, true);
    assert.equal(r.stores.christianshavn.components.salaried, 1000.01);
    assert.equal(r.stores.christianshavn.components.hourly, 0);
    assert.equal(r.chain.calendarFallbackDays, days); assert.equal(r.chain.estimated, true);
    assert.equal(r.chain.actualHours, 0); assert.equal(r.chain.scheduledFallbackHours, 0);
    assert.equal(r.chain.scheduledFallbackShifts, 0);
    const rows = n.records.filter(x => x.calendarFallbackDays);
    const dailyOre = Math.trunc(100001 / days);
    assert.equal(rows.length, days);
    assert.ok(rows.slice(0, -1).every(x => Math.round(x.amount * 100) === dailyOre));
    assert.equal(Math.round(rows.at(-1).amount * 100), 100001 - dailyOre * (days - 1));
    assert.equal(n.reconciliation.expectedSalaryOre, 100001);
    assert.equal(n.reconciliation.allocatedSalaryOre, 100001);
    assert.equal(n.reconciliation.blockedMonths, 0);
    let sumOre = 0;
    for (let date = month + '-01'; date <= f.monthly[0].to; date = p.nextDate(date)) {
      sumOre += Math.round(calc(f, { start: date, end: p.nextDate(date) }).r.chain.cost * 100);
    }
    assert.equal(sumOre, 100001, 'separate daily requests also conserve the complete salary');
  });
}
for (const [departmentId, store] of [[149748, 'christianshavn'], [149668, 'indre-by']]) test('calendar fallback remains entirely in ' + store, () => {
  const f = calendarFixture({ amount: 4321.09 });
  f.workerRules = { valid: true, resolve: () => ({ kind: 'home', departmentId, from: '2020-01-01' }) };
  const { r } = calc(f);
  assert.equal(r.stores[store].cost, 4321.09); assert.equal(r.chain.cost, 4321.09);
  assert.equal(r.stores[store].calendarFallbackDays, 31);
  for (const [id, v] of Object.entries(r.stores)) if (id !== store) {
    assert.equal(v.cost, 0); assert.equal(v.calendarFallbackDays, 0);
    assert.ok(!v.warnings.includes('CALENDAR_SALARY_FALLBACK'));
  }
});
test('calendar salary includes Saturday and Sunday, using days rather than business days', () => {
  const f = calendarFixture({ month: '2026-08', amount: 3100 });
  const { r } = calc(f, { start: '2026-08-01', end: '2026-08-03' });
  assert.equal(r.chain.cost, 200); assert.equal(r.chain.calendarFallbackDays, 2);
});
test('partial calendar periods conserve rounded monthly proportions across adjacent requests', () => {
  const f = calendarFixture({ month: '2026-04' });
  const first = calc(f, { end: '2026-04-11' }), rest = calc(f, { start: '2026-04-11' });
  assert.equal(first.r.chain.cost, 333.34); assert.equal(rest.r.chain.cost, 666.67);
  assert.equal(first.r.chain.cost + rest.r.chain.cost, 1000.01);
  assert.equal(first.r.chain.calendarFallbackDays, 10); assert.equal(rest.r.chain.calendarFallbackDays, 20);
  const rows = first.n.records.filter(x => x.calendarFallbackDays);
  assert.equal(rows.at(-1).amount, 33.37, 'partial-period residual goes on final included day');
});
test('active calendar fallback counts the current Copenhagen date and excludes future dates', () => {
  const f = calendarFixture({ month: '2026-09', amount: 3000 });
  const { r, n } = calc(f, { cutoff: '2026-09-23T12:32:00Z' });
  assert.equal(r.chain.cost, 2300); assert.equal(r.chain.calendarFallbackDays, 23);
  assert.equal(n.records.filter(x => x.calendarFallbackDays).at(-1).end, Date.parse('2026-09-23T12:32:00Z'));
  assert.equal(n.reconciliation.allocatedSalaryOre, 300000);
  assert.equal(calc(f, { start: '2026-09-23', end: '2026-09-24', cutoff: '2026-09-23T12:32:00Z' }).r.chain.cost, 100);
});
test('calendar fallback respects exclusive Copenhagen midnight and zero-width cutoffs', () => {
  const f = calendarFixture({ month: '2026-09', amount: 3000 });
  assert.equal(calc(f, { cutoff: '2026-09-23T22:00:00Z' }).r.chain.calendarFallbackDays, 23);
  assert.equal(calc(f, { cutoff: '2026-09-23T22:00:01Z' }).r.chain.calendarFallbackDays, 24);
  const zero = calc(f, { start: '2026-09-24', end: '2026-09-25', cutoff: '2026-09-23T22:00:00Z' }).r;
  assert.equal(zero.chain.cost, 0); assert.equal(zero.chain.calendarFallbackDays, 0); assert.equal(zero.chain.estimated, true);
});
for (const [month, date, duration] of [['2026-03', '2026-03-29', 23], ['2025-10', '2025-10-26', 25]]) test(duration + '-hour Copenhagen DST day has one equal calendar salary share', () => {
  const f = calendarFixture({ month, amount: 3100 });
  const { r, n } = calc(f, { start: date, end: p.nextDate(date) });
  assert.equal(r.chain.cost, 100); assert.equal(r.chain.calendarFallbackDays, 1);
  assert.equal((n.records[0].end - n.records[0].start) / 3600000, duration);
});
test('calendar fallback splits month boundaries using each complete monthly amount and day count', () => {
  const f = calendarFixture(), next = calendarFixture({ month: '2026-09', amount: 2000 });
  f.monthly.push(next.monthly[0]); f.allocationCoverage.end = next.allocationCoverage.end;
  const { r, n } = calc(f, { start: '2026-08-31', end: '2026-09-02' });
  assert.equal(r.chain.cost, 98.93); assert.equal(r.chain.calendarFallbackDays, 2);
  assert.equal(n.reconciliation.allocatedSalaryOre, 300001);
});
for (const [name, change] of [
  ['missing month coverage', f => { f.allocationCoverage = undefined; }],
  ['truncated month start', f => { f.allocationCoverage.from = '2026-08-02'; }],
  ['truncated month end', f => { f.allocationCoverage.end = '2026-08-30'; }],
  ['unusable scheduled interval', f => { f.attendance = []; f.shifts[0].startDateTime = null; }],
  ['missing schedule date and timestamps', f => { f.attendance = []; Object.assign(f.shifts[0], { date: null, startDateTime: null, endDateTime: null }); }],
  ['unverified shift classification', f => { f.shiftDetails.delete(f.shifts[0].id); }],
  ['conflicting monthly schedule copies', f => { f.shifts.push({ ...f.shifts[0], startDateTime: '2026-08-02T11:00:00' }); }],
  ['known Payroll shift absent from schedule', f => { f.monthly[0].payroll.shiftsPayroll.push({ id: 'fixture-missing', employeeId: 'fixture-managed' }); }],
  ['unmatched approved attendance', f => { f.attendance[0].shiftId = 'fixture-missing'; }],
]) test('home salary uses calendar fallback for ' + name, () => {
  const f = confirmedFixture(); change(f); const { r, n } = calc(f);
  assert.equal(r.chain.complete, true); assert.equal(r.stores.christianshavn.cost, 1000.01);
  assert.equal(r.chain.calendarFallbackDays, 31); assert.equal(r.chain.estimated, true);
  assert.ok(r.stores.christianshavn.warnings.includes('CALENDAR_SALARY_FALLBACK'));
  assert.equal(n.reconciliation.blockedMonths, 0);
});
test('sparse but complete usable hours remain proportional weights, not calendar fallback or hourly pay', () => {
  const f = confirmedFixture(); f.shifts.length = 1; f.attendance.length = 1;
  f.attendance[0].endDateTime = '2026-08-02T10:01:00';
  const { r } = calc(f, { start: '2026-08-02', end: '2026-08-03' });
  assert.equal(r.chain.cost, 1000.01); assert.equal(r.chain.calendarFallbackDays, 0);
  assert.equal(r.stores.christianshavn.components.hourly, 0);
});
test('a month containing only absence schedules uses salary calendar weights without inventing work', () => {
  const f = confirmedFixture(); f.attendance = [];
  for (const s of f.shifts) f.shiftDetails.set(s.id, { shiftTypeId: 'fixture-sickness' });
  const { r } = calc(f); assert.equal(r.chain.cost, 1000.01); assert.equal(r.chain.calendarFallbackDays, 31);
  assert.equal(r.chain.scheduledFallbackHours, 0); assert.equal(r.stores.christianshavn.components.hourly, 0);
});
for (const kind of ['central', 'regional']) test(kind + ' never receives calendar salary fallback', () => {
  const f = calendarFixture({ kind }), { r } = calc(f);
  assert.equal(r.chain.calendarFallbackDays, 0);
  assert.equal(r.chain.cost, kind === 'central' ? 0 : null);
  assert.ok(!r.warnings.includes('CALENDAR_SALARY_FALLBACK'));
});
test('calendar fallback cannot invent an unavailable monetary salary or unknown home-store identity', () => {
  for (const salary of [null, NaN, Infinity]) {
    const f = calendarFixture(); f.monthly[0].payroll.salariedPayroll[0].salary = salary;
    assert.equal(calc(f).r.chain.cost, null); assert.equal(calc(f).r.chain.calendarFallbackDays, 0);
  }
  const f = calendarFixture(); f.workerRules = { valid: true, resolve: () => ({ kind: 'home', departmentId: 999, from: '2020-01-01' }) };
  assert.equal(calc(f).r.chain.cost, null);
});
test('calendar fallback aggregate never exposes individual salary, identity, dates or internal rows', () => {
  const { r } = calc(calendarFixture()), json = JSON.stringify(r);
  assert.equal(r.chain.calendarFallbackDays, 31);
  assert.doesNotMatch(json, /fixture-|employeeId|salaryCode|salary-calendar|departmentId|calendarFallbackRecords/);
});
test('failed monthly schedule pagination still loads a supported calendar home salary', async () => {
  const f = calendarFixture();
  const client = { all: async (path, params) => {
    if (path.includes('departments')) return f.departments;
    if (path.endsWith('/shifts') && params.from === '2026-07-31' && params.to === '2026-08-31') throw Error('PAGINATION_INCOMPLETE');
    return [];
  }, get: async (path, params) => {
    if (path.includes('/allocations/')) return { data: [{ departmentDistributions: [{ department: { id: 149748 }, departmentWeight: 1 }] }] };
    return params?.shiftStatus ? f.approved : f.payroll;
  } };
  const w = windowFor(f, { start: '2026-08-02', end: '2026-08-03' });
  const input = await loadPayrollSources({ client, window: w, workerRules: f.workerRules, now: () => f.evaluatedAt });
  assert.equal(input.allocationCoverage, undefined);
  const r = p.processPayroll(normalizePayroll(input, w), w);
  assert.equal(r.chain.complete, true); assert.equal(r.chain.calendarFallbackDays, 1); assert.equal(r.chain.cost, 32.26);
});
test('the two home policies retain separate salary amounts and aggregate their calendar days safely', () => {
  const f = calendarFixture(), second = calendarFixture({ amount: 2000.01 });
  const salary = { ...second.monthly[0].payroll.salariedPayroll[0], employeeId: 'fixture-second-home' };
  f.monthly[0].payroll.salariedPayroll.push(salary); f.payroll.salariedPayroll.push(salary);
  f.workerRules = { valid: true, resolve: id => ({ kind: 'home', departmentId: id === 'fixture-second-home' ? 149668 : 149748, from: '2020-01-01' }) };
  const { r } = calc(f);
  assert.equal(r.stores.christianshavn.cost, 1000.01); assert.equal(r.stores['indre-by'].cost, 2000.01);
  assert.equal(r.chain.cost, 3000.02); assert.equal(r.chain.calendarFallbackDays, 62);
});
test('unreliable home schedules trigger calendar fallback only in their affected month', () => {
  const f = confirmedFixture(), next = confirmedFixture({ month: '2026-09', amount: 2000 });
  f.evaluatedAt = Date.parse('2026-10-01T12:00:00Z');
  for (const s of next.shifts) s.id += '-next';
  for (const a of next.attendance) { a.id += '-next'; a.shiftId += '-next'; }
  f.monthly.push(next.monthly[0]); f.allocationCoverage.end = next.allocationCoverage.end;
  f.shifts.push({ ...f.shifts[0], startDateTime: '2026-08-02T11:00:00' }, ...next.shifts);
  f.attendance.push(...next.attendance);
  for (const s of next.shifts) f.shiftDetails.set(s.id, { shiftTypeId: null });
  for (const a of next.attendance) f.attendanceBreaks.set(a.id, []);
  const { r, n } = calc(f);
  assert.equal(r.chain.cost, 3000.01); assert.equal(r.chain.calendarFallbackDays, 31);
  assert.equal(r.chain.actualHours, 8);
  assert.ok(n.records.filter(x => x.calendarFallbackDays).every(x => x.end <= p.midnight('2026-09-01')));
});
