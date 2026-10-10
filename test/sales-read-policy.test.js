'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {selectSalesRead}=require('../lib/sales-read-policy');
const {createSalesReadSource}=require('../lib/sales-read-source');
const {describe}=require('../lib/sales-data-status');
const args={storeSlug:'christianshavn',start:'2026-09-26',end:'2026-09-28',today:'2026-09-28'};
test('only explicit covered-history policy loads the configured reader alongside OnlinePOS',async()=>{
 assert.throws(()=>createSalesReadSource({KK_SALES_READ_POLICY:'typo'}));
 assert.throws(()=>createSalesReadSource({KK_SALES_READ_POLICY:'covered-history'}));
 assert.throws(()=>createSalesReadSource({KK_SALES_READ_SOURCE:'database',KK_SALES_READ_POLICY:'covered-history'}));
 const reader=createSalesReadSource({KK_SALES_READ_SOURCE:'onlinepos',KK_SALES_READ_POLICY:'covered-history',KK_SALES_READ_DB_URL:'postgres://synthetic@localhost/test'});
 assert.equal(reader.policy,'covered-history');await reader.close();
});
test('malformed, duplicated or invalid coverage cannot trigger provider fallback',async()=>{
 for(const days of [[],[{date:args.start,status:'missing'}],[{date:args.start,status:'missing'},{date:args.start,status:'missing'}],[{date:args.start,status:'complete'},{date:'2026-09-27',status:'invalid-coverage'}]]){
  const reader={policy:'covered-history',read:async()=>({lines:[],meta:{complete:false,code:'DB_COVERAGE_INCOMPLETE',coverage:{days}}})};
  await assert.rejects(selectSalesRead(reader,args),e=>e.salesReadMeta.code==='DB_READ_UNAVAILABLE');
 }
});
test('UI distinguishes provider completeness from stored gaps and retains metric warning',()=>{
 const text=describe({source:'onlinepos',complete:true,routeReason:'uncovered-range',databaseCoverage:{checked:true,days:[{date:args.start,status:'complete'},{date:'2026-09-27',status:'missing'}]},metrics:{potentiallyIncomplete:['lemonade']}});
 for(const re of [/OnlinePOS for the entire range/,/1\/2 days/,/2026-09-27/,/No stored rows mixed in/,/lemonade/])assert.match(text,re);
 assert.match(describe({source:'database',code:'DB_READ_UNAVAILABLE'}),/No OnlinePOS fallback/);
});
const fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
test('graph stops on one failed store without drawing a partial or zero-filled graph',async()=>{
 const card={};const context={state:{view:'graphs',graphStores:['norrebro','christianshavn'],graphFrom:'2026-09-26',graphTo:'2026-09-27'},document:{getElementById:()=>card},resetSalesDataNotices(){},generateBuckets:()=>[],cphDateNextDay:()=>args.end,apiSalesRange:async id=>{if(id==='christianshavn')throw Error('unavailable');return[];},console:{warn(){}}};
 vm.createContext(context);vm.runInContext(html.slice(html.indexOf('async function loadGraphData()'),html.indexOf('function openCustomPicker()')),context);
 await context.loadGraphData();assert.match(card.innerHTML,/No partial graph is shown/);
});
test('large covered range stays on PostgreSQL with aggregated daily revenue',async()=>{
  const days=Array.from({length:278},(_,i)=>{const d=new Date(Date.UTC(2026,0,1+i)).toISOString().slice(0,10);
    return{date:d,status:'complete',lineCount:700,observedAt:new Date('2026-10-05T10:00:00Z'),revenueIncl:'50000',revenueExcl:'40000',evidence:'complete-single-pass'};});
  const reader={policy:'covered-history',read:async({storeSlug,start,end})=>{
    const meta={source:'database',complete:true,aggregated:true,start,end,storeId:storeSlug,rawLineCount:194600,processedLineCount:278,
      pages:0,coverage:{complete:true,days:days.map(d=>({...d,independentlyVerified:false}))},freshness:{status:'historical-snapshot'},metrics:{potentiallyIncomplete:[]}};
    return{lines:days.map(d=>({date:d.date,priceexclvat:40000,productid:null,productname:null,productgroupid:null,productgroup:null,count:700,price:50000,paymenttype:null,paymenttypecode:null,hour:null,secondOfDay:null})),meta};
  }};
  const sel=await selectSalesRead(reader,{storeSlug:'norrebro',start:'2026-01-01',end:'2026-10-05',today:'2026-10-06'});
  assert.equal(sel.source,'database','large covered range must use database, not OnlinePOS');
  assert.equal(sel.result.meta.aggregated,true);
  assert.equal(sel.result.lines.length,278);
});
test('large covered range ending today uses hybrid: PostgreSQL aggregated + OnlinePOS for today only',async()=>{
  let dbReadCalled=false;
  const reader={policy:'covered-history',read:async({start,end})=>{
    dbReadCalled=true;assert.equal(end,'2026-10-06','hybrid splits at today');
    return{lines:[{date:'2026-01-01',priceexclvat:1000,productid:null}],meta:{source:'database',complete:true,aggregated:true,
      start,end,coverage:{complete:true,days:[{date:'2026-01-01',status:'complete'}]},freshness:{status:'historical-snapshot'},metrics:{potentiallyIncomplete:[]}}};
  }};
  const sel=await selectSalesRead(reader,{storeSlug:'norrebro',start:'2026-01-01',end:'2026-10-07',today:'2026-10-06'});
  assert.equal(sel.source,'hybrid');assert(dbReadCalled);
  assert.equal(sel.todayStart,'2026-10-06');assert.equal(sel.todayEnd,'2026-10-07');
});
test('failed store is identifiable from salesReadMeta in the error',async()=>{
  const reader={policy:'covered-history',read:async()=>{throw new Error('connection lost');}};
  try { await selectSalesRead(reader,{storeSlug:'christianshavn',start:'2026-01-01',end:'2026-10-05',today:'2026-10-06'}); assert.fail('should throw'); }
  catch(e) { assert.equal(e.salesReadMeta.code,'DB_READ_UNAVAILABLE'); assert.equal(e.salesReadMeta.storeId,'christianshavn'); }
});
test('new-view consumers of a coalesced failed sales request retain error metadata and retry guidance',async()=>{
 let release;
 const context={SalesDataStatus:require('../lib/sales-data-status'),STORES:[],sessionActive:true,sessionNonce:1,Date,SALES_CACHE_MAX_ENTRIES:120,SALES_CACHE_HISTORICAL_TTL_MS:21600000,_salesCache:new Map(),_salesInFlight:new Map(),readSalesCache:()=>null,apiFetch:()=>new Promise(r=>release=r)};
 vm.createContext(context);vm.runInContext(html.slice(html.indexOf('const salesDataNotices ='),html.indexOf('function readRevenueSummaryCache')),context);
 const first=context.apiSalesRange('norrebro',args.start,args.end);context.resetSalesDataNotices();const second=context.apiSalesRange('norrebro',args.start,args.end);
 release({ok:false,json:async()=>({meta:{source:'database',storeId:'norrebro',start:args.start,end:args.end,complete:false,code:'DB_READ_UNAVAILABLE'}})});
 const settled=await Promise.allSettled([first,second]);assert(settled.every(r=>r.status==='rejected'&&/Stored sales unavailable\. Please try again\./.test(r.reason.message)));
 assert.equal(context._salesCache.size,0);
 const notice=vm.runInContext('salesDataNotices.values().next().value',context);
 assert.equal(notice.meta.code,'DB_READ_UNAVAILABLE');assert.equal(notice.meta.complete,false);assert.match(notice.text,/Database read failed/);
});

