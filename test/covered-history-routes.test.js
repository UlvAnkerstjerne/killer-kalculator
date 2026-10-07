'use strict';
const {test,before,after,beforeEach}=require('node:test'), assert=require('node:assert/strict'), bcrypt=require('bcryptjs');
process.env.NODE_ENV='test'; process.env.KK_USERNAME='policy-test'; process.env.KK_PASSWORD_HASH=bcrypt.hashSync('synthetic-password',4); process.env.KK_SESSION_SECRET='synthetic-session-only';
for (const id of ['INDRE_BY','VESTERBRO','CHRISTIANSHAVN','FISKETORVET','FREDERIKSBERG','NORREBRO']) process.env['ONLINEPOS_TOKEN_'+id]='synthetic-token';
let reads=0, coverageReads=0, provider=0, mode='normal', requested=[];
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Copenhagen',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const next=d=>new Date(Date.parse(d)+86400000).toISOString().slice(0,10);
const dates=(start,end)=>{const out=[];for(let d=start;d<end;d=next(d))out.push(d);return out;};
const line={productid:'27242336',productname:'Killer Kebab',productgroupid:'1',productgroup:'Rolls',count:1,price:95,priceexclvat:76,paymenttype:'Kontant',paymenttypecode:null,date:'2026-09-20',hour:14,secondOfDay:50400};
async function storedSnapshot({storeSlug,start,end}) {
  if(mode==='db-error')throw Error('PRIVATE_DATABASE_DETAIL');
  const days=dates(start,end).map(date=>({date,status:mode==='invalid'?'invalid-coverage':date<'2026-09-20'||date>'2026-09-27'||(storeSlug==='christianshavn'&&date==='2026-09-27')?'missing':'complete',independentlyVerified:false}));
  const complete=days.every(d=>d.status==='complete');
  return {lines:complete?[line]:[],meta:{source:'database',complete,storeId:storeSlug,start,end,coverage:{complete,days},...(complete?{}:{code:'DB_COVERAGE_INCOMPLETE'})}};
}
require.cache[require.resolve('../lib/sales-read-source')]={exports:{createSalesReadSource:()=>({policy:'covered-history',async ready(){return {ready:true,source:'database'};},async read(args){reads++;return storedSnapshot(args);},async coverage(args){coverageReads++;const r=await storedSnapshot(args);return {...r,lines:[]};}})}};
require.cache[require.resolve('axios')]={exports:{get:async url=>{provider++; requested.push(url);if(mode==='provider-error')throw Error('PRIVATE_PROVIDER_DETAIL');return {status:200,data:{current_page:1,next_page_url:null,data:dates('2026-09-19',next(today)).map((date,i)=>({orderlineid:'synthetic-'+i,productid:'27241752',productname:'',productgroupid:1,productgroup:'Drinks',count:1,price:25,priceexclvat:20,paymenttype:'Kontant',timestamp_pay:date+' 14:00:00'}))}};}}};
const app=require('../server'); let server,url,cookie;
before(async()=>{await new Promise(r=>{server=app.listen(0,'127.0.0.1',r)});url='http://127.0.0.1:'+server.address().port;const r=await fetch(url+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'policy-test',password:'synthetic-password'})});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];});
beforeEach(()=>{reads=coverageReads=provider=0;requested=[];mode='normal';app.locals.salesRangeCache.clear();app.locals.revenueSummaryCache.clear();});
after(async()=>{app.locals.salesRangeCache.clear();app.locals.revenueSummaryCache.clear();await new Promise(r=>server.close(r));});
const get=async path=>{const response=await fetch(url+path,{headers:{Cookie:cookie}});return {status:response.status,...await response.json()};};
for(const route of ['sales-range','revenue-summary']){
 test(route+': complete historical day uses only stored data',async()=>{const r=await get('/api/'+route+'/norrebro/2026-09-20/2026-09-21');assert.equal(r.status,200);assert.equal(r.meta.source,'database');assert.equal(r.meta.readPolicy,'covered-history');assert.equal(provider,0);assert.equal(reads,1);assert.equal(route==='sales-range'?r.lines[0].priceexclvat:r.summary.completeRevenue,76);});
 test(route+': Today bypasses even a broken database',async()=>{mode='db-error';const r=await get('/api/'+route+'/norrebro/'+today+'/'+next(today));assert.equal(r.status,200);assert.equal(r.meta.source,'onlinepos');assert.equal(r.meta.routeReason,'includes-open-day');assert.equal(r.meta.databaseCoverage.checked,false);assert.equal(reads,0);assert.equal(provider,1);});
 test(route+': missing Christianshavn September 27 uses OnlinePOS for the whole day',async()=>{const r=await get('/api/'+route+'/christianshavn/2026-09-27/2026-09-28');assert.equal(r.status,200);assert.equal(r.meta.source,'onlinepos');assert.equal(r.meta.databaseCoverage.days[0].status,'missing');assert.equal(provider,1);assert.equal(route==='sales-range'?r.lines.reduce((n,l)=>n+l.priceexclvat,0):r.summary.completeRevenue,20);});
 test(route+': a covered/uncovered span never combines partial database rows',async()=>{const r=await get('/api/'+route+'/christianshavn/2026-09-26/2026-09-28');assert.equal(r.status,200);assert.equal(r.meta.source,'onlinepos');assert.deepEqual(r.meta.databaseCoverage.days.map(d=>d.status),['complete','missing']);assert.equal(r.meta.coverage.complete,true);assert.equal(provider,1);assert.equal(route==='sales-range'?r.lines.reduce((n,l)=>n+l.priceexclvat,0):r.summary.completeRevenue,40);});
 test(route+': stored-to-Today span with incomplete history falls back to OnlinePOS',async()=>{const r=await get('/api/'+route+'/norrebro/2026-09-20/'+next(today));assert.equal(r.status,200);assert.equal(r.meta.source,'onlinepos');assert.equal(r.meta.routeReason,'uncovered-range');assert.ok(reads>0,'hybrid attempts DB read before fallback');assert.equal(provider,1);});
 test(route+': database errors and invalid coverage fail visibly, with zero provider calls',async()=>{for(mode of ['db-error','invalid']){const r=await get('/api/'+route+'/norrebro/2026-09-20/2026-09-21');assert.equal(r.status,503);assert.equal(r.meta.complete,false);assert.equal(r.meta.routeReason,'database-error');assert.equal(r.meta.code,'DB_READ_UNAVAILABLE');assert(!JSON.stringify(r).includes('PRIVATE_DATABASE_DETAIL'));assert.equal(provider,0);}});
 test(route+': provider error remains a provider error with incomplete provenance',async()=>{mode='provider-error';const r=await get('/api/'+route+'/christianshavn/2026-09-27/2026-09-28');assert.equal(r.status,502);assert.equal(r.meta.source,'onlinepos');assert.equal(r.meta.complete,false);assert.equal(r.meta.databaseCoverage.complete,false);assert(!JSON.stringify(r).includes('PRIVATE_PROVIDER_DETAIL'));});
}
test('provider data keeps unresolved product warnings and source on cache hits',async()=>{for(let i=0;i<2;i++){const r=await get('/api/sales-range/indre-by/'+today+'/'+next(today));assert.equal(r.meta.source,'onlinepos');assert.deepEqual(r.meta.metrics.potentiallyIncomplete,['lemonade']);}assert.equal(provider,1);});
test('legacy lemonade endpoints return 404',async()=>{const r=await fetch(url+'/api/lemonade/today',{headers:{Cookie:cookie}});assert.equal(r.status,404);const h=await fetch(url+'/api/lemonade/history',{headers:{Cookie:cookie}});assert.equal(h.status,404);});
test('historical warming skips covered ranges and primes whole missing ranges without fact reads',async()=>{
  const ly=await app.locals.warmLyRevenueSummaries({today:'2026-09-28'});
  const report=await app.locals.warmCompletedSalesRanges({today:'2026-09-28'});
  assert.equal(ly.databaseCovered,0);assert.equal(report.outcomes.filter(o=>o.status==='database-covered').length,10);
  assert(provider>0);assert(coverageReads>0);assert.equal(reads,0,'warming reads coverage only');
  const count=provider;
  const stored=await get('/api/sales-range/norrebro/2026-09-20/2026-09-21');assert.equal(stored.meta.source,'database');assert.equal(stored.lines[0].priceexclvat,76);
  const missing=await get('/api/sales-range/christianshavn/2026-09-27/2026-09-28');assert.equal(missing.meta.source,'onlinepos');assert.equal(missing.lines.reduce((n,l)=>n+l.priceexclvat,0),20);assert.equal(provider,count,'whole provider range was warmed');
});
test('warming coverage errors never trigger provider fallback; This Month under db-error is coverage-unavailable',async()=>{
  mode='db-error';const ly=await app.locals.warmLyRevenueSummaries({today:'2026-09-28',concurrency:99});
  assert.equal(ly.concurrency,2);assert.equal(ly.coverageFailed,18);
  const completed=await app.locals.warmCompletedSalesRanges({today:'2026-09-28'});assert(completed.outcomes.every(o=>o.status==='coverage-unavailable'));assert.equal(provider,0);
  const before=coverageReads;await app.locals.warmThisMonthSalesRanges({today:'2026-09-28'});assert.equal(provider,0,'hybrid this-month under db-error stays coverage-unavailable');assert.equal(reads,0);
});
test('This Month on first day of month uses OnlinePOS (start===today bypasses hybrid)',async()=>{
  mode='db-error';
  const before=coverageReads;await app.locals.warmThisMonthSalesRanges({today:'2026-10-01'});assert.equal(coverageReads,before);assert.equal(provider,6);assert.equal(reads,0);
});
