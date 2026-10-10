'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRecordsQuestion } = require('../lib/sales-db/records');
const { buildRanking, periodStart, periodNext } = require('../lib/sales-db/records-query');
const now = Date.parse('2026-11-20T12:00:00Z');
const next = date => periodNext(date, 'day');
function state(date, storeId = 5, changes = {}) {
  return { storeId, date, status: 'complete', evidence: 'complete-single-pass', lineCount: 1,
    observedAt: next(date) + 'T12:00:00Z', revenueIncl: '125', revenueExVat: '100', ...changes };
}
function days(from, until, ids = [5]) {
  const rows = [];
  for (let date = from; date < until; date = next(date)) for (const id of ids) rows.push(state(date, id));
  return rows;
}
const rank = (question, rows, today, facts = []) => buildRanking(rows, facts, parseRecordsQuestion(question).query, today, now);

test('parses every new prompt while preserving daily, weekday and Danish questions', () => {
  for (const [question, period, daypart, scope, limit, iso] of [
    ['Best week ever across the chain', 'week', 'full-day', 'chain', 1, null],
    ['Best month ever across the chain', 'month', 'full-day', 'chain', 1, null],
    ['Best lunch ever in Frederiksberg', 'day', 'lunch', 'store', 1, null],
    ['Best Friday lunch across the chain', 'day', 'lunch', 'chain', 1, 5],
    ['Top 5 weeks across the chain', 'week', 'full-day', 'chain', 5, null],
    ['Top 10 months in Nørrebro', 'month', 'full-day', 'store', 10, null],
    ['Best week in Vesterbro', 'week', 'full-day', 'store', 1, null],
    ['Best day ever in Frederiksberg', 'day', 'full-day', 'store', 1, null],
    ['Top 5 Fridays across the chain', 'day', 'full-day', 'chain', 5, 5],
    ['Bedste fredag frokost i hele kæden', 'day', 'lunch', 'chain', 1, 5],
    ['Top 10 måneder i Nørrebro', 'month', 'full-day', 'store', 10, null],
  ]) {
    const parsed = parseRecordsQuestion(question);
    assert.equal(parsed.ok, true, question);
    assert.deepEqual([parsed.query.period, parsed.query.daypart, parsed.query.scope, parsed.query.limit, parsed.query.weekday?.iso || null],
      [period, daypart, scope, limit, iso]);
  }
});

test('does not silently reinterpret mixed periods, multiple weekdays or unsupported units', () => {
  for (const question of ['Best week lunch in Vesterbro', 'Best Friday month across the chain',
    'Best week and month in Nørrebro', 'Best Monday and Friday in Vesterbro']) {
    assert.equal(parseRecordsQuestion(question).code, 'AMBIGUOUS_PERIOD');
  }
  assert.equal(parseRecordsQuestion('Top 100 weeks across the chain').code, 'INVALID_LIMIT');
  assert.equal(parseRecordsQuestion('Best year in Vesterbro').code, 'UNSUPPORTED_PERIOD');
});

test('calendar periods cross year, leap-month and DST boundaries without elapsed-hour assumptions', () => {
  assert.equal(periodStart('2026-01-01', 'week'), '2025-12-29');
  assert.equal(periodNext('2025-12-29', 'week'), '2026-01-05');
  assert.equal(periodNext('2024-02-01', 'month'), '2024-03-01');
  assert.equal(periodNext('2025-12-01', 'month'), '2026-01-01');
  for (const monday of ['2026-03-23', '2026-10-19']) {
    const end = periodNext(monday, 'week');
    const response = rank('Best week in Frederiksberg', days(monday, end), end);
    assert.equal(response.results[0].revenueExVat, 700);
    assert.equal(response.coverage.stores[0].eligibleDays, 7);
  }
});

test('weeks require seven covered dates and exclude the current week even with high revenue', () => {
  const complete = days('2026-09-21', '2026-09-28');
  const rows = [...complete, state('2026-09-28', 5, { revenueExVat: '100000' })];
  const response = rank('Best week in Frederiksberg', rows, '2026-09-30');
  assert.equal(response.results[0].periodStart, '2026-09-21');
  assert.equal(response.results[0].periodEnd, '2026-09-27');
  assert.equal(response.results[0].revenueExVat, 700);
  assert.equal(response.coverage.cutoffExclusive, '2026-09-28');
  const partial = rank('Best week in Frederiksberg', complete.slice(1), '2026-09-30');
  assert.deepEqual(partial.results, []);
  assert.equal(partial.coverage.exclusions.missingCoverage.storeDays, 1);
  assert.equal(partial.coverage.historyFrom, '2026-09-22');
});

test('months require every calendar day including February 29 and exclude unfinished months', () => {
  const rows = days('2024-02-01', '2024-03-01');
  const full = rank('Best month in Frederiksberg', [...rows, state('2024-03-01')], '2024-03-15');
  assert.equal(full.results[0].periodEnd, '2024-02-29');
  assert.equal(full.results[0].revenueExVat, 2900);
  assert.equal(full.coverage.cutoffExclusive, '2024-03-01');
  const partial = rank('Best month in Frederiksberg', rows.slice(0, -1), '2024-03-01');
  assert.equal(partial.coverage.exclusions.missingCoverage.storeDays, 1);
  assert.deepEqual(partial.results, []);
});

