'use strict';
// Synthetic HTTP benchmark: real Express routes/caches, no production/network data.
// node scripts/benchmark-covered-history-warming.js [app-root=..] [delay-ms=80] [lines/day=80]
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createRequire } = require('node:module');
const path = require('node:path');
const appRoot = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const appRequire = createRequire(path.join(appRoot, 'server.js'));
const delayMs = Number(process.argv[3] || 80), linesPerDay = Number(process.argv[4] || 80);
assert(delayMs >= 0 && linesPerDay > 0 && linesPerDay <= 300);
const RealDate = Date, fixedNow = RealDate.parse('2026-09-29T12:00:00Z');
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [fixedNow])); }
  static now() { return fixedNow; }
};
const stores = ['norrebro','vesterbro','christianshavn','indre-by','fisketorvet','frederiksberg'];
const offset = (d,n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0,10);
const dates = (start,end) => { const out=[]; for(let d=start; d<end; d=offset(d,1)) out.push(d); return out; };
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const gaps = (store,d) => (store==='christianshavn' && ((d>='2026-01-01' && d<'2026-09-20') || d==='2026-09-27')) ||
  (store==='indre-by' && ['2025-08-07','2026-03-23'].includes(d)) || (store==='frederiksberg' && d==='2026-07-13');
// Signed, exact-cent synthetic sales. Unused private sentinels must never survive the cache.
function lines(start,end) {
  return dates(start,end).flatMap(date => Array.from({length:linesPerDay}, (_,i) => {
    const sign = i%17===0 ? -1 : 1;
    return {productid:'27242336',productname:'Killer Kebab',productgroupid:'1',productgroup:'Rolls',
      count:sign,price:95*sign,priceexclvat:76*sign,paymenttype:'Kontant',paymenttypecode:null,
      date,hour:i%2?18:12,secondOfDay:i%2?64800:43200};
  }));
}
let coverageReads=0, factReads=0, active=0, maxActive=0;
const exportsLog=[];
async function stored(args,coverageOnly) {
  if(coverageOnly) coverageReads++; else factReads++;
  const {storeSlug,start,end}=args;
  const days=dates(start,end).map(date=>({date,status:gaps(storeSlug,date)?'missing':'complete',independentlyVerified:false}));
  const complete=days.every(d=>d.status==='complete');
  return {lines:complete&&!coverageOnly?lines(start,end):[],meta:{source:'database',storeId:storeSlug,start,end,
    complete,coverage:{complete,days},...(complete?{}:{code:'DB_COVERAGE_INCOMPLETE'})}};
}
const stub = (name,exports) => { const id=appRequire.resolve(name); require.cache[id]={id,filename:id,loaded:true,exports}; };
stub('./lib/sales-read-source',{createSalesReadSource:()=>({policy:'covered-history',read:a=>stored(a,false),coverage:a=>stored(a,true)})});
stub('axios',{get:async (url,config)=>{
  assert(url.startsWith('https://api.onlinepos.dk/'),'unexpected external request');
  const start=new Intl.DateTimeFormat('sv',{timeZone:'Europe/Copenhagen'}).format(new Date(Number(new URL(url).pathname.split('/').pop())*1000));
  exportsLog.push({store:config.headers.token,start});maxActive=Math.max(maxActive,++active);
  try {
    await sleep(delayMs);
    const data=lines(start,offset(start,32)).map((line,i)=>({...line,orderlineid:'synthetic-'+i,
      timestamp_pay:line.date+(line.hour===12?' 12:00:00':' 18:00:00'),clerk:'RAW_PRIVATE_SENTINEL',cardnumber:'RAW_PRIVATE_SENTINEL'}));
    return {data:{data,current_page:1,next_page_url:null}};
  } finally {active--;}
}});
process.env.NODE_ENV='test';process.env.KK_USERNAME='synthetic-benchmark';
process.env.KK_PASSWORD_HASH=appRequire('bcryptjs').hashSync('synthetic-only',4);
process.env.KK_SESSION_SECRET=require('node:crypto').randomBytes(32).toString('hex');
for(const store of stores) process.env['ONLINEPOS_TOKEN_'+store.toUpperCase().replaceAll('-','_')]=store;
const app=appRequire('./server');
const ranges={today:{start:'2026-09-29',end:'2026-09-30'},'this-week':{start:'2026-09-28',end:'2026-09-30'},
  'this-month':{start:'2026-09-01',end:'2026-09-30'},'last-month':{start:'2026-08-01',end:'2026-09-01'}};
