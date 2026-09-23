'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const p = require('../lib/planday-payroll');
const { normalizePayroll } = require('../lib/planday-normalize');
const { fixture, addSalary } = require('./fixtures/planday.fixture');
const day = p.period({ start: '2026-09-22', end: '2026-09-23' }, Date.parse('2026-09-24T12:00:00Z'));
const windowFor = (start, end, cutoff) => p.period({ start, end, cutoff }, Date.parse('2026-09-23T18:00:00Z'));
const record = (overrides = {}) => ({ id: 'fixture-record', departmentId: 149700, start: p.localInstant('2026-09-22T10:00:00'), end: p.localInstant('2026-09-22T18:00:00'), amount: 1200, source: 'actual', component: 'hourly', prorate: 'elapsed', ...overrides });
const calculate = (f, w = day) => p.processPayroll(normalizePayroll(f, w), w);

test('completed day takes authoritative shift amount and approved provenance', () => {
  const r = calculate(fixture()); assert.equal(r.stores.norrebro.cost, 1200); assert.equal(r.chain.cost, 1200); assert.equal(r.chain.source, 'actual');
});
for (const [name, start] of [['Today', '2026-09-23'], ['This Week', '2026-09-21'], ['This Month', '2026-09-01']]) test(`${name} stops at cutoff; future scheduled work excluded`, () => {
  const w = windowFor(start, '2026-09-24', '2026-09-23T12:00:00Z');
  const rows = [record({ id: 'earlier', start: p.localInstant('2026-09-22T10:00:00'), end: p.localInstant('2026-09-22T18:00:00') }),
    record({ id: 'partial', start: p.localInstant('2026-09-23T10:00:00'), end: p.localInstant('2026-09-23T18:00:00'), source: 'scheduled' }),
    record({ id: 'future', start: p.localInstant('2026-09-23T20:00:00'), end: p.localInstant('2026-09-23T23:00:00'), source: 'scheduled' })];
  const r = p.processPayroll({ records: rows }, w);
  assert.equal(r.chain.cost, name === 'Today' ? 600 : 1800); assert.equal(r.chain.source, 'estimated');
});
test('start inclusive, end exclusive; crossing midnight is clipped', () => {
  const r = p.processPayroll({ records: [record({ start: p.midnight('2026-09-21') + 23 * 3600000, end: p.midnight('2026-09-22') + 3600000, amount: 200 })] }, day);
  assert.equal(r.chain.cost, 100);
  assert.equal(p.processPayroll({ records: [record({ start: day.until, end: day.until + 3600000 })] }, day).chain.cost, 0);
});
test('Copenhagen spring DST day is 23 hours; autumn day is 25 hours', () => {
  assert.equal(p.midnight('2026-03-30') - p.midnight('2026-03-29'), 23 * 3600000);
  assert.equal(p.midnight('2026-10-26') - p.midnight('2026-10-25'), 25 * 3600000);
  assert.throws(() => p.localInstant('2026-03-29T02:30:00'), /AMBIGUOUS/);
  assert.throws(() => p.localInstant('2026-10-25T02:30:00'), /AMBIGUOUS/);
  assert.equal(p.localInstant('2026-10-25T02:30:00+02:00') + 3600000, p.localInstant('2026-10-25T02:30:00+01:00'));
});
test('leap day, month and week transitions use calendar dates', () => {
  assert.equal(p.nextDate('2024-02-28'), '2024-02-29'); assert.equal(p.nextDate('2024-02-29'), '2024-03-01');
  assert.equal(p.nextDate('2026-09-30'), '2026-10-01'); assert.equal(p.nextDate('2026-09-20'), '2026-09-21');
});
for (const tz of ['UTC', 'Europe/Copenhagen', 'America/Los_Angeles']) test(`timezone child process: ${tz}`, () => {
  const actual = execFileSync(process.execPath, ['-e', `const p=require('./lib/planday-payroll');console.log(JSON.stringify([p.midnight('2026-03-29'),p.midnight('2026-10-25'),p.localInstant('2026-09-22T10:00:00')]))`], { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(actual), [Date.parse('2026-03-28T23:00:00Z'), Date.parse('2026-10-24T22:00:00Z'), Date.parse('2026-09-22T08:00:00Z')]);
});
test('salary percentage uses ex-VAT revenue without adjusting wage VAT', () => {
  assert.equal(p.percentage({ complete: true, cost: 200 }, 800), 25);
});
test('chain ratio is weighted using summed costs and corresponding revenue', () => {
  const r = p.processPayroll({ records: [record({ amount: 100 }), record({ id: 'second', departmentId: 148561, amount: 900 })] }, day);
  assert.equal(p.percentage(r.chain, 1000 + 3000), 25); assert.notEqual(p.percentage(r.chain, 4000), (10 + 30) / 2);
});
test('one failed store invalidates chain; other stores retain valid totals', () => {
  const r = p.processPayroll({ records: [record()], failures: [{ code: 'UPSTREAM_UNAVAILABLE', departmentId: 148561 }] }, day);
  assert.equal(r.stores.norrebro.cost, 1200); assert.equal(r.stores.vesterbro.cost, null); assert.equal(r.chain.complete, false); assert.equal(r.chain.cost, null);
});
test('genuine zero remains complete zero; unavailable never becomes zero', () => {
  const zero = p.processPayroll({}, day); assert.equal(zero.chain.cost, 0); assert.equal(p.percentage(zero.chain, 100), 0);
  const missing = p.processPayroll({ covered: false }, day); assert.equal(missing.chain.cost, null); assert.equal(p.percentage(missing.chain, 100), null);
});
test('stable duplicate IDs idempotent; conflicting duplicates invalidate affected stores', () => {
  assert.equal(p.processPayroll({ records: [record(), record()] }, day).chain.cost, 1200);
  const r = p.processPayroll({ records: [record(), record({ amount: 900 })] }, day);
  assert.equal(r.chain.complete, false); assert.ok(r.warnings.includes('CONFLICTING_DUPLICATE'));
});
test('date-effective hourly rates and unpaid vs paid breaks', () => {
  const s = p.localInstant('2026-09-22T10:00:00'), h = 3600000;
  const cost = p.reconstructHourly({ start: s, end: s + 4 * h,
    rates: [{ start: s, end: s + 2 * h, rate: 100 }, { start: s + 2 * h, end: s + 4 * h, rate: 200 }],
    breaks: [{ start: s + h, end: s + 1.5 * h, paid: false }, { start: s + 3 * h, end: s + 3.5 * h, paid: true }] });
  assert.equal(cost, 550);
});
test('missing rate fails closed rather than inventing a standard rate', () => {
  const f = fixture(); f.payroll.shiftsPayroll[0].salary = 0; f.payroll.shiftsPayroll[0].wage.rate = null; f.approved.shiftsPayroll = structuredClone(f.payroll.shiftsPayroll);
  assert.ok(calculate(f).warnings.includes('MISSING_PAY_DATA'));
});
test('a reconciled hourly shift is reconstructed at partial cutoff using its own wage', () => {
  const f = fixture(), w = p.period({ start: '2026-09-22', end: '2026-09-23', cutoff: '2026-09-22T12:00:00Z' }, Date.parse('2026-09-22T13:00:00Z'));
  assert.equal(calculate(f, w).chain.cost, 600);
});
test('unverified upstream break/supplement semantics fail closed for full and clipped periods', () => {
  const f = fixture(); f.payroll.shiftsPayroll[0].salary = 1150;
  f.payroll.shiftsPayroll[0].breaks = [{ id: 'fixture-break', amount: -100, isPaid: false }];
  f.payroll.shiftsPayroll[0].supplements = [{ id: 'fixture-supplement', modification: 50, duration: 1 }];
  f.approved.shiftsPayroll = structuredClone(f.payroll.shiftsPayroll);
  assert.equal(calculate(f).chain.cost, null);
  assert.ok(calculate(f).warnings.includes('UNVERIFIED_BREAK_OR_SUPPLEMENT'));
  const w = p.period({ start: '2026-09-22', end: '2026-09-23', cutoff: '2026-09-22T12:00:00Z' }, Date.parse('2026-09-22T13:00:00Z'));
  assert.equal(calculate(f, w).chain.cost, null);
});
test('salaried allocation sums once across stores and preserves signed øre', () => {
  const f = addSalary(fixture(), { amount: 1000.01, weights: [{ departmentId: 149700, weight: 1 }, { departmentId: 148561, weight: 2 }] });
  const r = calculate(f); assert.equal(r.chain.cost, 2200.01); assert.equal(r.chain.source, 'estimated');
  assert.equal(Math.round((r.stores.norrebro.components.salaried + r.stores.vesterbro.components.salaried) * 100), 100001);
  assert.equal(p.splitOre(-100001, [{ departmentId: 1, weight: 1 }, { departmentId: 2, weight: 2 }]).reduce((s, x) => s + x.amountOre, 0), -100001);
});
test('unallocated monthly salary cannot silently disappear', () => {
  const f = addSalary(fixture(), { employeeId: 'fixture-no-shifts' }); const r = calculate(f);
  assert.equal(r.chain.cost, null); assert.ok(r.warnings.includes('SALARY_HOURS_UNAVAILABLE'));
});
test('negative corrections keep their sign; same-valued separate adjustments are retained', () => {
  const f = fixture(); const correction = { employeeId: 'fixture-hourly', salary: -35, start: '2026-09-22T00:00:00', end: '2026-09-23T00:00:00' };
  f.payroll.supplementsPayroll = [correction, structuredClone(correction)]; const r = calculate(f);
  assert.equal(r.chain.cost, 1130); assert.equal(r.stores.norrebro.components.adjustments, -70);
});
test('unknown department and malformed source shape fail closed', () => {
  const f = fixture(); f.payroll.shiftsPayroll[0].departmentId = 42; f.shifts[0].departmentId = 42; f.approved.shiftsPayroll = structuredClone(f.payroll.shiftsPayroll);
  assert.equal(calculate(f).chain.cost, null);
  f.payroll = { data: [] }; assert.ok(calculate(f).warnings.includes('INVALID_SCHEMA'));
});
for (const status of ['Open', 'Cancelled', 'Deleted', 'Draft']) test(`${status} shifts cannot produce an hourly fallback cost`, () => {
  const f = fixture(); f.shifts[0].status = status; f.payroll.shiftsPayroll = []; f.approved.shiftsPayroll = [];
  assert.equal(calculate(f).chain.cost, 0);
});
test('unapproved shifts explicitly labelled scheduled, never actual', () => {
  const f = fixture(); f.approved.shiftsPayroll = []; f.shifts[0].status = 'Assigned'; const r = calculate(f);
  assert.equal(r.stores.norrebro.source, 'scheduled'); assert.ok(r.warnings.includes('UNAPPROVED_SHIFTS'));
});
test('public response uses an allowlist and drops employee information', () => {
  const r = p.processPayroll({ records: [record({ employeeId: 'fixture-sensitive', name: 'fixture-name', token: 'fixture-token' })], warnings: ['fixture-raw-error'] }, day);
  const json = JSON.stringify(r); for (const forbidden of ['employeeId', 'fixture-sensitive', 'fixture-name', 'fixture-token', 'fixture-raw-error']) assert.ok(!json.includes(forbidden));
  assert.deepEqual(Object.keys(r).sort(), ['chain', 'period', 'stores', 'warnings']);
  assert.deepEqual(Object.keys(r.stores.norrebro).sort(), ['complete', 'components', 'cost', 'cutoff', 'source', 'warnings']);
});
test('invalid dates, reversed ranges, future cutoffs and excessive ranges rejected', () => {
  for (const args of [{ start: '2026-02-30', end: '2026-03-01' }, { start: '2026-03-01', end: '2026-03-01' }, { start: '2024-01-01', end: '2026-01-01' }, { start: '2026-09-22', end: '2026-09-23', cutoff: '2026-09-24T12:00:00Z' }]) assert.throws(() => p.period(args, Date.parse('2026-09-23T12:00:00Z')));
});
test('live scheduling minute-precision times are Copenhagen local', () => {
  assert.equal(p.localInstant('2026-09-22T10:00'), Date.parse('2026-09-22T08:00:00Z'));
});
test('BusinessDays uses configured weekday weights when departmentWeight is zero', () => {
  const f = addSalary(fixture()); f.allocations.set('fixture-hourly', [{ validFrom: '2026-01-01', costAllocation: 'BusinessDays',
    departmentDistributions: [{ department: { id: 148561 }, departmentWeight: 0, weekDaysWeight: { monday: 100, tuesday: 100 } }] }]);
  assert.equal(calculate(f).stores.vesterbro.components.salaried, 1000);
});
test('daily correction is estimated over its matched shift and never future hours', () => {
  const f = fixture(); f.payroll.supplementsPayroll = [{ employeeId: 'fixture-hourly', salary: -40, start: '2026-09-22T00:00:00', end: '2026-09-23T00:00:00' }];
  const w = p.period({ start: '2026-09-22', end: '2026-09-23', cutoff: '2026-09-22T12:00:00Z' }, Date.parse('2026-09-22T13:00:00Z'));
  const r = calculate(f, w); assert.equal(r.chain.cost, 580); assert.equal(r.stores.norrebro.components.adjustments, -20); assert.equal(r.chain.source, 'estimated');
});
test('duplicate monthly salaries are idempotent and conflicts fail closed', () => {
  const f = addSalary(fixture()); f.payroll.salariedPayroll.push(structuredClone(f.payroll.salariedPayroll[0])); assert.equal(calculate(f).chain.cost, 2200);
  f.payroll.salariedPayroll[1].salary = 999; assert.equal(calculate(f).chain.complete, false);
});
test('date-effective salary department allocation switches on validFrom', () => {
  const f = addSalary(fixture()); f.allocations.set('fixture-hourly', [
    { validFrom: '2026-01-01', departmentDistributions: [{ department: { id: 148561 }, departmentWeight: 1 }] },
    { validFrom: '2026-09-22', departmentDistributions: [{ department: { id: 149700 }, departmentWeight: 1 }] },
  ]); assert.equal(calculate(f).stores.norrebro.components.salaried, 1000); assert.equal(calculate(f).stores.vesterbro.components.salaried, 0);
});
test('unknown prototype-like department identifiers fail closed safely', () => {
  for (const departmentId of ['__proto__', 'constructor', 'toString']) {
    const r = p.processPayroll({ records: [record({ departmentId })] }, day);
    assert.equal(r.chain.complete, false); assert.ok(r.warnings.includes('UNKNOWN_DEPARTMENT'));
  }
});
test('unverified normalized break payment flags are rejected', () => {
  assert.throws(() => p.reconstructHourly({ start: 0, end: 3600000, rates: [{ start: 0, end: 3600000, rate: 150 }], breaks: [{ start: 0, end: 1000 }] }), /UNVERIFIED_BREAK/);
});

test('verified Parken, Festival and Office schedules do not invalidate six-store payroll', () => {
  const f = fixture();
  for (const departmentId of Object.keys(p.EXCLUDED_DEPARTMENTS).map(Number)) f.shifts.push({ ...f.shifts[0], id: departmentId, departmentId });
  assert.equal(calculate(f).chain.cost, 1200);
  f.shifts.push({ ...f.shifts[0], id: 42, departmentId: 42 });
  assert.equal(calculate(f).chain.complete, false);
});
test('NoAllocation with broad membership cannot allocate a chain salary from one incidental shift', () => {
  const f = addSalary(fixture()); f.allocations.get('fixture-hourly')[0].costAllocation = 'NoAllocation';
  f.memberships = new Map([['fixture-hourly', { validFrom: '2020-01-01', departmentIds: [149700, 149750] }]]);
  const r = calculate(f); assert.equal(r.chain.complete, false); assert.ok(r.warnings.includes('SALARY_SCOPE_UNDECIDED'));
});
test('sole historically verified store membership allocates salary on a day without shifts', () => {
  const f = addSalary(fixture(), { employeeId: 'fixture-manager' });
  f.allocations.get('fixture-manager')[0].costAllocation = 'NoAllocation';
  f.memberships = new Map([['fixture-manager', { validFrom: '2026-01-01', validTo: '2026-09-22', departmentIds: [148561] }]]);
  assert.equal(calculate(f).stores.vesterbro.components.salaried, 1000);
  f.memberships.get('fixture-manager').validFrom = '2026-09-23';
  assert.equal(calculate(f).chain.complete, false);
});
test('sole verified Office assignment excludes its salary without assigning it to stores', () => {
  const f = addSalary(fixture(), { employeeId: 'fixture-office' });
  f.memberships = new Map([['fixture-office', { validFrom: '2020-01-01', departmentIds: [149750] }]]);
  assert.equal(calculate(f).chain.cost, 1200);
});
function monthlySalaryFixture() {
  const f = addSalary(fixture(), { employeeId: 'fixture-manager', amount: 900 });
  f.allocationShifts = [
    { ...f.shifts[0], id: 2, employeeId: 'fixture-manager', departmentId: 148561, startDateTime: '2026-09-01T10:00:00', endDateTime: '2026-09-01T16:00:00' },
    { ...f.shifts[0], id: 3, employeeId: 'fixture-manager', departmentId: 149750, startDateTime: '2026-09-02T10:00:00', endDateTime: '2026-09-02T13:00:00' },
  ];
  f.allocationCoverage = { from: '2026-09-01', end: '2026-10-01' }; return f;
}
test('complete month hours support off-day accrual and retain outside-operation shares', () => {
  const r = calculate(monthlySalaryFixture()); assert.equal(r.chain.cost, 1800);
  assert.equal(r.stores.vesterbro.components.salaried, 600); assert.equal(r.chain.source, 'estimated');
});
test('incomplete month, unknown department or overlapping salary hours cannot establish a share', () => {
  for (const kind of ['truncated', 'unknown', 'overlap']) {
    const f = monthlySalaryFixture();
    if (kind === 'truncated') f.allocationCoverage.end = '2026-09-23';
    if (kind === 'unknown') f.allocationShifts[1].departmentId = 42;
    if (kind === 'overlap') f.allocationShifts[1] = { ...f.allocationShifts[0], id: 4, departmentId: 149750 };
    assert.equal(calculate(f).chain.complete, false, kind);
    assert.ok(calculate(f).warnings.includes('SALARY_HOURS_UNAVAILABLE'), kind);
  }
});
test('the preceding overnight lookup day cannot bias period salary sharing', () => {
  const f = addSalary(fixture(), { amount: 2000 }); f.payroll.salariedPayroll[0].start = '2026-09-21';
  f.shifts.push({ ...f.shifts[0], id: 2, departmentId: 148561, date: '2026-09-21', startDateTime: '2026-09-21T10:00', endDateTime: '2026-09-21T18:00' });
  const r = calculate(f); assert.equal(r.stores.norrebro.components.salaried, 1000); assert.equal(r.stores.vesterbro.components.salaried, 0);
});
test('effective weekday distributions select the current weekday before weekly fallback', () => {
  const f = addSalary(fixture()); f.allocations.get('fixture-hourly')[0].departmentDistributions = [
    { department: { id: 148561 }, departmentWeight: 0, weekDaysWeight: { monday: 1, tuesday: 0 } },
    { department: { id: 149700 }, departmentWeight: 0, weekDaysWeight: { monday: 0, tuesday: 1 } },
  ]; assert.equal(calculate(f).stores.norrebro.components.salaried, 1000); assert.equal(calculate(f).stores.vesterbro.components.salaried, 0);
});
test('zero nested monetary effect and zero unallocated salary are nonblocking', () => {
  const f = addSalary(fixture(), { employeeId: 'fixture-no-shifts', amount: 0 }); f.allocations.clear();
  f.payroll.shiftsPayroll[0].supplements = [{ duration: 2, modification: 0 }];
  f.payroll.shiftsPayroll[0].breaks = [{ duration: 0, amount: 0, isPaid: false }];
  f.approved.shiftsPayroll = structuredClone(f.payroll.shiftsPayroll);
  assert.equal(calculate(f).chain.cost, 1200);
});
test('outside-operation deductions retain their share and later shifts constrain active accrual', () => {
  const f = fixture(); f.shifts[0].endDateTime = '2026-09-22T14:00:00';
  f.payroll.shiftsPayroll[0].end = f.shifts[0].endDateTime; f.payroll.shiftsPayroll[0].salary = 600;
  f.approved.shiftsPayroll = structuredClone(f.payroll.shiftsPayroll);
  f.shifts.push({ ...f.shifts[0], id: 2, departmentId: 149750, startDateTime: '2026-09-22T16:00:00', endDateTime: '2026-09-22T20:00:00' });
  f.payroll.supplementsPayroll = [{ employeeId: 'fixture-hourly', salary: -40, start: '2026-09-22T00:00:00', end: '2026-09-23T00:00:00' }];
  const w = p.period({ start: '2026-09-22', end: '2026-09-23', cutoff: '2026-09-22T12:00:00Z' }, Date.parse('2026-09-22T13:00:00Z'));
  assert.equal(calculate(f, w).stores.norrebro.components.adjustments, -20);
  assert.equal(calculate(f).stores.norrebro.components.adjustments, -20);
});
test('store-specific failure reasons are not attached to unrelated store responses', () => {
  const r = p.processPayroll({ failures: [{ code: 'SOURCE_COVERAGE_INCOMPLETE', departmentId: 149748 }] }, day);
  assert.ok(!r.stores.vesterbro.warnings.includes('SOURCE_COVERAGE_INCOMPLETE'));
  assert.ok(r.stores.christianshavn.warnings.includes('SOURCE_COVERAGE_INCOMPLETE'));
  assert.ok(r.warnings.includes('SOURCE_COVERAGE_INCOMPLETE'));
});
test('one minute of location overlap uses a bounded estimate; excessive monetary impact fails', () => {
  const f = monthlySalaryFixture();
  f.allocationShifts[1].startDateTime = '2026-09-01T15:59:00'; f.allocationShifts[1].endDateTime = '2026-09-01T19:00:00';
  // 27,000 DKK/month * one minute / nine hours = 50 DKK: too material.
  assert.equal(calculate(f).chain.complete, false);
  f.payroll.salariedPayroll[0].salary = 30;
  const r = calculate(f); assert.equal(r.chain.complete, true); assert.equal(r.chain.source, 'estimated');
  assert.ok(r.warnings.includes('MINUTE_OVERLAP_ESTIMATE')); assert.equal(r.stores.vesterbro.components.salaried, 19.97);
  f.allocationShifts[1].startDateTime = '2026-09-01T15:58:00'; assert.equal(calculate(f).chain.complete, false);
});
test('shift-based sharing does not use hours after the next allocation rule takes effect', () => {
  const f = monthlySalaryFixture();
  f.allocationShifts[0].startDateTime = '2026-09-21T10:00:00'; f.allocationShifts[0].endDateTime = '2026-09-21T16:00:00';
  f.allocationShifts[1].startDateTime = '2026-09-24T10:00:00'; f.allocationShifts[1].endDateTime = '2026-09-24T13:00:00';
  f.allocations.get('fixture-manager').push({ validFrom: '2026-09-23', costAllocation: 'BusinessDays', departmentDistributions: [{ department: { id: 149700 }, departmentWeight: 1 }] });
  assert.equal(calculate(f).stores.vesterbro.components.salaried, 900);
});
