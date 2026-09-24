'use strict';
const { nextDate, localInstant, storeForDepartment } = require('./planday-payroll');
const OMIT = new Set(['Open', 'Draft', 'Cancelled', 'Deleted']);
async function batches(rows, fn) {
  const out = [];
  for (let i = 0; i < rows.length; i += 5) {
    const results = await Promise.allSettled(rows.slice(i, i + 5).map(fn));
    for (const r of results) out.push(r.status === 'fulfilled' ? r.value : null);
  }
  return out;
}
// Raw documents remain request-local. Fetch failures are represented by missing
// coverage, never by an empty successful attendance response.
async function loadAttendance({ client, input, window, workerRules, now }) {
  const monthStart = window.start.slice(0, 7) + '-01';
  const lastDate = require('./planday-payroll').cphDate(Math.max(window.from, window.until - 1));
  const monthEnd = nextDate(lastDate.slice(0, 7) + '-28', 4).slice(0, 7) + '-01';
  const months = [];
  for (let from = monthStart; from < monthEnd;) {
    const end = nextDate(from.slice(0, 7) + '-28', 4).slice(0, 7) + '-01';
    months.push({ from, to: nextDate(end, -1) }); from = end;
  }
  const monthly = await batches(months, async range => {
    const body = await client.get('/payroll/v1/payroll', { ...range,
      departmentIds: input.departments.map(d => d.id).join(','), returnFullSalaryForMonthlyPaid: false });
    if (!body || !['kr.', 'kr', 'DKK'].includes(body.currencySymbol) ||
        ['salariedPayroll', 'shiftsPayroll'].some(k => !Array.isArray(body[k]))) throw new Error();
    return { ...range, payroll: body };
  });
  const candidates = new Set(input.payroll.salariedPayroll.map(p => p.employeeId));
  for (const m of monthly) for (const p of m?.payroll.salariedPayroll || []) candidates.add(p.employeeId);
  const ordinary = new Set(input.shifts.filter(s => storeForDepartment(s.departmentId) && s.employeeId && !OMIT.has(s.status)).map(s => s.id));
  let attendance = null;
  if (candidates.size || ordinary.size) {
    try {
      // The live endpoint rejects spans longer than 31 days. Keep the
      // preceding overnight day separate from each calendar-month request.
      const ranges = [{ from: nextDate(monthStart, -1), to: nextDate(monthStart, -1) }, ...months];
      const pages = await batches(ranges, range => client.all('/punchclock/v1.0/punchclockshifts', {
        from: range.from + 'T00:00', to: nextDate(range.to) + 'T00:00',
      }));
      if (pages.some(x => !x)) throw new Error();
      attendance = pages.flat().filter(a => candidates.has(a.employeeId) || ordinary.has(a.shiftId));
    } catch { /* null explicitly means unavailable, not no work */ }
  } else attendance = [];
  let shiftTypes = null;
  try { shiftTypes = await client.all('/scheduling/v1/shifttypes', {}, 50); } catch { /* fail coverage on unclassified gaps */ }
  const schedule = input.allocationShifts;
  const needed = new Map();
  for (const s of [...schedule, ...input.shifts]) {
    if (!s.employeeId || OMIT.has(s.status)) continue;
    const managed = candidates.has(s.employeeId);
    const unpricedZero = input.payroll.shiftsPayroll.some(p => p.id === s.id && p.salary === 0 && !Number.isFinite(p.wage?.rate));
    const missing = !managed && storeForDepartment(s.departmentId) && !input.payroll.shiftsPayroll.some(p => p.id === s.id) &&
      localInstant(s.startDateTime) < window.until && localInstant(s.endDateTime) > window.from;
    if (managed || missing || unpricedZero) needed.set(s.id, s);
  }
  // List and detail use the same documented GetShiftOutputModel. Live typed
  // absence rows carry shiftTypeId; ordinary rows omit the nullable field.
  // Retain only classification here, avoiding one extra request per shift.
  const details = new Map([...schedule, ...input.shifts].map(s => [s.id, { shiftTypeId: s.shiftTypeId ?? null }]));
  const breaks = new Map();
  await batches(attendance || [], async a => {
    const body = await client.get('/punchclock/v1.0/punchclockshifts/' + encodeURIComponent(a.id) + '/breaks');
    // This endpoint is unpaged and exposes only TotalPaging, not offset/limit.
    if (!Array.isArray(body?.data) || body.paging?.total !== body.data.length) throw new Error();
    breaks.set(a.id, body.data.map(b => ({ startDateTime: b.startDateTime, endDateTime: b.endDateTime })));
  });
  const sickTypes = shiftTypes ? new Set(shiftTypes.filter(t => t.name === 'Sygemelding').map(t => t.id)) : null;
  // Only verified ordinary shift types can use worked-hour fallback. Unknown
  // types remain unclassified rather than being assumed to be work.
  const workingTypes = shiftTypes ? new Set(shiftTypes.filter(t => ['Administration', 'Shift Manager'].includes(t.name)).map(t => t.id)) : null;
  const sickRanges = new Map();
  for (const s of needed.values()) if (sickTypes?.has(details.get(s.id)?.shiftTypeId) && storeForDepartment(s.departmentId) &&
      s.date >= window.start && s.date <= lastDate && !input.payroll.shiftsPayroll.some(p => p.id === s.id)) {
    const from = s.date.slice(0, 7) + '-01', end = nextDate(from.slice(0, 7) + '-28', 4).slice(0, 7) + '-01';
    sickRanges.set(s.departmentId + ':' + from, { departmentId: s.departmentId,
      from: from < window.start ? window.start : from, to: nextDate(end, -1) < lastDate ? nextDate(end, -1) : lastDate });
  }
  const timeCosts = new Map();
  await batches([...sickRanges.values()], async ({ departmentId, from, to }) => {
    const { data } = await client.get('/scheduling/v1/timeandcost/' + departmentId, { from, to });
    if (!Array.isArray(data?.costs) || !['kr.', 'kr', 'DKK'].includes(data.currencySymbol)) throw new Error();
    timeCosts.set(departmentId, [...(timeCosts.get(departmentId) || []), ...data.costs]);
  });
  return { ...input, workerRules, evaluatedAt: now(), monthly, attendance, attendanceBreaks: breaks,
    shiftDetails: details, sickTypes, workingTypes, timeCosts };
}
module.exports = { loadAttendance };