test('one missing or unverified store-day disqualifies an entire chain week; verified closures provide zero', () => {
  const rows = days('2026-09-21', '2026-09-28', [1, 2, 3, 4, 5, 6]);
  assert.equal(rank('Best week across the chain', rows, '2026-09-28').results[0].revenueExVat, 4200);
  const missing = rank('Best week across the chain', rows.slice(1), '2026-09-28');
  assert.deepEqual(missing.results, []);
  assert.deepEqual(missing.coverage.excludedExamples[0].reasons[0].stores, ['indre-by']);
  for (const status of ['ZERO_OBSERVED_PENDING_REVIEW', 'RETRY_REQUIRED']) {
    const response = rank('Best week across the chain', [{ ...rows[0], status }, ...rows.slice(1)], '2026-09-28');
    assert.equal(response.coverage.exclusions.unverifiedCoverage.storeDays, 1);
  }
  const closed = state(rows[0].date, 1, { status: 'VERIFIED_CLOSED', evidence: 'verified-closed', lineCount: 0, revenueExVat: '0', revenueIncl: '0' });
  assert.equal(rank('Best week across the chain', [closed, ...rows.slice(1)], '2026-09-28').results[0].revenueExVat, 4100);
});

test('invalid, future or same-day observations never certify historical coverage', () => {
  for (const observedAt of [null, 'invalid', '2026-09-21T12:00:00Z', '2030-01-01T12:00:00Z']) {
    const response = rank('Best day in Frederiksberg', [state('2026-09-21', 5, { observedAt })], '2026-09-22');
    assert.deepEqual(response.results, []);
    assert.equal(response.coverage.exclusions.invalidObservation.periods, 1);
  }
});

test('day and lunch exclude today/future dates and coverage observations use Copenhagen midnight', () => {
  const rows = [state('2026-09-21', 5, { observedAt: '2026-09-21T22:00:00Z' }),
    state('2026-09-22', 5, { revenueExVat: '9999' }), state('2026-09-23', 5, { revenueExVat: '99999' })];
  for (const question of ['Best day in Frederiksberg', 'Best lunch in Frederiksberg']) {
    const result = rank(question, rows, '2026-09-22', rows.map(row => ({ ...row, lunchRevenue: '80', uncertainCount: 0 })));
    assert.equal(result.results[0].date, '2026-09-21');
    assert.equal(result.coverage.consideredPeriods, 1);
    const sameLocalDay = rank(question, [{ ...rows[0], observedAt: '2026-09-21T21:59:59Z' }], '2026-09-22');
    assert.equal(sameLocalDay.coverage.exclusions.invalidObservation.periods, 1);
  }
});

test('lunch does not treat missing facts as zero and rejects uncertain timing or unreconciled totals', () => {
  const row = state('2026-09-25');
  const fact = { ...row, lunchRevenue: '60', uncertainCount: 0 };
  assert.equal(rank('Best Friday lunch in Frederiksberg', [row], '2026-09-26', [fact]).results[0].revenueExVat, 60);
  for (const broken of [undefined, { ...fact, lineCount: 2 }, { ...fact, revenueExVat: '99' }, { ...fact, revenueIncl: '124' }]) {
    const result = rank('Best lunch in Frederiksberg', [row], '2026-09-26', broken ? [broken] : []);
    assert.deepEqual(result.results, []);
    assert.equal(result.coverage.exclusions.factsMismatch.periods, 1);
  }
  const uncertain = rank('Best lunch in Frederiksberg', [row], '2026-09-26', [{ ...fact, uncertainCount: 1, missingCount: 1 }]);
  assert.deepEqual(uncertain.results, []);
  assert.equal(uncertain.coverage.timing.uncertainLines, 1);
  const closed = { ...row, status: 'VERIFIED_CLOSED', evidence: 'verified-closed', lineCount: 0, revenueExVat: '0', revenueIncl: '0' };
  assert.equal(rank('Best lunch in Frederiksberg', [closed], '2026-09-26').results[0].revenueExVat, 0);
});

test('rankings use exact decimals and stable ties, while coverage spans all candidates beyond the limit', () => {
  const response = rank('Top 1 days in Frederiksberg', [state('2026-09-21', 5, { revenueExVat: '1.000000000000000001' }),
    state('2026-09-22', 5, { revenueExVat: '1.000000000000000002' })], '2026-09-23');
  assert.equal(response.results[0].date, '2026-09-22');
  assert.equal(response.coverage.eligiblePeriods, 2);
  assert.equal(response.coverage.eligibleFrom, '2026-09-21');
  assert.equal(response.coverage.eligibleThrough, '2026-09-22');
  assert.equal(rank('Best day in Frederiksberg', days('2026-09-21', '2026-09-23'), '2026-09-23').results[0].date, '2026-09-21');
});

test('empty history, fully missing interior periods and bounded exclusion examples are explicit', () => {
  const empty = rank('Best month across the chain', [], '2026-10-10');
  assert.equal(empty.coverage.historyFrom, null); assert.equal(empty.coverage.eligiblePeriods, 0);
  const gap = rank('Best day across the chain', [state('2026-01-01', 1), state('2026-02-01', 1)], '2026-02-02');
  assert.equal(gap.coverage.consideredPeriods, 32);
  assert.equal(gap.coverage.excludedPeriods, 32);
  assert.equal(gap.coverage.excludedExamples.length, 12);
  assert.equal(gap.coverage.excludedExamplesOmitted, 20);
});
