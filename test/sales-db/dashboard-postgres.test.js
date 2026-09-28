'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {disposableConfig}=require('../sales-sync/disposable');
const {createDatabase}=require('../../lib/sales-db/database');
const {migrate}=require('../../lib/sales-db/migrate');
const {createIdentity}=require('../../lib/sales-db/identity');
const {createReviewedCatalog,createSafeLine}=require('../../lib/sales-db/facts');
const {createRepository}=require('../../lib/sales-db/repository');
const {createDashboardReader}=require('../../lib/sales-db/dashboard');
const db=createDatabase(disposableConfig()),other=createDatabase(disposableConfig());
const config=require('../../catalogues/onlinepos-reviewed.json'),context={identity:createIdentity({key:Buffer.alloc(32,7),version:1}),catalog:createReviewedCatalog(config)};
const repo=createRepository(db,context);let versionBefore;
const args={storeSlug:'norrebro',start:'2026-09-20',end:'2026-09-21',now:Date.parse('2026-09-28T12:00:00Z')};
function fact(n,quantity='1',price='95',excl='76') { const p=config.products.find(p=>p.storeSlug==='norrebro'&&p.productId==='27242336');return createSafeLine({...p,sourceLineId:'dashboard-test-'+n,businessDate:'2026-09-20',saleLocal:'2026-09-20 14:00:00',timeSource:'payment',quantity,revenueIncl:price,revenueExcl:excl,...config.payments[0]},context); }
const lines=[fact(1),fact(2,'-1','-95','-76'),fact(3,'1','0','0')];
const readonly={transaction:work=>db.transaction(async s=>{await s.query('SET LOCAL ROLE dashboard_reader_test');return work(s);}),close:async()=>{}};
const reader=createDashboardReader(readonly);
before(async()=>{await db.query('DROP SCHEMA IF EXISTS sales_foundation CASCADE');await migrate(db);await db.query(require('node:fs').readFileSync(require('node:path').join(__dirname,'../../docs/operations/dashboard-reader-grants.sql'),'utf8').replaceAll('kk_sales_dashboard','dashboard_reader_test').replace(' LOGIN ', ' NOLOGIN '));await repo.publishCompletedRun({runId:crypto.randomUUID(),storeSlug:'norrebro',start:args.start,end:args.end,observedAt:'2026-09-28T10:00:00.000Z',complete:true,expectedLineCount:3,lines});versionBefore=(await db.query('SELECT xmin::text,ctid::text FROM sales_foundation.sales_line ORDER BY source_key')).rows;});
after(async()=>{assert.deepEqual((await db.query('SELECT xmin::text,ctid::text FROM sales_foundation.sales_line ORDER BY source_key')).rows,versionBefore);await db.close();await other.close();});
test('real PostgreSQL read-only role returns all lines and signed totals without changing versions',async()=>{const x=await reader.read(args);assert.equal(x.meta.complete,true);assert.equal(x.lines.length,3);assert.equal(x.lines.reduce((n,l)=>n+l.priceexclvat,0),0);assert.equal(x.meta.coverage.days[0].evidence,'complete-single-pass');});
test('real database rejects privileged web credentials',async()=>{await assert.rejects(createDashboardReader(db).read(args));});
test('read role cannot mutate facts and missing days remain incomplete',async()=>{await assert.rejects(readonly.transaction(s=>s.query('DELETE FROM sales_foundation.sales_line')));const x=await reader.read({...args,end:'2026-09-22'});assert.equal(x.meta.complete,false);assert.equal(x.lines.length,0);});
test('coverage and facts retain one snapshot during a concurrent metadata update',async()=>{let changed=false;const snapshotDb={transaction:work=>readonly.transaction(s=>work({query:async(q,v)=>{const result=await s.query(q,v);if(q.includes('FROM sales_foundation.sales_day_state')&&!changed){changed=true;await other.query("UPDATE sales_foundation.sales_day_state SET line_count=99 WHERE store_id=6 AND business_date='2026-09-20'");}return result;}})),close:async()=>{}};try{const x=await createDashboardReader(snapshotDb).read(args);assert.equal(x.meta.complete,true);assert.equal(x.meta.coverage.days[0].lineCount,3);}finally{await other.query("UPDATE sales_foundation.sales_day_state SET line_count=3 WHERE store_id=6 AND business_date='2026-09-20'");}});
test('bounded dashboard projection preserves signed metrics and column-only grants',async()=>{
 const raw=await reader.read(args),compact=await reader.read({...args,projection:'dashboard'}),revenue=await reader.read({...args,projection:'revenue',boundary:args.start});
 assert.equal(compact.meta.projection,'dashboard');assert.equal(compact.meta.rawLineCount,3);assert.equal(compact.lines.reduce((n,l)=>n+l.sourceLineCount,0),3);
 assert.deepEqual(require('../../lib/product-metrics').computeMetrics(compact.lines),require('../../lib/product-metrics').computeMetrics(raw.lines));
 assert.equal(compact.lines.reduce((n,l)=>n+l.priceexclvat,0),raw.lines.reduce((n,l)=>n+l.priceexclvat,0));assert.equal(revenue.summary.completeRevenue,0);assert.deepEqual(revenue.summary.daily[0].seconds,[[50400,0]]);
 assert(compact.lines.some(l=>l.price<0));assert(compact.lines.some(l=>l.price===0));assert(compact.lines.every(l=>l.secondOfDay===null&&l.hour===14));
});
test('cursor projection uses the original coverage snapshot and rejects later ledger disagreement',async()=>{
 let changed=false;const snapshotDb={transaction:work=>readonly.transaction(s=>work({query:async(q,v)=>{const result=await s.query(q,v);if(q.startsWith('FETCH')&&!changed){changed=true;await other.query("UPDATE sales_foundation.sales_day_state SET line_count=99 WHERE store_id=6 AND business_date='2026-09-20'");}return result;}})),close:async()=>{}};
 try{const x=await createDashboardReader(snapshotDb).read({...args,projection:'dashboard'});assert.equal(x.meta.complete,true);assert.equal(x.meta.rawLineCount,3);await assert.rejects(reader.read({...args,projection:'dashboard'}));}finally{await other.query("UPDATE sales_foundation.sales_day_state SET line_count=3 WHERE store_id=6 AND business_date='2026-09-20'");}
});
test('real database fails closed on ledger mismatch',async()=>{await db.query("UPDATE sales_foundation.schema_migration SET checksum=repeat('0',64) WHERE version='004_empty_product_labels.sql'");await assert.rejects(reader.read(args));});

test('column-only role cannot read protected identities or unneeded import state',async()=>{for(const sql of ['SELECT source_key FROM sales_foundation.sales_line','SELECT fingerprint FROM sales_foundation.sales_line','SELECT * FROM sales_foundation.identity_key_check','SELECT * FROM sales_foundation.sales_sync_run'])await assert.rejects(readonly.transaction(s=>s.query(sql)));});
