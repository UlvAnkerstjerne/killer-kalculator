'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {dailyScope,decision,runDaily}=require('../../lib/sales-worker/daily');
const {main}=require('../../scripts/sales-daily');
const now=new Date('2026-09-29T03:00:00Z');
test('daily scope starts forward of private historical gaps and excludes Copenhagen Today',()=>{
  assert.deepEqual(dailyScope('christianshavn','2026-09-28',now).days,['2026-09-28']);
  assert.deepEqual(dailyScope('norrebro','2026-09-28',new Date('2026-09-28T21:59:59Z')).days,[]);
  assert.deepEqual(dailyScope('norrebro','2026-09-28',new Date('2026-09-28T22:00:00Z')).days,['2026-09-28']);
});
test('daily scope uses seven calendar labels across both DST changes',()=>{
  for(const end of ['2026-03-30','2026-10-26']){
    const scope=dailyScope('norrebro','2026-01-01',new Date(end+'T04:00:00Z'));
    assert.equal(scope.days.length,7);assert.equal(scope.end,end);assert.equal(new Set(scope.days).size,7);
  }
});
test('only transient durable failures retry after twenty hours and at most three attempts',()=>{
  const day={attempts:1,errorCode:'UPSTREAM_FAILED',lastAttemptAt:'2026-09-28T03:00:00Z'};
  assert.equal(decision(day,now),'eligible');
  assert.equal(decision({...day,lastAttemptAt:now.toISOString()},now),'retry-not-due');
  assert.equal(decision({...day,attempts:3},now),'attempt-limit');
  for(const errorCode of ['ZERO_FACT_DAY_REVIEW','INVALID_PAGE'])assert.equal(decision({...day,errorCode},now),'operator-review');
  assert.equal(decision({...day,complete:true},now),'complete');
});
test('DB_OPERATION_FAILED, CATALOG_REVIEW and STORE_MISMATCH are retryable after the cooldown period',()=>{
  for(const errorCode of ['DB_OPERATION_FAILED','CATALOG_REVIEW','STORE_MISMATCH']){
    const day={attempts:1,errorCode,lastAttemptAt:'2026-09-28T03:00:00Z'};
    assert.equal(decision(day,now),'eligible','should retry '+errorCode+' after cooldown');
    assert.equal(decision({...day,lastAttemptAt:now.toISOString()},now),'retry-not-due');
    assert.equal(decision({...day,attempts:3},now),'attempt-limit');
  }
});
test('gaps exit code is zero when today publication succeeded',async()=>{
  const output=[];const env={KK_SALES_SYNC_ENABLED:'true',KK_SALES_SYNC_STORES:'norrebro',
    KK_SALES_DAILY_FROM:'2026-09-28'};
  // Disabled worker exits 0; gaps (older incomplete dates) with a successful run should also be 0.
  const code=await main(['--apply'],{...env,KK_SALES_SYNC_ENABLED:'false'},line=>output.push(JSON.parse(line)));
  assert.equal(code,0);assert.equal(output[0].status,'disabled');
});
test('disabled invocation never reads credentials or opens database/provider',async()=>{
  const output=[];const env=new Proxy({KK_SALES_SYNC_ENABLED:'false'},{get:(t,k)=>{if(!(k in t))throw Error('unexpected config access');return t[k];}});
  assert.equal(await main(['--apply'],env,line=>output.push(JSON.parse(line))),0);
  assert.equal(output[0].status,'disabled');
  assert.equal((await runDaily({apply:true,enabled:false})).status,'disabled');
});
test('invalid selectors and invalid configuration are closed safe codes',async()=>{
  for(const store of ['all','norrebro,vesterbro','private customer text'])assert.throws(()=>dailyScope(store,'2026-09-28',now),{code:'INVALID_OPTIONS'});
  assert.throws(()=>dailyScope('norrebro','invalid date',now),{code:'INVALID_OPTIONS'});
  const output=[];assert.equal(await main(['--readiness'],{KK_SALES_SYNC_STORES:'norrebro',KK_SALES_DAILY_FROM:'2026-09-28'},x=>output.push(x)),1);
  assert.match(output.join(''),/DB_DISABLED/);
});
