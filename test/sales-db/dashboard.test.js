'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),cp=require('node:child_process');
const {numeric,publicLine,readSnapshot,readiness}=require('../../lib/sales-db/dashboard');
const {createSalesReadSource}=require('../../lib/sales-read-source');
const {describe}=require('../../lib/sales-data-status');
const {metricCoverage}=require('../../lib/sales-metric-coverage');
const now=Date.parse('2026-09-28T12:00:00Z');
const row={date:'2026-09-24',saleLocal:'2026-09-24 14:00:00',secondOfDay:50400,timeQuality:'payment',productId:'27242336',productLabel:'Killer Kebab',groupId:'2911776',groupLabel:'Rolls ',quantity:'1',revenueIncl:'95',revenueExcl:'76',paymentType:'Kontant',paymentCode:null,state:'active'};
const cat=require('../../catalogues/onlinepos-reviewed.json');Object.assign(row,cat.products.find(p=>p.storeSlug==='norrebro'&&p.productId==='27242336'),cat.payments[0]);
const state={date:row.date,status:'complete',evidence:'complete-single-pass',lineCount:1,observedAt:new Date('2026-09-28T10:00:00Z'),revenueIncl:'95',revenueExcl:'76'};
const args={storeSlug:'norrebro',start:row.date,end:'2026-09-25',now};
function session(states=[state],rows=[row],groups){const calls=[];return{calls,async query(sql,values){calls.push({sql,values});if(sql.includes('sales_day_state'))return{rows:states};if(groups&&sql.includes('GROUP BY'))return{rows:groups};return{rows};}};}
test('disabled switch never loads pg, opens database or reads identity config',()=>{const x=cp.spawnSync(process.execPath,['-e',"require('./lib/sales-read-source').createSalesReadSource({});if(Object.keys(require.cache).some(p=>p.includes('/pg/')||p.includes('/sales-db/')))process.exit(1)"],{cwd:require('node:path').join(__dirname,'../..')});assert.equal(x.status,0);assert.equal(createSalesReadSource({KK_SALES_READ_SOURCE:'onlinepos',KK_SALES_READ_DB_URL:'broken'}),null);assert.throws(()=>createSalesReadSource({KK_SALES_READ_SOURCE:'other'}));assert.throws(()=>createSalesReadSource({KK_SALES_READ_SOURCE:'database'}));});
test('public numeric boundary preserves decimals and refuses precision loss',()=>{assert.equal(numeric('-12.3400'),-12.34);assert.throws(()=>numeric('9007199254740993'));assert.throws(()=>numeric('0.123456789012345678'));});
test('complete snapshot is compatible, includes evidence and reveals no private field',async()=>{const x=await readSnapshot(session(),args);assert.equal(x.lines[0].priceexclvat,76);assert.equal(x.lines[0].secondOfDay,50400);assert.equal(x.meta.complete,true);assert.equal(x.meta.freshness.live,false);assert.equal(x.meta.coverage.days[0].independentlyVerified,false);assert.equal(x.meta.rawLineCount,1);assert.deepEqual(Object.keys(x.lines[0]).sort(),['productid','productname','productgroupid','productgroup','count','price','priceexclvat','paymenttype','paymenttypecode','date','hour','secondOfDay'].sort());});
test('missing partial and open ranges never emit a partial total or masquerade as zero',async()=>{for(const a of [args,{...args,start:'2026-09-23'},{...args,start:'2026-09-28',end:'2026-09-29'}]){const s=session(a===args?[]:[state]);const x=await readSnapshot(s,a);assert.equal(x.meta.complete,false);assert.deepEqual(x.lines,[]);assert.equal(s.calls.length,1);assert.match(describe(x.meta),/not zero/);assert(x.meta.coverage.days.every(d=>typeof d.independentlyVerified==='boolean'));}});
test('empty completed day is a real zero and future/unfinished observations reject',async()=>{const empty=await readSnapshot(session([{...state,lineCount:0,revenueIncl:'0',revenueExcl:'0'}],[]),args);assert.equal(empty.meta.complete,true);assert.equal(empty.lines.length,0);for(const at of ['2026-09-24T12:00:00Z','2026-09-29T12:00:00Z'])assert.equal((await readSnapshot(session([{...state,observedAt:new Date(at)}]),args)).meta.complete,false);});
test('coverage count, signed totals and active-state mismatches fail closed',async()=>{for(const changed of [{...row,quantity:'-1',revenueIncl:'-95',revenueExcl:'-76'},{...row,state:'pending'},{...row,productLabel:'unapproved'}])await assert.rejects(readSnapshot(session([state],[changed]),args));await assert.rejects(readSnapshot(session([{...state,lineCount:2}]),args));});
test('explicit classification preserves Lover and modifiers; unknown drinks flag lemonade',()=>{assert.deepEqual(metricCoverage([{productid:'29843302',count:1,priceexclvat:8}],'fisketorvet').potentiallyIncomplete,[]);assert.deepEqual(metricCoverage([{productid:'27241752',count:1,priceexclvat:20}],'indre-by').potentiallyIncomplete,['lemonade']);assert(metricCoverage([{productid:'29553679',count:1,priceexclvat:20}],'christianshavn').potentiallyIncomplete.includes('rolls'));});
test('readiness rejects unexpected migrations and privileged/writable roles',async()=>{await assert.rejects(readiness({query:async()=>({rows:[]})}));for(const role of [{privileged:true,writable:false},{privileged:false,writable:true}])await assert.rejects(readiness({query:async sql=>({rows:sql.includes('schema_migration')?require('./migration-checksums.json'):[role]})}));});
test('41 exact reviews are evidenced exclusions with one unresolved label; no new counted IDs',()=>{const review=require('../../catalogues/onlinepos-metric-review.json').products,metrics=require('../../lib/product-metrics');assert.equal(review.length,41);assert.equal(review.filter(p=>p.classification==='unresolved').length,1);for(const p of review){assert(cat.products.some(x=>['storeSlug','productId','productLabel','groupId','groupLabel'].every(k=>x[k]===p[k])));assert(!metrics.ALL_KNOWN_IDS.has(p.productId));}});
test('a changed catalogue cannot silently claim complete metric classification',()=>{const source="const p=require.resolve('./catalogues/onlinepos-unresolved-metrics.json');require(p);require.cache[p].exports.reviewedCatalogueSha256='unreviewed';const c=require('./lib/sales-metric-coverage').metricCoverage([],'norrebro');if(c.productCountsComplete||c.catalogueReviewCurrent||!c.potentiallyIncomplete.includes('rolls'))process.exit(1);";assert.equal(cp.spawnSync(process.execPath,['-e',source],{cwd:require('node:path').join(__dirname,'../..')}).status,0);});
test('status text distinguishes stored snapshots, unresolved counts and missing coverage',()=>{const m={source:'database',coverage:{days:[{date:'2026-09-20',status:'complete',independentlyVerified:false}]},freshness:{oldestObservation:'2026-09-28T10:00:00Z'},metrics:{potentiallyIncomplete:['lemonade']}};const text=describe(m);assert.match(text,/0\/1 days independently verified/);assert.match(text,/lemonade/);assert.match(text,/No live updates/);assert.equal(require('../../lib/sales-data-status').rangeLabel({start:'2026-09-20',end:'2026-09-21'}),'2026-09-20');});
test('later comparisons cannot evict a visible product-classification warning',()=>{
  const fs=require('node:fs'),vm=require('node:vm');
  const html=fs.readFileSync(require('node:path').join(__dirname,'../../index.html'),'utf8');
  const elements=new Map();
  const sandbox={SalesDataStatus:require('../../lib/sales-data-status'),STORES:[],document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);}}};
  vm.createContext(sandbox);
  vm.runInContext(html.slice(html.indexOf('const salesDataNotices ='),html.indexOf('async function apiSalesRange')),sandbox);
  for(let i=0;i<18;i++)vm.runInContext(`recordSalesDataStatus(${JSON.stringify({source:'database',storeId:'store-'+i,start:'2026-09-20',end:'2026-09-21',complete:true,coverage:{days:[]},metrics:{potentiallyIncomplete:i===0?['lemonade']:[]}})})`,sandbox);
  assert.match(elements.get('sales-data-status-summary').textContent,/Product counts incomplete/);
  assert.match(elements.get('sales-data-status-detail').textContent,/lemonade/);
});

