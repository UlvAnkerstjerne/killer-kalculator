'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf('// ── Records Hall of Fame'), html.indexOf('function renderMain()'));
const RecordsLeaderboards = require('../lib/records-leaderboards');
const { STORES } = require('../lib/sales-db/records');
const { buildRanking, periodNext } = require('../lib/sales-db/records-query');
const { storeId } = require('../lib/sales-db/values');
const rows = [];
for (let date = '2026-08-01'; date < '2026-10-10'; date = periodNext(date, 'day')) for (const store of STORES) rows.push({
  storeId: storeId(store.slug), date, status: 'complete', evidence: 'complete-single-pass', lineCount: 1,
  observedAt: periodNext(date, 'day') + 'T00:00:00Z', revenueIncl: '125', revenueExVat: '100',
});
function batch(store, group) {
  const scope = { scope: store === 'all' ? 'chain' : 'store', store: STORES.find(s => s.slug === store) || null };
  return { scope, group, meta: { today: '2026-10-10' }, boards: RecordsLeaderboards.BOARDS.filter(b => b.group === group).map(b => {
    const query = { ...scope, period: b.period, daypart: b.daypart || 'full-day', weekday: b.weekday, limit: 5 };
    return { id: b.id, query, ...buildRanking(rows, rows.map(r => ({ ...r, lunchRevenue: '40', uncertainCount: 0 })), query, '2026-10-10', Date.parse('2026-10-10T12:00:00Z')) };
  }) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function createUi(fetchBatch = async (store, group) => batch(store, group)) {
  const elements = new Map(), calls = [], events = {}, historyEntries = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', focused: false, scrolled: false,
      focus() { this.focused = true; }, scrollIntoView() { this.scrolled = true; } });
    return elements.get(id);
  };
  const state = { view: 'records', recordsStore: 'all', recordsBoard: 'days', recordsDate: null };
  const ui = vm.createContext({ RecordsLeaderboards, Intl, Date, URLSearchParams, sessionActive: true, sessionNonce: 1,
    STORES: STORES.map(s => ({ id: s.slug, name: s.name })), state, document: { getElementById: id => {
      if (!id || (id.startsWith('record-') && ![...elements.values()].some(el => el.innerHTML.includes(`id="${id}"`)))) return null;
      return element(id);
    } },
    location: { hash: '', pathname: '/', search: '' }, window: { addEventListener: (event, handler) => { events[event] = handler; } },
    escHtml: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    unixToCphDate: () => '2026-10-10', closeSidebar() {}, resetSalesDataNotices() {}, updateNav() {}, loadSidebar() {},
    apiFetch: async url => { const p = new URL(url, 'http://localhost').searchParams; calls.push(url);
      return { ok: true, json: () => fetchBatch(p.get('store'), p.get('group')) }; },
  });
  vm.runInContext(source, ui);
  ui.history = { pushState: (_state, _title, url) => { historyEntries.push(url); ui.location.hash = ''; } };
  ui.renderMain = () => state.view === 'records' ? ui.renderRecordsView() : (element('main').innerHTML = 'Dashboard');
  ui.renderSidebarSkeleton = () => ui.renderRecordsStoreSelector();
  vm.runInContext(html.slice(html.indexOf('function setView('), html.indexOf('function setPeriod(')), ui);
  return { ui, state, element, calls, events, historyEntries };
}

