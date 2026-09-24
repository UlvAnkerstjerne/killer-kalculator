'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const script = html.match(/<script>\s*'use strict';([\s\S]*?)<\/script>/)[1].split('// Auto-restore session')[0];
function browser(tz = 'UTC') {
  const fixedNow = Date.parse('2026-09-23T12:32:00Z');
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [fixedNow])); } static now() { return fixedNow; } }
  const els = new Map();
  const context = vm.createContext({ console, Intl, Date: FixedDate, URLSearchParams, setTimeout, clearTimeout,
    document: { addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
      getElementById(id) { if (!els.has(id)) els.set(id, { innerHTML: '', className: '', classList: { add() {}, remove() {}, toggle() {} }, getContext() { return {}; }, insertAdjacentHTML() {} }); return els.get(id); } },
    window: { ProductMetrics: require('../lib/product-metrics') }, Chart: class { static defaults = { font: {} }; constructor() { this.data = { datasets: [{ data: [] }, { data: [] }] }; } destroy() {} update() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }, timezone: tz,
  });
  vm.runInContext(script + '\nsessionActive = true; sessionNonce = 1;', context);
  return { context, els, run: code => vm.runInContext(code, context) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function response(complete = true) {
  const stores = Object.fromEntries(['indre-by', 'vesterbro', 'christianshavn', 'fisketorvet', 'frederiksberg', 'norrebro'].map(id => [id, {
    cost: complete ? 100 : null, complete, source: 'scheduled', cutoff: '2026-09-23T12:32:00.000Z', components: complete ? { hourly: 100, salaried: 0, supplements: 0, adjustments: 0 } : null, warnings: [],
  }]));
  return { stores, chain: { cost: complete ? 600 : null, complete, source: 'scheduled', cutoff: '2026-09-23T12:32:00.000Z' },
    period: { start: '2026-09-23', end: '2026-09-24', active: true, cutoff: '2026-09-23T12:32:00.000Z' }, warnings: [] };
}

test('browser wrapper uses ISO dates, common sales cutoff, and ex-VAT revenue', async () => {
  const b = browser(); const data = response(); const urls = [];
  b.context.mockData = data; b.context.urls = urls;
  b.run(`apiSalesRange = async () => { const lines = [
    {date:'2026-09-23',secondOfDay:12*3600,priceexclvat:400,price:500},
    {date:'2026-09-23',secondOfDay:14*3600+32*60,priceexclvat:999}];
    _salesSnapshotTimes.set(lines, Date.now()); return lines; };
    apiFetch = async url => { urls.push(url); return { ok: true, json: async () => structuredCloneForTest(mockData) }; };`);
  b.context.structuredCloneForTest = structuredClone;
  const result = await b.run("apiPlandaySalaries('2026-09-23','2026-09-24')");
  assert.equal(result.chain.revenueExVat, 2400); assert.equal(b.run('salaryPercent')(result.chain, result.chain.revenueExVat), 25);
  assert.match(urls[0], /2026-09-23\/2026-09-24\?cutoff=2026-09-23T12%3A32/);
});
test('real browser salary functions coalesce concurrent callers', async () => {
  const b = browser(); let calls = 0; b.context.mockData = response();
  b.context.fetchSalary = async () => { calls++; await tick(); return { ok: true, json: async () => structuredClone(b.context.mockData) }; };
  b.run(`apiSalesRange = async () => { const lines=[]; _salesSnapshotTimes.set(lines,Date.now()); return lines; }; apiFetch = fetchSalary;`);
  await Promise.all([b.run("apiPlandaySalaries('2026-09-23','2026-09-24')"), b.run("apiPlandaySalaries('2026-09-23','2026-09-24')")]); assert.equal(calls, 1);
});
test('incomplete browser salary responses are not cached', async () => {
  const b = browser(); let calls = 0; b.context.mockData = response(false);
  b.context.fetchSalary = async () => { calls++; return { ok: true, json: async () => structuredClone(b.context.mockData) }; };
  b.run(`apiSalesRange = async () => { const lines=[]; _salesSnapshotTimes.set(lines,Date.now()); return lines; }; apiFetch = fetchSalary;`);
  await b.run("apiPlandaySalaries('2026-09-23','2026-09-24')"); await b.run("apiPlandaySalaries('2026-09-23','2026-09-24')");
  assert.equal(calls, 2); assert.equal(b.run('_salaryCache.size'), 0);
});
test('same result powers sidebar, store card and chain breakdown', () => {
  const b = browser(), r = response();
  for (const store of Object.values(r.stores)) store.revenueExVat = 400; r.chain.revenueExVat = 2400; b.context.data = r;
  assert.match(b.run("salaryCell(data,'norrebro')"), /25.0%/);
  assert.match(b.run("salaryCard(data,'norrebro')"), /25.0%/);
  assert.match(b.run('salaryCard(data)'), /25.0%/);
  b.run("_renderChainBreakdown(Object.fromEntries(STORES.map(s=>[s.id,400])),null,null,data,0,0)");
  assert.equal((b.els.get('chain-stores-card').innerHTML.match(/25.0%/g) || []).length, 7);
});
test('unavailable and complete zero are visually distinct; labels use Copenhagen clock', () => {
  const b = browser();
  assert.match(b.run("salaryCell({stores:{norrebro:{cost:0,complete:true,source:'actual',revenueExVat:100,cutoff:'2026-09-23T12:32:00Z'}},period:{active:true}},'norrebro')"), /0.0%.*Actual through 14:32/);
  assert.match(b.run('salaryCard(null)'), /Unavailable/); assert.match(b.run('salaryCard(null)'), /Retry/);
});
test('attendance gaps and excluded unsupported sickness have safe visible labels', () => {
  const b = browser();
  assert.match(b.run("salaryLabel({complete:false,warnings:['ACTUAL_HOURS_MISSING']})"), /attendance incomplete/);
  assert.match(b.run("salaryLabel({complete:true,source:'estimated',warnings:['SICK_LEAVE_WITHOUT_MONETARY_PAY']})"), /Sick leave excluded: no payroll amount/);
});
test('month transition invalidates a cached completed day that used scheduled salary hours', async () => {
  const b = browser();
  b.run("_salaryCache.set('2026-08-22:2026-08-23',{result:{period:{active:false}},expiresAt:Infinity,month:'2026-08'}); apiSalesRange=async()=>{throw Error('must reconcile actual month')};");
  await assert.rejects(b.run("apiPlandaySalaries('2026-08-22','2026-08-23')"), /must reconcile actual month/);
  assert.equal(b.run('_salaryCache.size'), 0);
});
test('sidebar revenue renders while salary is pending and stale salary cannot update a new period', async () => {
  const b = browser(); let release; b.context.salaryWait = new Promise(r => { release = r; });
  b.run('apiPlandaySalaries = () => salaryWait; apiRevenue = async () => 400; apiLyRevenue = async () => ({comparison: 200});');
  await b.run('loadSidebar()'); assert.match(b.els.get('si-norrebro').innerHTML, /400/);
  b.run('_sidebarSalaryGen++'); release(response()); await tick();
  assert.equal(b.els.get('si-salary-norrebro')?.innerHTML || '', '');
});
test('store salary callback cannot overwrite a newly selected store', async () => {
  const b = browser(); let release; b.context.salaryWait = new Promise(r => { release = r; });
  b.run(`apiPlandaySalaries=()=>salaryWait; apiRevenue=async()=>400; apiSalesRange=async()=>[]; apiLyRevenue=()=>new Promise(()=>{}); state.view='store:norrebro';`);
  await b.run("renderStoreView('norrebro')"); b.run('_storeRenderGen++;'); release(response()); await tick();
  assert.equal(b.els.get('store-kpi-sal')?.innerHTML || '', '');
});
test('navigation and session expiry invalidate every salary generation and clear caches', () => {
  const b = browser(); b.run("renderMain=()=>{}; closeSidebar=()=>{}; updateNav=()=>{}; setView('graphs');");
  assert.ok(b.run('_chainRenderGen > 0 && _storeRenderGen > 0 && _graphSalaryGen > 0'));
  assert.match(html, /_salaryCache\.clear\(\);\s*_salaryInFlight\.clear\(\);/);
});
test('missing sales cutoff time fails closed', () => {
  const b = browser(); assert.throws(() => b.run("alignedSalaryRevenue([{date:'2026-09-23',priceexclvat:100}], '2026-09-23T12:32:00Z','2026-09-23','2026-09-24')"), /alignment unavailable/);
});
for (const tz of ['UTC', 'Europe/Copenhagen', 'America/Los_Angeles']) test(`browser named payroll periods independent of timezone: ${tz}`, () => {
  const helper = `const vm=require('vm'),fs=require('fs');const html=fs.readFileSync('index.html','utf8');const code=html.match(/function getCphDateRange\\(period\\) \\{[\\s\\S]*?\\n\\}/)[0];const next=html.match(/function cphDateNextDay\\(dateStr\\) \\{[\\s\\S]*?\\n\\}/)[0];const D=Date;class Fixed extends D{constructor(...x){super(...(x.length?x:['2026-09-23T00:30:00Z']));}}const c=vm.createContext({Date:Fixed,Intl,state:{}});vm.runInContext(next+';'+code,c);console.log(JSON.stringify(vm.runInContext("['today','this-week','this-month','yesterday','last-week','last-month'].map(getCphDateRange)",c)));`;
  const ranges = JSON.parse(execFileSync(process.execPath, ['-e', helper], { cwd: path.join(__dirname, '..'), env: { ...process.env, TZ: tz }, encoding: 'utf8' }));
  assert.deepEqual(ranges, [{ start: '2026-09-23', end: '2026-09-24' }, { start: '2026-09-21', end: '2026-09-24' }, { start: '2026-09-01', end: '2026-09-24' }, { start: '2026-09-22', end: '2026-09-23' }, { start: '2026-09-14', end: '2026-09-21' }, { start: '2026-08-01', end: '2026-09-01' }]);
});
test('a cached active day is not reused as a completed historical day after midnight', async () => {
  const b = browser(); b.run("_salaryCache.set('2026-09-22:2026-09-23',{result:{period:{active:true}},expiresAt:Infinity}); apiSalesRange=async()=>{throw Error('must refetch after midnight')};");
  await assert.rejects(b.run("apiPlandaySalaries('2026-09-22','2026-09-23')"), /must refetch after midnight/);
  assert.equal(b.run('_salaryCache.size'), 0);
});
test('a partial repeated Copenhagen autumn hour cannot be aligned from naive POS seconds', () => {
  const b = browser();
  for (const cutoff of ['2026-10-25T00:40:00Z', '2026-10-25T01:40:00Z']) {
    b.context.cutoff = cutoff;
    assert.throws(() => b.run("alignedSalaryRevenue([{date:'2026-10-25',secondOfDay:9000,priceexclvat:100}],cutoff,'2026-10-25','2026-10-26')"), /alignment unavailable/);
  }
  assert.equal(b.run("alignedSalaryRevenue([{date:'2026-10-25',secondOfDay:9000,priceexclvat:100}],'2026-10-25T02:40:00Z','2026-10-25','2026-10-26')"), 100);
});
test('chain salary callback cannot overwrite a later period render', async () => {
  const b = browser(); let release; b.context.salaryWait = new Promise(r => { release = r; });
  b.run("apiPlandaySalaries=()=>salaryWait; apiAllRevenue=async()=>Object.fromEntries(STORES.map(s=>[s.id,400])); apiAllLyRevenue=()=>new Promise(()=>{}); apiSalesRange=async()=>[];");
  await b.run('renderChainView()'); b.run('_chainRenderGen++'); release(response()); await tick();
  assert.equal(b.els.get('chain-kpi-sal')?.innerHTML || '', '');
});