test('coverage-only warming keeps strict day evidence without loading any facts',async()=>{
  for(const [status,evidence,complete] of [['complete','complete-single-pass',true],['VERIFIED_CLOSED','verified-closed',true],['ZERO_OBSERVED_PENDING_REVIEW','zero-observed',false],['RETRY_REQUIRED','zero-observed',false]]){
    const s=session([{...state,status,evidence,lineCount:0,revenueIncl:'0',revenueExcl:'0'}],[]);
    const result=await readSnapshot(s,args,{coverageOnly:true});assert.equal(result.meta.complete,complete);assert.deepEqual(result.lines,[]);assert.equal(s.calls.length,1);assert(s.calls[0].sql.includes('sales_day_state'));
  }
  const oversized=session([{...state,lineCount:100001}]);assert.equal((await readSnapshot(oversized,args,{coverageOnly:true})).meta.complete,true);assert.equal(oversized.calls.length,1);
  const aggregated=await readSnapshot(session([{...state,lineCount:100001}]),args);
  assert.equal(aggregated.meta.complete,true);assert.equal(aggregated.meta.aggregated,true);
  assert.equal(aggregated.lines.length,1);assert.equal(aggregated.lines[0].date,state.date);
  assert.equal(aggregated.lines[0].priceexclvat,76);assert.equal(aggregated.lines[0].productid,row.productId);
});