test('Hall of Fame automatically populates twelve top-five boards using only two batch requests', async () => {
  const { ui, element, calls } = createUi(); ui.renderRecordsView(); await settle(); await settle();
  assert.equal(calls.length, 2);
  const main = element('main').innerHTML;
  assert(main.includes('Hall of Fame')); assert(!main.includes('records-question'));
  for (const b of RecordsLeaderboards.BOARDS) {
    assert(main.includes(`id="records-${b.id}"`));
    assert(element('records-' + b.id).innerHTML.includes('Revenue ex VAT'));
    const expected = b.id === 'months' ? 2 : 5;
    assert.equal((element('records-' + b.id).innerHTML.match(/class="records-entry/g) || []).length, expected);
  }
  assert(element('records-weekends').innerHTML.includes('1–2 Aug 2026'));
  assert(element('records-months').innerHTML.includes('August 2026'));
  ui.renderRecordsView(); await settle(); assert.equal(calls.length, 2);
});

test('the single sidebar scope selector includes combined and six stores, with selected scope semantics', () => {
  const { ui, state, element } = createUi(); state.recordsStore = 'norrebro'; ui.renderRecordsStoreSelector();
  const selectors = element('store-list').innerHTML;
  assert.equal((selectors.match(/<button/g) || []).length, 7); assert(selectors.includes('All Stores Combined'));
  assert.equal((selectors.match(/aria-pressed="true"/g) || []).length, 1); assert(selectors.includes('Nørrebro'));
});

test('ordinary Records entry keeps the page heading in view; period labels retain month/year boundaries', async () => {
  const { ui, events, element } = createUi(); ui.location.hash = '#records'; events.hashchange(); await settle(); await settle();
  assert.equal(element('records-days').focused, false);
  assert.equal(ui.recordsPeriodLabel({ periodStart: '2026-08-31', periodEnd: '2026-09-06' }, { period: 'week' }), '31 Aug – 6 Sept 2026');
  assert.equal(ui.recordsPeriodLabel({ periodStart: '2022-12-31', periodEnd: '2023-01-01' }, { period: 'weekend' }), '31 Dec 2022 – 1 Jan 2023');
});

test('changing scopes cannot paint a late old-store response into the current leaderboards', async () => {
  let release;
  const { ui, state, element, calls } = createUi(async (store, group) => store === 'all' ? new Promise(r => { release = r; }) : batch(store, group));
  ui.renderRecordsView(); await settle(); state.recordsStore = 'vesterbro'; ui.renderRecordsView(); await settle(); await settle();
  release(batch('all', 'standard')); await settle();
  assert.equal(calls.length, 3); // Obsolete scope does not start a lunch request.
  assert(!element('records-days').innerHTML.includes('By store'));
  assert(element('main').innerHTML.includes('Vesterbro'));
});

test('lunch failure preserves loaded calendar boards, explains unavailable state and can retry', async () => {
  let fail = true;
  const { ui, element, calls } = createUi(async (store, group) => { if (group === 'lunch' && fail) throw new Error('offline'); return batch(store, group); });
  ui.renderRecordsView(); await settle(); await settle();
  assert(element('records-days').innerHTML.includes('records-entry'));
  assert(element('records-lunches').innerHTML.includes('Temporarily unavailable'));
  fail = false; ui.retryRecordsGroup('lunch'); await settle();
  assert(element('records-lunches').innerHTML.includes('records-entry')); assert.equal(calls.length, 3);
});

test('empty coverage and timestamp limitations remain visible without inventing zero-ranked entries', () => {
  const { ui, element } = createUi(); const response = batch('all', 'lunch'); const b = response.boards[0];
  b.results = []; b.coverage.eligiblePeriods = 0; b.coverage.eligibleFrom = null; b.coverage.eligibleThrough = null;
  b.coverage.exclusions.timestampUncertainty = { periods: 1, storeDays: 1 }; b.coverage.excludedPeriods = 1; b.coverage.timing.uncertainLines = 1;
  ui.fixture = response; vm.runInContext('recordsBatches.lunch = fixture', ui); ui.updateRecordsGroup('lunch');
  const text = element('records-lunches').innerHTML;
  assert(text.includes('No complete, eligible records')); assert(!text.includes('class="records-entry'));
  assert(text.includes('uncertain transaction timestamps')); assert(text.includes('16:00')); assert(text.includes('Missing days are never treated as zero'));
});

test('celebration links restore scope and category and focus the matching board or dated record', async () => {
  const { ui, state, events, element } = createUi();
  ui.location.hash = '#records?store=norrebro&board=weekends&date=2026-08-01'; events.hashchange(); await settle(); await settle();
  assert.equal(state.recordsStore, 'norrebro'); assert.equal(state.recordsBoard, 'weekends');
  assert(element('records-weekends').focused); assert(element('record-weekends-2026-08-01').scrolled);
  assert(element('records-weekends').innerHTML.includes('is-linked'));
  ui.location.hash = '#records?store=all&board=months&date=2025-01-01'; events.hashchange(); await settle(); await settle();
  assert(element('records-months').innerHTML.includes('outside the current top five or is not eligible'));
  assert(element('records-months').scrolled);
  ui.location.hash = ''; events.hashchange(); assert.equal(state.view, 'chain');
});

test('logout and refresh invalidate in-flight responses before they reach the UI', async () => {
  let release;
  const { ui, element } = createUi(() => new Promise(r => { release = r; }));
  ui.renderRecordsView(); await settle();
  vm.runInContext('sessionActive = false; sessionNonce++; recordsClient.clear(); recordsViewGeneration++; recordsBatches = {};', ui);
  release(batch('all', 'standard')); await settle();
  assert(!element('records-days').innerHTML.includes('class="records-entry'));
  assert.match(html, /recordsClient\.clear\(\);[\s\n]+recordsViewGeneration\+\+/);
});

test('leaving Records preserves its link for Back, without adding history during back/forward events', async () => {
  const { ui, state, events, historyEntries } = createUi();
  const link = '#records?store=frederiksberg&board=lunches';
  ui.location.hash = link; events.hashchange(); await settle(); await settle();
  ui.setView('chain'); assert.equal(state.view, 'chain'); assert.deepEqual(historyEntries, ['/']);
  ui.location.hash = link; events.hashchange(); await settle(); await settle();
  assert.equal(state.view, 'records'); assert.equal(state.recordsStore, 'frederiksberg'); assert.equal(state.recordsBoard, 'lunches');
  ui.location.hash = ''; events.hashchange(); assert.equal(state.view, 'chain'); assert.deepEqual(historyEntries, ['/']);
});

test('untrusted store names are escaped in per-store breakdowns and coverage', () => {
  const { ui } = createUi(); const b = batch('all', 'standard').boards[0]; b.results[0].stores[0].name = '<script>bad</script>';
  ui.fixture = { boards: [b] }; vm.runInContext('recordsBatches.standard = fixture', ui);
  const text = ui.renderRecordBoard(RecordsLeaderboards.BOARDS[0]);
  assert(!text.includes('<script>')); assert(text.includes('&lt;script&gt;bad'));
});
