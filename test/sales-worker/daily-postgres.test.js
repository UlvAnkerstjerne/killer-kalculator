'use strict';
const {test,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
const {createDatabase}=require('../../lib/sales-db/database');
const {migrate}=require('../../lib/sales-db/migrate');
const {runDaily}=require('../../lib/sales-worker/daily');
const {withImportOwner}=require('../../lib/sales-sync/owner');
const {createIdentity}=require('../../lib/sales-db/identity');
const {disposableConfig}=require('../sales-sync/disposable');
const {identity,context,credentials,row,body}=require('./helpers');
const config=disposableConfig(),db=createDatabase(config);
const now=()=>new Date('2026-09-22T03:00:00Z');
const daily=(extra={})=>runDaily({config,context,credentials,store:'norrebro',from:'2026-09-21',apply:true,enabled:true,now,
 requestFor:()=>async()=>body([row('norrebro','2026-09-21')]),...extra});
const counts=async()=>Object.fromEntries(await Promise.all(['sales_line','sales_day_state','sales_sync_run','sales_import_scan','sales_stage_line'].map(async name=>[name,(await db.query('SELECT count(*)::int n FROM sales_foundation.'+name)).rows[0].n])));
const snapshot=async()=>JSON.stringify((await db.query('SELECT row_to_json(t)::text row,xmin::text version FROM sales_foundation.sales_line t ORDER BY source_key')).rows);
beforeEach(async()=>{
 await db.query('DROP SCHEMA IF EXISTS sales_foundation CASCADE');await migrate(db);
 await db.query('INSERT INTO sales_foundation.identity_key_check VALUES(true,$1,$2)',[identity.version,identity.check()]);
});
after(()=>db.close());
test('normal day publishes once with safe audit; repeat performs no fetch or fact/audit mutation',async()=>{
 const events=[];const first=await daily({emit:e=>events.push(e)});
 assert.equal(first.status,'complete');assert.equal(first.published,1);assert.equal(first.requests,1);
 assert.equal(first.days[0].evidence,'complete-single-pass');assert.equal(first.days[0].attempts,1);assert.ok(first.days[0].lastAttemptAt);
 const stored=await snapshot(),audit=await counts();
 const repeat=await daily({requestFor:()=>{throw Error('no repeat source');}});
 assert.equal(repeat.status,'complete');assert.equal(repeat.attempted,0);assert.equal(repeat.requests,0);
 assert.equal(await snapshot(),stored);assert.deepEqual(await counts(),audit);
 assert.equal(events.at(-1).completionState,'complete');
 assert.doesNotMatch(JSON.stringify({first,events}),/synthetic-worker|fingerprint|source_key|runId|productname|companyId|token/);
});
test('readiness checks real migrations and identity with zero provider and audit writes',async()=>{
 const prior=await counts();
 const result=await daily({apply:false,requestFor:()=>{throw Error('no source');}});
 assert.equal(result.status,'ready');assert.deepEqual(await counts(),prior);
 const mismatch=await daily({apply:false,context:{...context,identity:createIdentity({key:Buffer.alloc(32,8),version:1})}});
 assert.equal(mismatch.code,'IDENTITY_MISMATCH');assert.deepEqual(await counts(),prior);
});
test('empty terminal day remains missing and does not retry automatically',async()=>{
 const first=await daily({requestFor:()=>async()=>body([])});
 assert.equal(first.status,'gaps');assert.equal(first.days[0].errorCode,'ZERO_FACT_DAY_REVIEW');assert.equal(first.days[0].action,'operator-review');
 assert.equal((await counts()).sales_day_state,0);assert.equal((await counts()).sales_line,0);
 assert.equal((await daily({requestFor:()=>{throw Error('no empty retry');}})).attempted,0);
});
test('provider failure is safely recorded; no immediate retry; a later invocation succeeds',async()=>{
 const events=[];let requests=0;
 const first=await daily({emit:e=>events.push(e),requestFor:()=>async()=>{requests++;throw Error('SYNTHETIC_PRIVATE_CANARY');}});
 assert.equal(first.status,'gaps');assert.equal(requests,1);assert.equal(first.days[0].errorCode,'UPSTREAM_FAILED');
 assert.equal(first.days[0].action,'retry-not-due');assert.equal(events.at(-1).completionState,'missing');
 const repeat=await daily({requestFor:()=>{throw Error('no immediate retry');}});assert.equal(repeat.attempted,0);
 // The durable attempt timestamp, not process memory, controls a subsequent invocation.
 await db.query("UPDATE sales_foundation.sales_sync_run SET observed_at='2026-09-21T03:00:00Z'");
 const later=await daily();assert.equal(later.published,1);assert.equal(later.days[0].attempts,2);
 assert.doesNotMatch(JSON.stringify({first,events}),/SYNTHETIC_PRIVATE_CANARY/);
});
test('three durable transient attempts exhaust the bound without a fourth fetch',async()=>{
 for(let i=0;i<3;i++){
  const r=await daily({requestFor:()=>async()=>{throw Error('upstream');}});assert.equal(r.attempted,1);
  await db.query("UPDATE sales_foundation.sales_sync_run SET observed_at='2026-09-21T03:00:00Z'");
 }
 const limited=await daily({requestFor:()=>{throw Error('no fourth fetch');}});
 assert.equal(limited.attempted,0);assert.equal(limited.days[0].action,'attempt-limit');
});
test('quarantined date does not halt another date; private text never appears in events',async()=>{
 let calls=0;const events=[];
 const result=await daily({from:'2026-09-20',emit:e=>events.push(e),requestFor:()=>async()=>{
  calls++;return body([calls===1?row('norrebro','2026-09-21',{productname:'synthetic unknown label'}):row('norrebro','2026-09-20')]);
 }});
 assert.equal(result.attempted,2);assert.equal(result.published,1);assert.equal(result.status,'gaps');
 assert.equal(result.days[0].errorCode,'CATALOG_REVIEW');assert.equal(result.days[1].complete,true);
 assert.doesNotMatch(JSON.stringify({result,events}),/synthetic unknown|base64|productLabel|sha256|runId/);
});
test('newest missing day wins; at most two of seven dates are attempted',async()=>{
 let calls=0;const r=await daily({from:'2026-09-13',requestFor:()=>async()=>body([row('norrebro',calls++===0?'2026-09-21':'2026-09-20')])});
 assert.equal(r.days.length,7);assert.equal(r.attempted,2);assert.equal(r.published,2);assert.equal(r.days[0].date,'2026-09-21');assert.equal(r.days.at(-1).date,'2026-09-15');
});
test('declared-total mismatch never publishes partial data',async()=>{
 const r=await daily({requestFor:()=>async()=>body([row('norrebro','2026-09-21')]).replace('"current_page":1','"total":2,"current_page":1')});
 assert.equal(r.days[0].errorCode,'INVALID_PAGE');assert.equal((await counts()).sales_line,0);assert.equal((await counts()).sales_day_state,0);
});
test('source pagination has a hard twenty-request ceiling, no early chronological exit',async()=>{
 let calls=0;const r=await daily({requestFor:()=>async url=>body([row('norrebro','2026-09-23')],++calls,url.split('?')[0]+'?page='+(calls+1))});
 assert.equal(calls,20);assert.equal(r.requests,20);assert.equal(r.days[0].errorCode,'PAGE_LIMIT');assert.equal((await counts()).sales_line,0);
});
test('global importer ownership defers overlap with no fetch or audit writes',async()=>{
 await withImportOwner(config,async()=>{
  const prior=await counts();const r=await daily({requestFor:()=>{throw Error('no overlapping source');}});
  assert.equal(r.status,'busy');assert.equal(r.attempted,0);assert.deepEqual(await counts(),prior);
 });
 assert.equal((await daily()).published,1);
});
test('uncertain publication checkpoint stops source on both this and later invocations',async()=>{
 await db.query(`CREATE FUNCTION sales_foundation.reject_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
 CREATE TRIGGER reject_publish BEFORE INSERT ON sales_foundation.sales_day_state FOR EACH ROW EXECUTE FUNCTION sales_foundation.reject_publish()`);
 const events=[];const r=await daily({from:'2026-09-20',emit:e=>events.push(e)});
 assert.equal(r.code,'PUBLICATION_PENDING');assert.equal(r.attempted,1);assert.equal(events.at(-1).completionState,'publication-pending');
 assert.equal((await counts()).sales_line,0);
 const prior=await counts();const repeat=await daily({requestFor:()=>{throw Error('no uncertain refetch');}});
 assert.equal(repeat.code,'PUBLICATION_PENDING');assert.equal(repeat.attempted,0);assert.deepEqual(await counts(),prior);
});
test('lost database connection reports unknown outcome, not a claimed rollback',async()=>{
 const events=[];const result=await daily({emit:e=>events.push(e),requestFor:()=>async()=>{
  const pid=(await db.query("SELECT pid FROM pg_stat_activity WHERE application_name='kk-sales-backfill'")).rows[0].pid;
  await db.query('SELECT pg_terminate_backend($1)',[pid]);await new Promise(r=>setTimeout(r,30));return body([row('norrebro','2026-09-21')]);
 }});
 assert.equal(result.status,'incomplete');assert.equal(result.code,'LOCK_LOST');assert.equal(events.at(-1).completionState,'unavailable');assert.equal(result.attempted,1);
});