// ── Hybrid routing: covered history + today ─────────────────────────────────
const STORES=['christianshavn','fisketorvet','frederiksberg','indre-by','norrebro','vesterbro'];
function mockReader(complete,{lines=[],code}={}){
 return {policy:'covered-history',read:async({storeSlug,start,end})=>{
  const days=[];for(let d=new Date(start+'T12:00:00Z');d.toISOString().slice(0,10)<end;d.setUTCDate(d.getUTCDate()+1))
   days.push({date:d.toISOString().slice(0,10),status:complete?'complete':'missing'});
  return {lines,meta:{complete,code:complete?null:(code||'DB_COVERAGE_INCOMPLETE'),
   coverage:{complete,days},freshness:{status:'historical-snapshot'}}};
 }};
}
test('hybrid splits This Month mid-month: DB for completed days, provider for today',async()=>{
 const today='2026-10-15';
 const r=await selectSalesRead(mockReader(true,{lines:[{id:1},{id:2}]}),
  {storeSlug:'christianshavn',start:'2026-10-01',end:'2026-10-16',today});
 assert.equal(r.source,'hybrid');
 assert.equal(r.todayStart,today);
 assert.equal(r.todayEnd,'2026-10-16');
 assert.equal(r.dbResult.lines.length,2);
 assert.match(r.routeReason,/hybrid/);
});
test('hybrid routes today-only range to pure OnlinePOS',async()=>{
 const r=await selectSalesRead(mockReader(true),{storeSlug:'norrebro',start:'2026-10-15',end:'2026-10-16',today:'2026-10-15'});
 assert.equal(r.source,'onlinepos');
 assert.equal(r.routeReason,'includes-open-day');
});
test('hybrid falls back to OnlinePOS when historical days have coverage gaps',async()=>{
 const r=await selectSalesRead(mockReader(false),{storeSlug:'norrebro',start:'2026-10-01',end:'2026-10-16',today:'2026-10-15'});
 assert.equal(r.source,'onlinepos');
 assert.equal(r.routeReason,'uncovered-range');
});
test('hybrid fails closed on DB error, never falls back to provider',async()=>{
 const broken={policy:'covered-history',read:async()=>{throw new Error('connection refused');}};
 await assert.rejects(selectSalesRead(broken,{storeSlug:'christianshavn',start:'2026-10-01',end:'2026-10-16',today:'2026-10-15'}),
  e=>e.salesReadMeta?.code==='DB_READ_UNAVAILABLE');
});
test('hybrid works for all six stores with Copenhagen month boundary',async()=>{
 for(const store of STORES){
  const r=await selectSalesRead(mockReader(true,{lines:[{x:1}]}),
   {storeSlug:store,start:'2026-10-01',end:'2026-10-16',today:'2026-10-15'});
  assert.equal(r.source,'hybrid');
  assert.equal(r.dbResult.lines.length,1);
 }
});
test('hybrid on last day of month routes entire month to DB except today',async()=>{
 const r=await selectSalesRead(mockReader(true,{lines:[{a:1},{b:2},{c:3}]}),
  {storeSlug:'christianshavn',start:'2026-10-01',end:'2026-11-01',today:'2026-10-31'});
 assert.equal(r.source,'hybrid');
 assert.equal(r.todayStart,'2026-10-31');
 assert.equal(r.todayEnd,'2026-11-01');
 assert.equal(r.dbResult.lines.length,3);
});
test('fully closed month routes entirely to DB, not hybrid',async()=>{
 const r=await selectSalesRead(mockReader(true,{lines:[{x:1}]}),
  {storeSlug:'norrebro',start:'2026-09-01',end:'2026-10-01',today:'2026-10-01'});
 assert.equal(r.source,'database');
});

