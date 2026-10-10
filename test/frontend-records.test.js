'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf('const RECORD_PROMPTS ='), html.indexOf('function useRecordsPrompt'));
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const main = { innerHTML: '' };
const ui = vm.createContext({ Intl, Date, escHtml: escape, state: { recordsQuestion: '', recordsResponse: null }, document: { getElementById: () => main } });
vm.runInContext(source, ui);
const { buildRanking } = require('../lib/sales-db/records-query');
const { parseRecordsQuestion } = require('../lib/sales-db/records');
function response(question, states = [], facts = []) {
  const query = parseRecordsQuestion(question).query;
  const { results, coverage } = buildRanking(states, facts, query, '2026-10-10', Date.parse('2026-10-10T12:00:00Z'));
  return { query, results, meta: { coverage } };
}
test('Records keeps the existing form and includes day/week/month/lunch suggested prompts', () => {
  ui.renderRecordsView();
  for (const text of ['Best day ever in Frederiksberg', 'Best week ever across the chain',
    'Best month ever across the chain', 'Best lunch ever in Frederiksberg', 'Best Friday lunch across the chain']) assert(main.innerHTML.includes(text));
  assert(main.innerHTML.includes('id="records-question"'));
});
test('empty rankings still explain historical coverage and uncertain lunch timestamps', () => {
  const row = { storeId: 5, date: '2026-10-09', status: 'complete', evidence: 'complete-single-pass',
    observedAt: '2026-10-10T01:00:00Z', lineCount: 1, revenueExVat: '8', revenueIncl: '10' };
  const r = response('Best lunch in Frederiksberg', [row], [{ ...row, uncertainCount: 1, missingCount: 1, lunchRevenue: '0' }]);
  const text = ui.renderRecordsResults(r);
  assert(text.includes('No eligible complete periods')); assert(text.includes('Historical coverage'));
  assert(text.includes('uncertain transaction timestamps')); assert(text.includes('16:00'));
  assert(text.includes('Missing days are never treated as zero'));
});
test('period labels, chain breakdowns and exclusions are visible and untrusted store names are escaped', () => {
  const r = response('Best month across the chain');
  r.results = [{ date: '2026-09-01', periodStart: '2026-09-01', periodEnd: '2026-09-30', revenueExVat: 600,
    stores: [{ name: '<script>bad</script>', revenueExVat: 100 }] }];
  const text = ui.renderRecordsResults(r);
  assert(text.includes('September 2026')); assert(text.includes('#1')); assert(text.includes('Revenue ex VAT'));
  assert(!text.includes('<script>bad')); assert(text.includes('&lt;script&gt;bad'));
  assert.equal(ui.recordsPeriodLabel({ periodStart: '2026-09-28', periodEnd: '2026-10-04' }, { period: 'week' }),
    'Monday, 28 September 2026 – Sunday, 4 October 2026');
});