test('opaque delivery products and all six stores pass catalogue validation for last-month equivalent',async()=>{
  // Verify opaque [P:xxx/yyy] Levering products are in the catalogue and validate
  const opaque=cat.products.find(p=>p.storeSlug==='christianshavn'&&p.productLabel.startsWith('[P:'));
  assert(opaque,'expected opaque product in catalogue');
  const delivery=cat.products.find(p=>p.storeSlug==='christianshavn'&&p.groupLabel==='Levering'&&!p.productLabel.startsWith('[P:'));
  assert(delivery,'expected non-opaque delivery product in catalogue');
  // Build a row from the opaque product and validate it through publicLine
  const opaqueRow={...row,date:'2026-09-24',saleLocal:'2026-09-24 14:00:00',productId:opaque.productId,productLabel:opaque.productLabel,groupId:opaque.groupId,groupLabel:opaque.groupLabel};
  const opaqueArgs={storeSlug:'christianshavn',start:'2026-09-24',end:'2026-09-25',now};
  const result=await readSnapshot(session([{...state,date:'2026-09-24',lineCount:1}],[opaqueRow]),opaqueArgs);
  assert.equal(result.meta.complete,true);
  assert.equal(result.lines.length,1);
  assert.equal(result.lines[0].productname,opaque.productLabel);
  // Verify every store has catalogue products (no store left empty after admission)
  for(const slug of ['christianshavn','fisketorvet','frederiksberg','indre-by','norrebro','vesterbro']){
    assert(cat.products.some(p=>p.storeSlug===slug),'missing catalogue products for '+slug);
  }
});
test('ranges exceeding MAX_LINES return PostgreSQL product-aggregated lines',async()=>{
  const largeNow=Date.parse('2026-10-28T12:00:00Z');
  const days=Array.from({length:300},(_,i)=>{const d=new Date(Date.UTC(2026,0,1+i)).toISOString().slice(0,10);
    return{date:d,status:'complete',evidence:'complete-single-pass',lineCount:700,observedAt:new Date('2026-10-28T03:00:00Z'),revenueIncl:'50000',revenueExcl:'40000'};});
  // Mock product-grouped rows returned by the GROUP BY query
  const groups=days.map(d=>({date:d.date,productId:'27242336',productLabel:'Killer Kebab',groupId:'2911776',groupLabel:'Rolls ',quantity:'700',revenueIncl:'50000',revenueExcl:'40000'}));
  const s=session(days,[],groups);
  const result=await readSnapshot(s,{storeSlug:'norrebro',start:'2026-01-01',end:'2026-10-28',now:largeNow});
  assert.equal(result.meta.complete,true);
  assert.equal(result.meta.aggregated,true);
  assert.equal(result.lines.length,300);
  assert.equal(result.lines[0].date,'2026-01-01');
  assert.equal(result.lines[0].priceexclvat,40000);
  assert.equal(result.lines[0].productid,'27242336','aggregated lines preserve product ID');
  assert.equal(result.meta.rawLineCount,210000);
  assert(s.calls.some(c=>c.sql.includes('GROUP BY')),'uses GROUP BY aggregation');
});
test('short ranges under MAX_LINES still load and validate individual facts',async()=>{
  const s=session([state],[row]);
  const result=await readSnapshot(s,args);
  assert.equal(result.meta.complete,true);
  assert.equal(result.meta.aggregated,undefined);
  assert.equal(result.lines.length,1);
  assert.equal(result.lines[0].productid,row.productId);
  assert.equal(result.lines[0].priceexclvat,76);
  assert(s.calls.some(c=>c.sql.includes('sales_line')),'must query sales_line for short ranges');
});
test('aggregated weekly revenue reconciles with individual day sums',async()=>{
  const weekNow=Date.parse('2026-02-01T12:00:00Z');
  const days=[];const groups=[];
  for(let i=0;i<21;i++){const d=new Date(Date.UTC(2026,0,5+i)).toISOString().slice(0,10);
    const excl=String(8000+i*80),incl=String(10000+i*100);
    days.push({date:d,status:'complete',evidence:'complete-single-pass',lineCount:5001,observedAt:new Date('2026-01-30T10:00:00Z'),revenueIncl:incl,revenueExcl:excl});
    groups.push({date:d,productId:'27242336',productLabel:'Killer Kebab',groupId:'2911776',groupLabel:'Rolls ',quantity:String(5001),revenueIncl:incl,revenueExcl:excl});}
  const s=session(days,[],groups);
  const result=await readSnapshot(s,{storeSlug:'norrebro',start:'2026-01-05',end:'2026-01-26',now:weekNow});
  assert.equal(result.meta.aggregated,true);
  const weekly={};for(const l of result.lines){
    const d=new Date(l.date+'T12:00:00Z'),wd=d.getUTCDay(),mon=new Date(d);mon.setUTCDate(d.getUTCDate()-(wd===0?6:wd-1));
    const wk=mon.toISOString().slice(0,10);weekly[wk]=(weekly[wk]||0)+l.priceexclvat;
  }
  const expectedWeekly={};for(const d of days){
    const dt=new Date(d.date+'T12:00:00Z'),wd=dt.getUTCDay(),mon=new Date(dt);mon.setUTCDate(dt.getUTCDate()-(wd===0?6:wd-1));
    const wk=mon.toISOString().slice(0,10);expectedWeekly[wk]=(expectedWeekly[wk]||0)+Number(d.revenueExcl);
  }
  assert.deepEqual(weekly,expectedWeekly);
});
test('product-aggregated lines preserve product IDs for roll/mix classification',async()=>{
  const largeNow=Date.parse('2026-02-01T12:00:00Z');
  const days=[{date:'2026-01-05',status:'complete',evidence:'complete-single-pass',lineCount:100001,observedAt:new Date('2026-01-06T03:00:00Z'),revenueIncl:'500000',revenueExcl:'400000'}];
  const ProductMetrics=require('../../lib/product-metrics');
  const kebabId='27242336',komboId='27242208',falafelId='27242332';
  const groups=[
    {date:'2026-01-05',productId:kebabId,productLabel:'Killer Kebab',groupId:'2911776',groupLabel:'Rolls ',quantity:'50',revenueIncl:'5000',revenueExcl:'4000'},
    {date:'2026-01-05',productId:komboId,productLabel:'Kombo - Lamb',groupId:'2911784',groupLabel:'Kombos',quantity:'30',revenueIncl:'3000',revenueExcl:'2400'},
    {date:'2026-01-05',productId:falafelId,productLabel:'Killer Falafel',groupId:'2911776',groupLabel:'Rolls ',quantity:'20',revenueIncl:'2000',revenueExcl:'1600'},
  ];
  const s=session(days,[],groups);
  const result=await readSnapshot(s,{storeSlug:'norrebro',start:'2026-01-05',end:'2026-01-06',now:largeNow});
  assert.equal(result.meta.aggregated,true);
  assert.equal(result.lines.length,3);
  const m=ProductMetrics.computeMetrics(result.lines);
  assert.equal(m.komboUnits,30,'kombo lamb count');
  assert.equal(m.rollUnits,70,'roll kebab + falafel count');
  assert.equal(m.breakdown.rollKebab,50);assert.equal(m.breakdown.rollFalafel,20);
  assert.equal(m.breakdown.komboLamb,30);
  assert(m.komboPct>0,'kombo percentage is non-zero');
});
test('genuine database failure returns explicit error and does not return aggregated data',async()=>{
  const failing={async query(){throw Object.assign(new Error('connection lost'),{code:'ECONNRESET'});}};
  await assert.rejects(readSnapshot(failing,args),/connection lost/);
});