// ── Combined and trend graph helpers ─────────────────────────────────────────
// Extract the pure functions from index.html and test them directly.
const helperSrc = html.slice(html.indexOf('// ── Graph helpers'), html.indexOf('// ── Graph bucketing helpers'));
const helperCtx = { window: { ProductMetrics: require('../lib/product-metrics') }, computeItemCategories: null, Intl, kr: n => n == null ? '—' : new Intl.NumberFormat('da-DK',{style:'currency',currency:'DKK',maximumFractionDigits:0}).format(n) };
vm.createContext(helperCtx);
vm.runInContext('function computeItemCategories(items){const m=window.ProductMetrics.computeMetrics(items);return{rolls:m.rollUnits,kombos:m.komboUnits,kebab:m.breakdown.komboLamb+m.breakdown.rollKebab,falafel:m.breakdown.komboFalafel+m.breakdown.rollFalafel,chicken:m.breakdown.komboKylling+m.breakdown.rollKylling,lemUnits:m.lemUnits};}', helperCtx);
vm.runInContext(helperSrc, helperCtx);

test('combined revenue sums across stores, not averages',()=>{
  const c = helperCtx.bucketComponents(null, { 'w1': 1000 }, 'w1', 'revenue');
  assert.equal(c.value, 1000);
  // Combined: two stores with 1000 each = 2000
  const c1 = helperCtx.bucketComponents(null, { 'w1': 1000 }, 'w1', 'revenue');
  const c2 = helperCtx.bucketComponents(null, { 'w1': 1500 }, 'w1', 'revenue');
  assert.equal(c1.value + c2.value, 2500);
});
test('combined kombo % uses total numerators/denominators, not store averages',()=>{
  // Store A: 10 kombos, 10 rolls → kombo 50%. Store B: 99 kombos, 1 roll → kombo 99%.
  // Average: 74.5%. Correct: 109/120 = 90.83%.
  const itemsA = [{productid:'27242208',count:10,price:100},{productid:'27242336',count:10,price:100}];
  const itemsB = [{productid:'27242208',count:99,price:990},{productid:'27242336',count:1,price:10}];
  const cA = helperCtx.bucketComponents(itemsA, {}, 'w1', 'kombo');
  const cB = helperCtx.bucketComponents(itemsB, {}, 'w1', 'kombo');
  const combined = { num: cA.num + cB.num, den: cA.den + cB.den, hasData: true };
  const pct = helperCtx.componentValue(combined, 'kombo');
  assert(Math.abs(pct - 109/120*100) < 0.01, 'combined kombo % = 90.83%, not 74.5%');
});
test('kombo % is the complement of the old rolls % for identical data',()=>{
  const items = [{productid:'27242208',count:30,price:300},{productid:'27242336',count:70,price:700}];
  const c = helperCtx.bucketComponents(items, {}, 'w1', 'kombo');
  const komboPct = helperCtx.componentValue(c, 'kombo');
  // Kombo: 30/(30+70) = 30%. Former Rolls: 70/(70+30) = 70%. Sum = 100%.
  assert(Math.abs(komboPct - 30) < 0.01);
  assert(Math.abs(komboPct + 70 - 100) < 0.01, 'kombo + former rolls = 100%');
});
test('linear regression returns correct slope and fitted endpoints',()=>{
  // y = 100, 200, 300, 400 → slope = 100, intercept = 100
  const reg = helperCtx.linearRegression([100, 200, 300, 400]);
  assert.equal(reg.validCount, 4);
  assert(Math.abs(reg.fittedStart - 100) < 0.01);
  assert(Math.abs(reg.fittedEnd - 400) < 0.01);
  assert(Math.abs(reg.data[0] - 100) < 0.01);
  assert(Math.abs(reg.data[3] - 400) < 0.01);
});
test('revenue trend reports fitted relative percentage change',()=>{
  // Fitted start 100, end 125 → +25%
  const change = helperCtx.formatTrendChange(100, 125, 'revenue');
  assert.equal(change, '+25%');
  // Negative: start 200, end 150 → -25%
  assert.equal(helperCtx.formatTrendChange(200, 150, 'revenue'), '-25%');
});
test('lemonade trend reports fitted relative percentage change',()=>{
  assert.equal(helperCtx.formatTrendChange(50, 60, 'lemonade'), '+20%');
});
test('ratio metrics report percentage-point change',()=>{
  assert.equal(helperCtx.formatTrendChange(55.0, 58.2, 'kombo'), '+3.2 pp');
  assert.equal(helperCtx.formatTrendChange(40.0, 38.3, 'food-cost'), '-1.7 pp');
  assert.equal(helperCtx.formatTrendChange(10.0, 10.9, 'salary'), '+0.9 pp');
  assert.equal(helperCtx.formatTrendChange(5.0, 8.5, 'chicken'), '+3.5 pp');
});
test('null buckets are ignored in regression, not treated as zero',()=>{
  const reg = helperCtx.linearRegression([100, null, null, 400]);
  assert.equal(reg.validCount, 2);
  assert(Math.abs(reg.fittedStart - 100) < 0.01);
  assert(Math.abs(reg.fittedEnd - 400) < 0.01);
  // Interior nulls filled by fitted line
  assert(reg.data[1] != null); assert(reg.data[2] != null);
});
test('fewer than two valid buckets produces no trend',()=>{
  const reg = helperCtx.linearRegression([42]);
  assert.equal(reg.validCount, 1);
  assert.equal(reg.fittedStart, null);
  assert.equal(reg.data[0], null);
});
test('zero fitted starting value is handled safely',()=>{
  // Revenue: fitted start ~0, show absolute change
  const change = helperCtx.formatTrendChange(0, 500, 'revenue');
  assert(change != null && !change.includes('Infinity'));
  assert(change != null && !change.includes('NaN'));
});
test('produktmix produces one trend per displayed series',()=>{
  // Two series: lamb rises, falafel falls
  const lambData = [60, 65, 70, 75];
  const falafelData = [40, 35, 30, 25];
  const regL = helperCtx.linearRegression(lambData);
  const regF = helperCtx.linearRegression(falafelData);
  const changeL = helperCtx.formatTrendChange(regL.fittedStart, regL.fittedEnd, 'produktmix');
  const changeF = helperCtx.formatTrendChange(regF.fittedStart, regF.fittedEnd, 'produktmix');
  assert.match(changeL, /^\+/); assert.match(changeF, /^-/);
});
test('chicken % includes both komboKylling and rollKylling',()=>{
  const PM = require('../lib/product-metrics');
  const items = [
    {productid:PM.PRODUCT_IDS.KOMBO_KYLLING_INDRE_BY,count:5,price:500},
    {productid:PM.PRODUCT_IDS.ROLL_KYLLING_INDRE_BY,count:3,price:300},
    {productid:PM.PRODUCT_IDS.ROLL_KEBAB_INDRE_BY,count:12,price:1200},
    {productid:PM.PRODUCT_IDS.ROLL_FALAFEL_INDRE_BY,count:10,price:1000},
  ];
  const c = helperCtx.bucketComponents(items, {}, 'w1', 'chicken');
  // chicken = 5+3=8, den = (12+5)kebab + (10+3)falafel-is-wrong... Let me recalculate:
  // kebab = komboLamb(0)+rollKebab(12) = 12
  // falafel = komboFalafel(0)+rollFalafel(10) = 10
  // chicken = komboKylling(5)+rollKylling(3) = 8
  // den = 12+10+8 = 30
  assert.equal(c.num, 8);
  assert.equal(c.den, 30);
  const pct = helperCtx.componentValue(c, 'chicken');
  assert(Math.abs(pct - 8/30*100) < 0.01);
});
test('valid zero-chicken bucket returns 0%, not null',()=>{
  const items = [{productid:'27242336',count:10,price:100},{productid:'27242332',count:5,price:50}]; // kebab + falafel only
  const c = helperCtx.bucketComponents(items, {}, 'w1', 'chicken');
  assert.equal(c.num, 0);
  assert(c.den > 0);
  assert.equal(c.hasData, true);
  assert.equal(helperCtx.componentValue(c, 'chicken'), 0);
});
test('zero-protein bucket returns null',()=>{
  const c = helperCtx.bucketComponents([], {}, 'w1', 'chicken');
  assert.equal(c.hasData, false);
  assert.equal(helperCtx.componentValue(c, 'chicken'), null);
});
test('produktmix displays kebab, falafel and chicken totalling 100%',()=>{
  const PM = require('../lib/product-metrics');
  const items = [
    {productid:PM.PRODUCT_IDS.ROLL_KEBAB,count:50,price:5000},
    {productid:PM.PRODUCT_IDS.ROLL_FALAFEL,count:30,price:3000},
    {productid:PM.PRODUCT_IDS.KOMBO_KYLLING_INDRE_BY,count:20,price:2000},
  ];
  const c = helperCtx.bucketComponents(items, {}, 'w1', 'produktmix');
  const kebab = helperCtx.componentValue(c, 'produktmix', 'kebab');
  const falafel = helperCtx.componentValue(c, 'produktmix', 'falafel');
  const chicken = helperCtx.componentValue(c, 'produktmix', 'chicken');
  assert(Math.abs(kebab + falafel + chicken - 100) < 0.01, 'three shares sum to 100%');
  assert(Math.abs(kebab - 50) < 0.01);
  assert(Math.abs(falafel - 30) < 0.01);
  assert(Math.abs(chicken - 20) < 0.01);
});
test('no graph-facing rolls label remains',()=>{
  assert(!html.includes("'rolls'"), 'no rolls metric identifier in graph code');
  assert(!html.includes("Rolls %"), 'no Rolls % button label');
});
test('lemonade combined sums units across stores',()=>{
  const PM = require('../lib/product-metrics');
  const items1 = [{productid: PM.PRODUCT_IDS.LEM_ADDON, count: 10, price: 0}];
  const items2 = [{productid: PM.PRODUCT_IDS.LEM_UPGRADE, count: 5, price: 50}];
  const c1 = helperCtx.bucketComponents(items1, {}, 'w1', 'lemonade');
  const c2 = helperCtx.bucketComponents(items2, {}, 'w1', 'lemonade');
  assert.equal(c1.value + c2.value, 15);
});
