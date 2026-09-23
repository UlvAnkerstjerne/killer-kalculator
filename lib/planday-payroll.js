'use strict';

// Normalized payroll records are server-only. Public results are constructed here
// from an explicit allowlist; no upstream object is spread into a response.
const { cphMidnightUnix } = require('./pos-fetcher');
const DEPARTMENTS = Object.freeze({
  148561: 'vesterbro', 149668: 'indre-by', 149700: 'norrebro',
  149715: 'frederiksberg', 149725: 'fisketorvet', 149748: 'christianshavn',
});
const STORE_IDS = Object.freeze(Object.values(DEPARTMENTS));
const COMPONENTS = ['hourly', 'salaried', 'supplements', 'adjustments'];
const SOURCES = ['actual', 'scheduled', 'estimated'];
const CODES = new Set(['UPSTREAM_UNAVAILABLE', 'INVALID_SCHEMA', 'PAGINATION_INCOMPLETE',
  'UNKNOWN_DEPARTMENT', 'MAPPING_UNAVAILABLE', 'CONFLICTING_DUPLICATE', 'MISSING_PAY_DATA',
  'UNALLOCATED_SALARY', 'UNALLOCATED_ADJUSTMENT', 'UNVERIFIED_BREAK_OR_SUPPLEMENT',
  'AMBIGUOUS_LOCAL_TIME', 'CUTOFF_UNSUPPORTED', 'SALARY_ALLOCATION_ESTIMATE',
  'PARTIAL_SHIFT_ESTIMATE', 'UNAPPROVED_SHIFTS', 'CURRENCY_UNVERIFIED',
  'ALLOCATION_HISTORY_UNAVAILABLE', 'SOURCE_COVERAGE_INCOMPLETE', 'ADJUSTMENT_ALLOCATION_ESTIMATE']);
