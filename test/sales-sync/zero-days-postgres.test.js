'use strict';
const {test,beforeEach,after}=require('node:test'),assert=require('node:assert/strict');
const {createDatabase}=require('../../lib/sales-db/database'),{migrate}=require('../../lib/sales-db/migrate');
const {disposableConfig}=require('./disposable'),{context:baseContext,options,raw:syntheticRaw,provider}=require('./helpers');
const {importHistory,withImportBatch}=require('../../lib/sales-sync/importer');
const {withImportOwner}=require('../../lib/sales-sync/owner'),{createImportRepository}=require('../../lib/sales-sync/repository');
const {reviewZeroDay,retainZeroObservations,listZeroDays}=require('../../lib/sales-sync/zero-days');
const {readSnapshot}=require('../../lib/sales-db/dashboard'),{selectSalesRead}=require('../../lib/sales-read-policy');
const reviewed=require('../../catalogues/onlinepos-reviewed.json'),p=reviewed.products.find(p=>p.storeSlug==='norrebro'),pay=reviewed.payments[0];
const context={identity:baseContext.identity,catalog:require('../../lib/sales-db/facts').createReviewedCatalog(reviewed)};
const raw=(extra={})=>syntheticRaw({productid:p.productId,productname:p.productLabel,productgroupid:p.groupId,productgroup:p.groupLabel,paymenttype:pay.paymentType,paymenttypecode:pay.paymentCode,...extra});
const config=disposableConfig(),db=createDatabase(config),opts={...options,start:'2025-01-01',end:'2025-01-04'};
const scan=(pages=[[raw({timestamp_pay:'2025-01-01 12:00:00'})]],extra={})=>importHistory({config,context,apply:true,now:()=>new Date('2026-09-29T10:00:00Z'),options:opts,request:provider(pages).request,...extra});
const rows=async()=> (await db.query('SELECT xmin::text,ctid::text,* FROM sales_foundation.sales_day_state ORDER BY business_date')).rows;
const facts=async()=> (await db.query('SELECT xmin::text,ctid::text,* FROM sales_foundation.sales_line ORDER BY source_key')).rows;
const route=(start='2025-01-01',end='2025-01-04')=>selectSalesRead({policy:'covered-history',read:a=>db.transaction(s=>readSnapshot(s,{...a,now:Date.parse('2026-09-29T12:00:00Z')}))},{storeSlug:'norrebro',start,end,today:'2026-09-29'});
const decide=(run,date,decision)=>withImportOwner(config,s=>reviewZeroDay(s,{storeSlug:'norrebro',businessDate:date,observationRun:run,decision,reviewedBy:'ulv'}));
beforeEach(async()=>{await db.query('DROP SCHEMA IF EXISTS sales_foundation CASCADE');await migrate(db);});
after(()=>db.close());
test('one genuine terminal scan publishes nonzero days and leaves zeros pending; mixed routing is wholly provider',async()=>{
 let calls=0;const mock=provider([[raw({timestamp_pay:'2025-01-03 12:00:00'})],[raw({orderlineid:'synthetic-older',timestamp_pay:'2025-01-01 12:00:00',price:'0',count:'0'})]]);
 const r=await scan(undefined,{request:async(...a)=>{calls++;return mock.request(...a);},limits:{batchSize:500}});
 assert.equal(calls,2);assert.equal(r.lineCount,2);assert.equal(r.pendingZeroDays,1);assert.equal((await facts()).length,2);
 assert.deepEqual((await rows()).map(d=>d.status),['complete','ZERO_OBSERVED_PENDING_REVIEW','complete']);
 const mixed=await route();assert.equal(mixed.source,'onlinepos');assert.equal(mixed.databaseCoverage.days[1].zeroDayStatus,'ZERO_OBSERVED_PENDING_REVIEW');
 assert.equal((await route('2025-01-02','2025-01-03')).source,'onlinepos');
 assert.equal((await route('2025-01-01','2025-01-02')).source,'database');
 assert.equal((await db.query('SELECT count(*)::int n FROM sales_foundation.sales_stage_line')).rows[0].n,0);
});
test('explicit Ulv closure is covered without fake facts or source verification; approval is idempotent',async()=>{
 const r=await scan([[]]);await decide(r.runId,'2025-01-01','VERIFIED_CLOSED');const before=await rows();
 await decide(r.runId,'2025-01-01','VERIFIED_CLOSED');assert.deepEqual(await rows(),before);assert.equal((await facts()).length,0);
 const x=await route('2025-01-01','2025-01-02');assert.equal(x.source,'database');assert.equal(x.result.lines.length,0);
 assert.equal(x.result.meta.coverage.days[0].independentlyVerified,false);assert.equal(x.result.meta.coverage.days[0].evidence,'verified-closed');
 await assert.rejects(decide(r.runId,'2025-01-01','RETRY_REQUIRED'),{code:'INVALID_RUN'});
});
test('retry-required remains uncovered and a repeat zero scan cannot silently reverse the decision',async()=>{
 const r=await scan([[]]);await decide(r.runId,'2025-01-02','RETRY_REQUIRED');const before=await rows();await scan([[]]);
 assert.deepEqual(await rows(),before);const x=await route();assert.equal(x.source,'onlinepos');assert.equal(x.databaseCoverage.days[1].zeroDayStatus,'RETRY_REQUIRED');
 await decide(r.runId,'2025-01-02','RETRY_REQUIRED');assert.deepEqual(await rows(),before);
});
test('repeat and unavoidable covered overlap preserve fact and coverage physical versions',async()=>{
 await scan();const f=await facts(),d=await rows();await scan();assert.deepEqual(await facts(),f);assert.deepEqual(await rows(),d);
 await assert.rejects(scan([[raw({timestamp_pay:'2025-01-01 12:00:00',price:'11'})]]),{code:'RECONCILIATION_REQUIRED'});
 assert.deepEqual(await facts(),f);assert.deepEqual(await rows(),d);
});
test('invalid terminal declared totals publish neither facts nor pending zero records',async()=>{
 await assert.rejects(scan(undefined,{request:async()=>'{"data":[],"current_page":1,"next_page_url":null,"total":1}'}),{code:'INVALID_PAGE'});
 assert.equal((await facts()).length,0);assert.equal((await rows()).length,0);
});
test('monthly crash resumes the same terminal snapshot, preserving committed facts and pending dates with zero HTTP',async()=>{
 const scope={...opts,end:'2025-03-01'};
 await db.query(`CREATE FUNCTION sales_foundation.fail_feb() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.business_date >= '2025-02-01'::date THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER fail_feb BEFORE INSERT ON sales_foundation.sales_day_state FOR EACH ROW EXECUTE FUNCTION sales_foundation.fail_feb()`);
 await assert.rejects(scan([[raw({timestamp_pay:'2025-01-01 12:00:00'}),raw({orderlineid:'synthetic-feb',timestamp_pay:'2025-02-01 12:00:00'})]],{options:scope}),{code:'DB_OPERATION_FAILED'});
 const f=await facts(),d=await rows();assert.equal(f.length,1);assert.equal(d.length,31);
 const id=(await db.query("SELECT run_id FROM sales_foundation.sales_import_scan WHERE status='publication-pending'")).rows[0].run_id;
 await assert.rejects(scan(undefined,{request:async()=>assert.fail('new traversal forbidden')}),{code:'PUBLICATION_PENDING'});
 await db.query('DROP TRIGGER fail_feb ON sales_foundation.sales_day_state');
 await scan(undefined,{options:{...scope,resumePublication:id},request:async()=>assert.fail('resume must not fetch')});
 assert.deepEqual((await facts()).filter(x=>x.business_date.getMonth()===0),f);assert.deepEqual((await rows()).slice(0,31),d);
 assert.equal((await facts()).length,2);assert.equal((await rows()).length,59);
});
test('terminal staged snapshot survives process loss before preflight and blocks fresh traversals',async()=>{
 let id;await withImportOwner(config,async s=>{
  const repo=createImportRepository(s,context);const run=await repo.begin({...opts,observedAt:'2026-09-29T10:00:00Z',zeroDayPolicy:'review'});id=run.id;
  await repo.finishScan(run,{terminal:true});
 });
 await assert.rejects(scan(undefined,{request:async()=>assert.fail('no source')}),{code:'PUBLICATION_PENDING'});
 await scan(undefined,{options:{...opts,resumePublication:id},request:async()=>assert.fail('no source')});
 assert.equal((await rows()).length,3);assert.ok((await rows()).every(r=>r.status==='ZERO_OBSERVED_PENDING_REVIEW'));
});
test('old guard zeros are retained from exact durable summaries without refetch, approval or fact mutation',async()=>{
 await assert.rejects(withImportBatch({config,context,requireNonEmpty:true},({importOne})=>importOne({options:opts,request:provider([[raw({timestamp_pay:'2025-01-01 12:00:00'})]]).request})),{code:'ZERO_FACT_DAY_REVIEW'});
 const id=(await db.query('SELECT run_id FROM sales_foundation.sales_import_scan')).rows[0].run_id;
 await withImportOwner(config,s=>retainZeroObservations(s,id));const before=await rows();assert.equal(before.length,2);
 await withImportOwner(config,s=>retainZeroObservations(s,id));assert.deepEqual(await rows(),before);assert.equal((await facts()).length,0);
 const safe=await withImportOwner(config,listZeroDays);assert.ok(!/run|digest|fingerprint|source_key/.test(JSON.stringify(safe)));
});
test('approval rejects wrong observation and never rewrites a normal covered day',async()=>{
 const r=await scan();await assert.rejects(decide(r.runId,'2025-01-01','VERIFIED_CLOSED'),{code:'INVALID_RUN'});
 await assert.rejects(decide('00000000-0000-0000-0000-000000000000','2025-01-02','VERIFIED_CLOSED'),{code:'INVALID_RUN'});
});
test('durable planner consolidates years, skips complete/review dates, and isolates protected operator ranges',async()=>{
 await scan();const {planHistorical}=require('../../lib/sales-sync/historical-plan');
 const plan=await withImportOwner(config,s=>planHistorical(s,{stores:['norrebro','vesterbro','christianshavn'],start:'2025-01-01',end:'2026-09-20',blockedRanges:[{store:'christianshavn',start:'2026-01-01',end:'2026-09-20'}]}));
 assert.deepEqual(plan.units.map(x=>[x.store,x.start,x.end]),[['norrebro','2025-01-04','2026-09-20'],['vesterbro','2025-01-01','2026-09-20'],['christianshavn','2025-01-01','2026-01-01']]);
 assert.equal(plan.units[1].missingDays,627);assert.equal(plan.providerConcurrency,1);
});
test('bounded retry can replace a pending zero with real facts while preserving unrelated coverage',async()=>{
 const r=await scan();await decide(r.runId,'2025-01-02','RETRY_REQUIRED');const first=(await rows())[0];const f=await facts();
 await scan([[raw({orderlineid:'synthetic-later',timestamp_pay:'2025-01-02 12:00:00'})]],{options:{...opts,start:'2025-01-02',end:'2025-01-03'}});
 assert.equal((await rows())[1].status,'complete');assert.equal((await rows())[1].zero_observation_run,null);
 assert.deepEqual((await rows())[0],first);assert.deepEqual((await facts()).filter(x=>x.business_date.getDate()===1),f);
});
test('unchanged column-only dashboard grants can read pending and approved empty days',async()=>{
 const r=await scan([[]]);await decide(r.runId,'2025-01-01','VERIFIED_CLOSED');
 await db.query(require('fs').readFileSync(require('path').join(__dirname,'../../docs/operations/dashboard-reader-grants.sql'),'utf8').replaceAll('kk_sales_dashboard','zero_reader_test').replace(' LOGIN ',' NOLOGIN '));
 try{
 const reader=require('../../lib/sales-db/dashboard').createDashboardReader({transaction:work=>db.transaction(async s=>{await s.query('SET LOCAL ROLE zero_reader_test');return work(s);})});
 assert.equal((await reader.read({storeSlug:'norrebro',start:'2025-01-01',end:'2025-01-02'})).meta.complete,true);
 assert.equal((await reader.read({storeSlug:'norrebro',start:'2025-01-01',end:'2025-01-03'})).meta.complete,false);
 await assert.rejects(db.transaction(async s=>{await s.query('SET LOCAL ROLE zero_reader_test');await s.query('SELECT zero_observation_run FROM sales_foundation.sales_day_state');}));
 }finally{await db.query('DROP OWNED BY zero_reader_test; DROP ROLE zero_reader_test');}
});
test('250 and 500 staging batches preserve identical exact decimals, checksum, privacy and immutable replay',async()=>{
 const pages=[Array.from({length:1001},(_,i)=>raw({orderlineid:'synthetic-size-'+i,timestamp_pay:'2025-01-01 12:00:00',price:'10.123456789012345678',priceexclvat:'8.000000000000000001',count:'0.125'}))];
 const first=await scan(pages,{limits:{batchSize:250}}),before=await facts(),stateBefore=await rows();
 const second=await scan(pages,{limits:{batchSize:500}});
 assert.equal(first.revenueIncl,second.revenueIncl);assert.equal(first.revenueExcl,second.revenueExcl);assert.equal(first.lineCount,1001);
 assert.deepEqual(await facts(),before);assert.deepEqual(await rows(),stateBefore);
 assert.ok(!/sourceKey|fingerprint|productLabel|source_key/.test(JSON.stringify([first,second])));
});