const stats=()=>({sales:app.locals.salesRangeCache.stats(),ly:app.locals.revenueSummaryCache.stats()});
const clear=()=>{app.locals.salesRangeCache.clear();app.locals.revenueSummaryCache.clear();};
async function main(){
  const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
  const base='http://127.0.0.1:'+server.address().port;
  const report={kind:'synthetic HTTP; not production or browser rendering',delayMs,linesPerDay,cold:{},warm:{},repeat:{}};
  try{
    const auth=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'synthetic-benchmark',password:'synthetic-only'})});
    assert.equal(auth.status,200);const cookie=auth.headers.get('set-cookie').split(';')[0];
    async function visit(range){
      const started=performance.now(), before=exportsLog.length;
      const boundary=range.end>'2026-09-29'?offset('2026-09-29',-364):null;
      async function request(route){const r=await fetch(base+route,{headers:{Cookie:cookie}});assert.equal(r.status,200);
        const text=await r.text();assert(!text.includes('RAW_PRIVATE_SENTINEL'));return JSON.parse(text);}
      const current=Promise.all(stores.map(s=>request(`/api/sales-range/${s}/${range.start}/${range.end}`)))
        .then(b=>({ms:performance.now()-started,value:b.reduce((n,r)=>n+r.lines.reduce((v,l)=>v+l.priceexclvat,0),0),sources:b.map(r=>r.meta.source)}));
      const ly=Promise.all(stores.map(s=>request(`/api/revenue-summary/${s}/${offset(range.start,-364)}/${offset(range.end,-364)}${boundary?'?boundary='+boundary:''}`)))
        .then(b=>({ms:performance.now()-started,value:b.reduce((n,r)=>n+r.summary.completeRevenue,0),
          comparison:b.reduce((n,r)=>n+(boundary?r.summary.dailyRevenue.filter(d=>d.date<boundary).reduce((v,d)=>v+d.revenue,0)+r.summary.boundary.seconds.filter(p=>p[0]<=50400).reduce((v,p)=>v+p[1],0):r.summary.completeRevenue),0),sources:b.map(r=>r.meta.source)}));
      const [c,l]=await Promise.all([current,ly]);
      return {currentMs:c.ms,lyMs:l.ms,budgetReadyMs:Math.max(c.ms,l.ms),revenue:c.value,ly:l.value,comparison:l.comparison,budget:l.value*1.10,
        exports:exportsLog.length-before,currentSources:c.sources,lySources:l.sources};
    }
    for(const [name,range] of Object.entries(ranges)){clear();report.cold[name]=await visit(range);}
    clear();const before=exportsLog.length, readsBefore=factReads, covBefore=coverageReads;
    const warming=app.locals.warmStartupData();const healthStart=performance.now();
    const health=await fetch(base+'/api/health');report.health={status:health.status,ms:performance.now()-healthStart};assert.equal(health.status,200);
    const result=await warming;
    const outcomes=[...(result.completed?.outcomes||[]),...(result.month?.outcomes||[])];
    report.startup={ms:result.totalMs,exports:exportsLog.length-before,factReads:factReads-readsBefore,coverageReads:coverageReads-covBefore,
      outcomes:outcomes.reduce((m,o)=>(m[o.status]=(m[o.status]||0)+1,m),{})};
    report.afterWarming=stats();
    const priorityRetained=()=>stores.every(storeId=>['today','this-week'].every(name=>app.locals.salesRangeCache.inspect({storeId,...ranges[name]})));
    assert(priorityRetained());
    for(const [name,range] of Object.entries(ranges)){
      report.warm[name]=await visit(range);report.repeat[name]=await visit(range);
      for(const metric of ['revenue','ly','comparison','budget','currentSources','lySources']) assert.deepEqual(report.warm[name][metric],report.cold[name][metric]);
      assert.equal(report.repeat[name].exports,0);
    }
    report.finalCaches=stats();report.maxProviderConcurrency=maxActive;report.priorityRetained=priorityRetained();
    report.rssHighWaterBytes=process.resourceUsage().maxRSS*1024;
    assert(maxActive<=2);assert(report.priorityRetained);
    for(const cache of Object.values(report.finalCaches)) assert(cache.estimatedBytes<=cache.maxBytes);
    // Inspect the actual cached result, not just the public HTTP serializer.
    for(const storeId of stores)for(const range of Object.values(ranges)){
      const entry=app.locals.salesRangeCache.inspect({storeId,...range});if(entry)assert(!JSON.stringify(entry).includes('RAW_PRIVATE_SENTINEL'));
    }
    console.log('BENCHMARK_JSON\n'+JSON.stringify(report,null,2));
  }finally{clear();await new Promise(r=>server.close(r));}
}
main().catch(()=>{console.error('Synthetic benchmark failed');process.exitCode=1;});