function dateValid(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    s >= '2000-01-01' && s <= '2100-12-31' &&
    Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
}
function nextDate(s, days = 1) {
  return new Date(Date.parse(s + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}
function cphDate(ms) { return new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Copenhagen' }).format(new Date(ms)); }
function midnight(s) { return cphMidnightUnix(s) * 1000; }
// Offset-free Planday times are Copenhagen wall-clock times, not browser/host time.
// Ambiguous fall-back times and nonexistent spring times require explicit offsets.
function localInstant(s) {
  if (typeof s !== 'string') throw new Error('INVALID_SCHEMA');
  s = s.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})?$/, '$1:00$2');
  if (!dateValid(s.slice(0, 10)) || Number(s.slice(11, 13)) > 23 || Number(s.slice(14, 16)) > 59 || Number(s.slice(17, 19)) > 59) throw new Error('INVALID_SCHEMA');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(s)) {
    const ms = Date.parse(s); if (Number.isFinite(ms)) return ms;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(s) || !dateValid(s.slice(0, 10))) throw new Error('INVALID_SCHEMA');
  const target = s.slice(0, 19).replace('T', ' ');
  const fmt = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Copenhagen', dateStyle: 'short', timeStyle: 'medium' });
  const candidates = [1, 2].map(h => Date.parse(s + 'Z') - h * 3600000)
    .filter(ms => fmt.format(new Date(ms)) === target);
  if (candidates.length !== 1) throw new Error('AMBIGUOUS_LOCAL_TIME');
  return candidates[0];
}
function period({ start, end, cutoff }, now = Date.now()) {
  if (!dateValid(start) || !dateValid(end) || start >= end ||
      (Date.parse(end) - Date.parse(start)) / 86400000 > 366) throw new Error('INVALID_PERIOD');
  const from = midnight(start), fullEnd = midnight(end);
  let until = Math.min(fullEnd, Math.floor(now / 1000) * 1000);
  if (cutoff !== undefined && cutoff !== null) {
    if (typeof cutoff !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(cutoff) || !dateValid(cutoff.slice(0, 10)) || Number(cutoff.slice(11, 13)) > 23 || Number(cutoff.slice(14, 16)) > 59 || Number(cutoff.slice(17, 19)) > 59) throw new Error('INVALID_CUTOFF');
    const requested = Date.parse(cutoff);
    if (!Number.isFinite(requested) || requested > now || requested > fullEnd || requested < from) throw new Error('INVALID_CUTOFF');
    until = requested;
  }
  if (until < from) throw new Error('FUTURE_PERIOD');
  return { start, end, from, until, fullEnd, active: fullEnd > now, cutoff: new Date(until).toISOString() };
}
function storeForDepartment(id) { return Object.hasOwn(DEPARTMENTS, id) ? DEPARTMENTS[id] : undefined; }
function safeCode(code) { return CODES.has(code) ? code : 'INVALID_SCHEMA'; }
function money(n) { if (!Number.isFinite(n) || !Number.isSafeInteger(Math.round(n * 100))) throw new Error('MISSING_PAY_DATA'); return n; }
function splitOre(total, weights) {
  if (!Number.isSafeInteger(total) || !weights.length || weights.some(x => !Number.isFinite(x.weight) || x.weight < 0)) throw new Error('INVALID_SCHEMA');
  const denominator = weights.reduce((s, x) => s + x.weight, 0);
  if (!(denominator > 0)) throw new Error('UNALLOCATED_SALARY');
  const magnitude = Math.abs(total), sign = Math.sign(total);
  const rows = weights.map((x, i) => ({ ...x, i, value: Math.floor(magnitude * x.weight / denominator), fraction: (magnitude * x.weight / denominator) % 1 }));
  let remaining = magnitude - rows.reduce((s, x) => s + x.value, 0);
  for (const x of [...rows].sort((a, b) => b.fraction - a.fraction || a.i - b.i)) if (remaining-- > 0) x.value++;
  return rows.map(x => ({ departmentId: x.departmentId, amountOre: sign * x.value }));
}
function sourceOf(sources) { return SOURCES[Math.max(0, ...sources.map(x => SOURCES.indexOf(x)))]; }
function percentage(result, revenueExVat) {
  return result?.complete && Number.isFinite(result.cost) && Number.isFinite(revenueExVat) && revenueExVat > 0
    ? result.cost / revenueExVat * 100 : null;
}
function reconstructHourly({ start, end, rates, breaks = [] }, from = start, until = end) {
  // Rates and break windows must already have verified semantics at normalization.
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Array.isArray(rates) || !rates.length) throw new Error('MISSING_PAY_DATA');
  if (breaks.some(b => typeof b.paid !== 'boolean' || !Number.isFinite(b.start) || !Number.isFinite(b.end) || b.end <= b.start)) throw new Error('UNVERIFIED_BREAK_OR_SUPPLEMENT');
  let cost = 0;
  const points = [...new Set([start, end, from, until, ...rates.flatMap(x => [x.start, x.end]), ...breaks.flatMap(x => [x.start, x.end])])]
    .filter(x => Number.isFinite(x) && x >= Math.max(start, from) && x <= Math.min(end, until)).sort((a, b) => a - b);
  if (points.length < 2) return 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const matching = rates.filter(x => x.start <= a && b <= x.end);
    if (matching.length !== 1 || !Number.isFinite(matching[0].rate)) throw new Error('MISSING_PAY_DATA');
    if (!breaks.some(x => x.paid === false && x.start <= a && b <= x.end)) cost += (b - a) / 3600000 * matching[0].rate;
  }
  return cost;
}
function processPayroll({ records = [], failures = [], warnings = [], covered = true }, window) {
  const bags = Object.fromEntries(STORE_IDS.map(id => [id, { amounts: Object.fromEntries(COMPONENTS.map(x => [x, 0])), sources: [], warnings: new Set(), reasons: new Set() }]));
  const globalWarnings = new Set(warnings.map(safeCode));
  function fail(code, departmentId) {
    code = safeCode(code); globalWarnings.add(code);
    const id = storeForDepartment(departmentId);
    for (const bag of id ? [bags[id]] : Object.values(bags)) bag.reasons.add(code);
  }
  if (!covered) fail('SOURCE_COVERAGE_INCOMPLETE');
  failures.forEach(f => fail(f.code, f.departmentId));
  const seen = new Map();
  for (const r of records) {
    try {
      if (r.id === undefined || !SOURCES.includes(r.source) || !COMPONENTS.includes(r.component)) throw new Error('INVALID_SCHEMA');
      const fingerprint = JSON.stringify([r.departmentId, r.start, r.end, r.amount, r.source, r.component, r.hourly, r.prorate]);
      if (seen.has(r.id)) {
        const prev = seen.get(r.id);
        if (prev.fingerprint !== fingerprint) { fail('CONFLICTING_DUPLICATE', prev.departmentId); fail('CONFLICTING_DUPLICATE', r.departmentId); }
        continue;
      }
      seen.set(r.id, { fingerprint, departmentId: r.departmentId });
      if (!storeForDepartment(r.departmentId)) { fail('UNKNOWN_DEPARTMENT'); continue; }
      if (!Number.isFinite(r.start) || !Number.isFinite(r.end) || r.end <= r.start) throw new Error('INVALID_SCHEMA');
      const from = Math.max(window.from, r.start), until = Math.min(window.until, r.end);
      if (until <= from) continue;
      const bag = bags[storeForDepartment(r.departmentId)];
      let cost = money(r.amount), source = r.source;
      if (from !== r.start || until !== r.end) {
        if (r.hourly) cost = reconstructHourly(r.hourly, from, until);
        else if (r.prorate === 'elapsed') cost *= (until - from) / (r.end - r.start);
        else throw new Error('CUTOFF_UNSUPPORTED');
        source = 'estimated'; bag.warnings.add('PARTIAL_SHIFT_ESTIMATE');
      }
      bag.amounts[r.component] += cost;
      bag.sources.push(source);
    } catch (err) { fail(err.message, r.departmentId); }
  }
  const stores = {};
  for (const id of STORE_IDS) {
    const bag = bags[id], complete = bag.reasons.size === 0;
    // Round once per store component to øre, then sum the components. No per-hour
    // rounding. Shared allocations use splitOre, conserving every signed øre.
    const componentOre = Object.fromEntries(COMPONENTS.map(k => [k, Math.round(bag.amounts[k] * 100)]));
    stores[id] = { cost: complete ? Object.values(componentOre).reduce((s, n) => s + n, 0) / 100 : null,
      source: sourceOf(bag.sources), complete, cutoff: window.cutoff,
      components: complete ? Object.fromEntries(COMPONENTS.map(k => [k, componentOre[k] / 100])) : null,
      warnings: [...new Set([...globalWarnings, ...bag.warnings, ...bag.reasons])].sort() };
  }
  const complete = STORE_IDS.every(id => stores[id].complete);
  return { stores, chain: { cost: complete ? STORE_IDS.reduce((s, id) => s + Math.round(stores[id].cost * 100), 0) / 100 : null,
    source: sourceOf(STORE_IDS.map(id => stores[id].source)), complete, cutoff: window.cutoff },
    period: { start: window.start, end: window.end, cutoff: window.cutoff, active: window.active },
    warnings: [...new Set([...globalWarnings, ...Object.values(stores).flatMap(s => s.warnings)])].sort() };
}
module.exports = { DEPARTMENTS, STORE_IDS, dateValid, nextDate, cphDate, midnight, localInstant, period, splitOre,
  percentage, reconstructHourly, processPayroll, safeCode, storeForDepartment };
