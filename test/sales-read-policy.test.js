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
test('new-view consumers of a coalesced failed sales request retain the error notice',async()=>{
 const notices=[],elements=new Map(); let release;
 const context={SalesDataStatus:require('../lib/sales-data-status'),STORES:[],sessionActive:true,sessionNonce:1,Date,SALES_CACHE_MAX_ENTRIES:120,SALES_CACHE_HISTORICAL_TTL_MS:21600000,_salesCache:new Map(),_salesInFlight:new Map(),readSalesCache:()=>null,document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);}},apiFetch:()=>new Promise(r=>release=r)};
 vm.createContext(context);vm.runInContext(html.slice(html.indexOf('const salesDataNotices ='),html.indexOf('function readRevenueSummaryCache')),context);
 const first=context.apiSalesRange('norrebro',args.start,args.end);context.resetSalesDataNotices();const second=context.apiSalesRange('norrebro',args.start,args.end);
 release({ok:false,json:async()=>({meta:{source:'database',storeId:'norrebro',start:args.start,end:args.end,complete:false,code:'DB_READ_UNAVAILABLE'}})});
 const settled=await Promise.allSettled([first,second]);assert(settled.every(r=>r.status==='rejected'));assert.match(elements.get('sales-data-status-detail').textContent,/Database read failed/);
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
