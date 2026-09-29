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
for(const today of ['2026-03-29','2026-03-30','2026-10-25','2026-10-26'])test('hybrid boundary is a Copenhagen calendar date across DST: '+today,async()=>{
 const start=new Date(Date.parse(today)-86400000).toISOString().slice(0,10),end=new Date(Date.parse(today)+86400000).toISOString().slice(0,10);
 const reader={policy:'covered-history',read:async args=>({lines:[],meta:{...args,complete:true,coverage:{complete:true,days:[{date:start,status:'complete'}]}}})};
 const selected=await selectSalesRead(reader,{storeSlug:'norrebro',start,end,today});assert.equal(selected.source,'hybrid');assert.equal(selected.result.meta.end,today);assert.deepEqual(selected.providerRange,{start:today,end});
});
test('hybrid signed lines preserve refunds and reject overlapping, missing or incomplete boundaries',()=>{
 const h=require('../lib/sales-hybrid');const line={productid:'27242336',productname:'Killer Kebab',count:-1,price:-95,priceexclvat:-76,date:'2026-09-27'};
 const selection={storeId:'norrebro',start:'2026-09-27',end:'2026-09-29',source:'hybrid',providerRange:{start:'2026-09-28',end:'2026-09-29'},result:{lines:[line],meta:{complete:true,start:'2026-09-27',end:'2026-09-28',rawLineCount:1,processedLineCount:1,coverage:{days:[{date:'2026-09-27',independentlyVerified:false}]}}}};
 const cached={cacheStatus:'fresh',stale:false,fetchedAt:Date.now(),result:{meta:{complete:true,start:'2026-09-28',end:'2026-09-29',rawLineCount:1,processedLineCount:1,conflicts:[],invalidCount:0}}};const live=[{...line,date:'2026-09-28',price:190,priceexclvat:152,count:2}];
 const combined=h.composeLines(selection,cached,live);assert.equal(combined.lines.reduce((s,l)=>s+l.priceexclvat,0),76);assert.equal(require('../lib/product-metrics').computeMetrics(combined.lines).rollUnits,1);assert.match(describe(combined.meta),/Stored history through 2026-09-27 \+ OnlinePOS for Today/);assert.equal(combined.meta.rawLineCount,2);
 for(const bad of [[line],[{...live[0],date:undefined}]])assert.throws(()=>h.composeLines(selection,cached,bad),e=>e.hybridReadMeta.complete===false);
 cached.result.meta.complete=false;assert.throws(()=>h.composeLines(selection,cached,live));assert.match(describe(h.unavailable(selection)),/No partial figures/);
});
