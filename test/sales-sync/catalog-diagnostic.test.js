'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {diagnoseCatalogReview,validateEnvelope,MAX_OUTPUT_BYTES}=require('../../lib/sales-sync/catalog-diagnostic');
const {inspectProcessResult,captureProcess,persistEvidence,runAndRetain,MAX_STREAM_BYTES}=require('../../lib/sales-sync/diagnostic-process');
const {main,parseArgs}=require('../../scripts/sales-backfill');
const options={storeSlug:'norrebro',companyId:'12345',start:'2025-01-01',end:'2025-01-02'};
const CANARY=['SYNTHETIC','PRIVATE','IMPORTER','CANARY'].join('_');
const row=(extra={})=>({firmaid:'12345',timestamp_pay:options.start,productid:'synthetic-product',productname:'Synthetic label ',productgroupid:'synthetic-group',productgroup:'Synthetic group',paymenttype:'Synthetic payment',paymenttypecode:'mixed 1',...extra});
const body=(data,extra={})=>JSON.stringify({data,current_page:1,next_page_url:null,...extra});
const reviewed={products:[],payments:[{paymentType:'Synthetic payment',paymentCode:'mixed 1'}]};
const run=(rows=[row()],extra={})=>diagnoseCatalogReview({reviewed,options,request:async()=>body(rows),...extra});
const inspect=(envelope,extra={})=>inspectProcessResult({stdout:JSON.stringify(envelope)+'\n',exitCode:0,...extra});
async function temp(work){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'kk-safe-diagnostic-'));try{return await work(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}
const safe=v=>assert(!JSON.stringify(v).includes(CANARY),'Privacy canary must not survive');
test('single traversal emits exact sparse candidate, absent total and positive in-range count',async()=>{
 let calls=0;const r=await run(null,{request:async()=>{calls++;return body([row({orderlineid:CANARY,customer:CANARY,card:CANARY,clerk:CANARY})]);}});
 assert.equal(calls,1);assert.equal(r.outcome,'candidates');assert.equal(r.traversal.requests,1);assert.equal(r.traversal.pages,1);assert.equal(r.traversal.inRangeRows,1);assert.equal(r.traversal.declaredTotalPresence,'absent');assert.equal(r.traversal.declaredTotalMatches,null);assert.equal(r.traversal.terminal,true);
 assert.equal(r.review.productCandidates[0].productLabel,'Synthetic label ');assert.deepEqual(r.review.paymentCandidates,[]);safe(r);
});
test('same invocation returns structural-only evidence after full terminal validation',async()=>{
 const r=await run([row(),row({productname:'customer:'+CANARY})]);assert.equal(r.outcome,'structural-review');assert.equal(r.code,'CATALOG_TEXT_REVIEW');assert.equal(r.traversal.inRangeRows,2);assert.equal(r.review.rejectedRows,1);assert.equal(r.review.diagnostics[0].fieldRole,'product-label');assert(!JSON.stringify(r).includes('Synthetic label'));assert(!Object.hasOwn(r.review,'productCandidates'));safe(r);
});
test('payment review stays explicit and envelope cannot establish trusted catalogue',async()=>{
 const r=await run([row({paymenttype:'New payment'})]);assert.equal(r.review.paymentCandidates.length,1);assert.throws(()=>require('../../lib/sales-db/facts').createReviewedCatalog(r));
});
test('zero in-range and already-reviewed rows return completed without candidates',async()=>{
 const zero=await run([row({timestamp_pay:options.end,productname:'customer:'+CANARY})]);assert.equal(zero.outcome,'completed');assert.equal(zero.traversal.inRangeRows,0);safe(zero);
 const product={...(await run()).review.productCandidates[0]};delete product.classification;delete product.affectedRows;
 assert.equal((await run([row()],{reviewed:{products:[product],payments:reviewed.payments}})).outcome,'completed');
});
for(const total of [1,2])test('declared total '+(total===1?'validated':'mismatch fails closed'),async()=>{
 const r=await run(null,{request:async()=>body([row()],{total})});assert.equal(r.traversal.declaredTotalPresence,'present');assert.equal(r.traversal.declaredTotalMatches,total===1);assert.equal(r.outcome,total===1?'candidates':'operational-failure');
 if(total===2){assert.equal(r.code,'INVALID_PAGE');assert.equal(r.traversal.terminal,false);assert.equal(r.review,null);}
});
test('later-date first page never causes chronological early exit',async()=>{
 let calls=0;const r=await run(null,{request:async url=>{calls++;return body([row({timestamp_pay:calls===1?options.end:options.start})],{current_page:calls,next_page_url:calls===1?url+'?page=2':null,total:2});}});
 assert.equal(calls,2);assert.equal(r.traversal.pages,2);assert.equal(r.traversal.rows,2);assert.equal(r.traversal.inRangeRows,1);assert.equal(r.traversal.terminal,true);
});
for(const [name,request,code] of [['invalid JSON',async()=>'{','INVALID_JSON'],['provider failure',async()=>{throw Error(CANARY);},'UPSTREAM_FAILED'],['missing terminal',async()=>JSON.stringify({data:[row()],current_page:1}),'INVALID_PAGE'],['wrong store',async()=>body([row({firmaid:'99999'})]),'STORE_MISMATCH'],['wrong time',async()=>body([row({timestamp_pay:'invalid'})]),'INVALID_LINE']])test('versioned safe '+name+' without retry',async()=>{
 let calls=0;const r=await run(null,{request:async()=>{calls++;return request();}});assert.equal(calls,1);assert.equal(r.outcome,'operational-failure');assert.equal(r.code,code);assert.equal(r.review,null);safe(r);
});
test('one-page bound refuses a second provider request',async()=>{
 let calls=0;const r=await run(null,{limits:{maxPages:1},request:async url=>{calls++;return body([row()],{next_page_url:url+'?page=2'});}});assert.equal(calls,1);assert.equal(r.code,'PAGE_LIMIT');assert.equal(r.traversal.terminal,false);
});
for(const field of ['productid','productname','productgroupid','productgroup','paymenttype','paymenttypecode'])test('refused '+field+' yields structural-only evidence',async()=>{
 const r=await run([row({[field]:'customer:'+CANARY})]);assert.equal(r.outcome,'structural-review');assert.equal(r.review.diagnostics.length,1);safe(r);
});
test('empty product label stays exact and whitespace-only label is refused',async()=>{
 assert.equal((await run([row({productname:''})])).review.productCandidates[0].productLabel,'');const r=await run([row({productname:'   '})]);assert.equal(r.outcome,'structural-review');assert.equal(r.review.diagnostics[0].reason,'EMPTY_TEXT');
});
test('candidate and structural output bounds stay fixed across growing input',async()=>{
 const tooMany=await run(Array.from({length:13},(_,i)=>row({productid:'synthetic-'+i})));assert.equal(tooMany.outcome,'operational-failure');assert.equal(tooMany.code,'ROW_LIMIT');assert.equal(tooMany.review,null);
 const many=await run(Array.from({length:1000},(_,i)=>row({productname:'x'.repeat(161+i)})));assert.equal(many.outcome,'structural-review');assert.equal(many.review.diagnostics.length,12);assert.equal(many.review.rejectedFields,1000);assert.equal(many.review.omittedFields,988);assert(Buffer.byteLength(JSON.stringify(many))<=MAX_OUTPUT_BYTES);
});
for(const exitCode of [0,1])test('controller retains candidate before interpreting exit '+exitCode,async()=>{const r=inspect(await run(),{exitCode});assert.equal(r.status,'candidates');assert.equal(r.process.exitCode,exitCode);assert.equal(r.failure,null);assert(r.envelope);});
test('controller retains nonzero structural review',async()=>{const r=inspect(await run([row({productname:'bad\ntext'})]),{exitCode:1});assert.equal(r.status,'structural-review');assert.equal(r.failure,null);});
for(const [name,data,expected] of [
 ['fixed operational error without envelope',{stdout:'{"status":"incomplete","code":"UPSTREAM_FAILED"}',exitCode:1},'INVALID_ENVELOPE'],
 ['exit zero malformed JSON',{stdout:'{',exitCode:0},'INVALID_ENVELOPE'],['nonzero malformed JSON',{stdout:'{',exitCode:1},'INVALID_ENVELOPE'],
 ['arbitrary secret-like stdout',{stdout:'Bearer '+CANARY,exitCode:1},'INVALID_ENVELOPE'],
 ['oversized stdout',{stdout:'x'.repeat(MAX_STREAM_BYTES+1),exitCode:0},'OUTPUT_LIMIT'],['oversized stderr',{stderr:'x'.repeat(MAX_STREAM_BYTES+1),exitCode:1},'OUTPUT_LIMIT'],
 ['timeout before output',{timedOut:true},'TIMEOUT'],['timeout after partial output',{stdout:'{"token":"'+CANARY,timedOut:true},'TIMEOUT'],
 ['signal termination',{signal:'SIGKILL'},'SIGNAL'],['no output',{exitCode:0},'NO_ENVELOPE'],
])test('controller fixed failure for '+name,()=>{const r=inspectProcessResult(data);assert.equal(r.failure,expected);assert.equal(r.envelope,null);safe(r);});
for(const suffix of ['\n{}','\n'+CANARY])test('controller rejects '+(suffix==='\n{}'?'multiple envelopes':'trailing output'),async()=>{
 const r=inspect(await run(),{stdout:JSON.stringify(await run())+suffix,exitCode:1});assert.equal(r.failure,'INVALID_ENVELOPE');assert.equal(r.envelope,null);safe(r);
});
test('arbitrary stderr alongside valid envelope is discarded',async()=>{const r=inspect(await run(),{stderr:'Bearer '+CANARY});assert.equal(r.failure,'UNEXPECTED_STDERR');assert.equal(r.envelope,null);safe(r);});
test('duplicate keys and unknown versions are rejected',async()=>{
 const v=await run();let r=inspect(v,{stdout:JSON.stringify(v).replace('"format":','"format":"unknown","format":')});assert.equal(r.failure,'INVALID_ENVELOPE');v.format='kk-unknown-v1';assert.equal(inspect(v).failure,'INVALID_ENVELOPE');
});
for(const structural of [false,true])test('forbidden '+(structural?'structural':'candidate')+' field is rejected',async()=>{
 const v=await run([row(structural?{productname:'bad\ntext'}:{})]);if(structural)v.review.diagnostics[0].token=CANARY;else v.review.productCandidates[0].orderlineid=CANARY;
 const r=inspect(v);assert.equal(r.failure,'INVALID_ENVELOPE');assert.equal(r.envelope,null);safe(r);
});
for(const [name,mutate] of [
 ['excessive entries',v=>{v.review.productCandidates=Array.from({length:13},(_,i)=>({...v.review.productCandidates[0],productId:'new-'+i}));}],
 ['excessive text',v=>{v.review.productCandidates[0].productLabel='x'.repeat(161);}],['terminal false',v=>{v.traversal.terminal=false;}],['terminal absent',v=>{delete v.traversal.terminal;}],
 ['unknown top-level fields',v=>{v.secret=CANARY;}],['missing tuple field',v=>{delete v.review.productCandidates[0].groupId;}],
])test('controller rejects '+name,async()=>{const v=await run();mutate(v);const r=inspect(v);assert.equal(r.failure,'INVALID_ENVELOPE');assert.equal(r.envelope,null);safe(r);});
for(const [name,fixture,exitCode] of [['success','candidate',0],['expected nonzero','structural',1],['operational failure','none',1]])test('atomic retention precedes cleanup after '+name,async()=>temp(async dir=>{
 const envelope=fixture==='candidate'?await run():fixture==='structural'?await run([row({productname:'bad\ntext'})]):null;
 const script='process.stdout.write('+JSON.stringify(envelope?JSON.stringify(envelope)+'\n':'Bearer '+CANARY)+');process.exitCode='+exitCode;
 const file=path.join(dir,'result.json');let cleaned=false;
 const r=await runAndRetain(process.execPath,['-e',script],{env:{},timeoutMs:5000},file,async()=>{const saved=JSON.parse(await fs.readFile(file,'utf8'));safe(saved);assert.equal(saved.process.exitCode,exitCode);cleaned=true;});
 assert(cleaned);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),r);assert.deepEqual(await fs.readdir(dir),['result.json']);assert.equal((await fs.stat(file)).mode&0o777,0o600);
}));
test('atomic replacement and invalid evidence preserve previous artifact',async()=>temp(async dir=>{
 const file=path.join(dir,'result.json'),r=inspect(await run());await persistEvidence(file,r);const before=await fs.readFile(file,'utf8');await assert.rejects(persistEvidence(file,{...r,raw:CANARY}));assert.equal(await fs.readFile(file,'utf8'),before);
 await persistEvidence(file,inspect(await run([row({productname:'bad\ntext'})]),{exitCode:1}));assert.deepEqual(await fs.readdir(dir),['result.json']);
}));
for(const stream of ['stdout','stderr'])test('actual '+stream+' overflow is killed and discarded',async()=>{
 const r=await captureProcess(process.execPath,['-e',`process.${stream}.write('x'.repeat(100000));setInterval(()=>{},1000);`],{env:{},timeoutMs:5000});assert.equal(r.failure,'OUTPUT_LIMIT');assert.equal(r.process.outputLimitExceeded,true);assert.equal(r.envelope,null);
});
for(const partial of [false,true])test('actual timeout '+(partial?'after partial output':'before output'),async()=>{
 const r=await captureProcess(process.execPath,['-e',(partial?"process.stdout.write('{');":"")+'setInterval(()=>{},1000);'],{env:{},timeoutMs:100});assert.equal(r.failure,'TIMEOUT');assert.equal(r.envelope,null);
});
test('actual signal and spawn failure stay fixed',async()=>{
 assert.equal((await captureProcess(process.execPath,['-e',"process.kill(process.pid,'SIGTERM');"],{env:{},timeoutMs:5000})).failure,'SIGNAL');
 assert.equal((await captureProcess('/definitely-not-a-diagnostic-binary',[],{env:{},timeoutMs:5000})).failure,'PROCESS_FAILURE');
});
async function cli(work){return temp(async dir=>{const file=path.join(dir,'baseline.json');await fs.writeFile(file,JSON.stringify(reviewed));return work(['--store',options.storeSlug,'--from',options.start,'--through',options.end,'--catalog',file,'--diagnose-catalog-review']);});}
test('CLI emits candidate, structural and operational versioned outcomes and expected exits',async()=>cli(async args=>{
 for(const [rows,expected,exit] of [[[row()],'candidates',0],[[row({productname:'customer:'+CANARY})],'structural-review',1],[null,'operational-failure',1]]) {
  const output=[];let calls=0;const code=await main(args,{KK_BACKFILL_COMPANY_ID:'12345'},s=>output.push(s),{request:async()=>{calls++;return rows?body(rows):'{';}});
  assert.equal(code,exit);assert.equal(calls,1);assert.equal(output.length,1);const r=JSON.parse(output[0]);validateEnvelope(r);assert.equal(r.outcome,expected);safe(r);
 }
}));
test('isolated CLI has no DB, identity, secret leakage or retry and one mocked request',async()=>cli(async args=>{
 const script=`const M=require('node:module'),load=M._load;M._load=function(id,...a){if(id==='pg'||/sales-db\\/(?:config|database|repository|identity|migrate)$|sales-sync\\/(?:importer|repository|owner|diagnostic)$/.test(id))throw Error('Forbidden module');return load.call(this,id,...a);};require('node:crypto').createHmac=()=>{throw Error('Forbidden identity');};const env=new Proxy({KK_BACKFILL_COMPANY_ID:'12345'},{get(t,k){if(!['KK_BACKFILL_COMPANY_ID','KK_BACKFILL_TOKEN'].includes(k))throw Error('Forbidden env');return t[k];}});let calls=0;require('./scripts/sales-backfill').main(${JSON.stringify(args)},env,undefined,{request:async()=>{if(++calls>1)throw Error('No retry');return ${JSON.stringify(body([row({productname:'customer:'+CANARY,orderlineid:CANARY})]))};}}).then(code=>{process.exitCode=code;});`;
 const p=spawnSync(process.execPath,['--require',path.resolve(__dirname,'network-guard.js'),'-e',script],{cwd:path.resolve(__dirname,'../..'),env:{},encoding:'utf8',timeout:10000,maxBuffer:MAX_STREAM_BYTES});assert.equal(p.status,1);assert.equal(p.stderr,'');assert(!p.stdout.includes(CANARY));assert.equal(JSON.parse(p.stdout).outcome,'structural-review');
}));
test('safe mode refuses every other mode before provider access',()=>{
 for(const flag of ['--apply','--dry-run','--validate','--diagnose-catalog','--export-catalog-review','--diagnose-catalog-text','--help'])assert.throws(()=>parseArgs(['--diagnose-catalog-review',flag]));
 for(const flag of ['--verify-run','--resume-publication'])assert.throws(()=>parseArgs(['--diagnose-catalog-review',flag,'test']));
});
test('valid safe envelope survives timeout or signal while admission remains failed',async()=>{
 for(const extra of [{timedOut:true},{signal:'SIGTERM'}]) {const r=inspect(await run(),extra);assert(r.envelope);assert.equal(r.status,'operational-failure');assert(r.failure);}
});
test('invalid UTF-8 cannot silently alter retained candidate text',async()=>{
 const r=await captureProcess(process.execPath,['-e','process.stdout.write(Buffer.from([255]));'],{env:{},timeoutMs:5000});assert.equal(r.failure,'INVALID_ENVELOPE');assert.equal(r.envelope,null);
});
test('tampered nested evidence is rejected before artifact replacement',async()=>temp(async dir=>{
 const r=inspect(await run());r.envelope.review.productCandidates[0].token=CANARY;await assert.rejects(persistEvidence(path.join(dir,'evidence.json'),r));assert.deepEqual(await fs.readdir(dir),[]);
}));
test('mixed declared-total presence is recorded and checked over the full traversal',async()=>{
 let calls=0;const r=await run(null,{request:async url=>{calls++;return body([row()],{current_page:calls,next_page_url:calls===1?url+'?page=2':null,...(calls===1?{total:2}:{})});}});assert.equal(r.traversal.declaredTotalPresence,'mixed');assert.equal(r.traversal.declaredTotalMatches,true);
});
test('bounded diagnostic memory over 100000 rows and 100 pages retains one tuple',async()=>{
 let calls=0,peak=0,early=0;const r=await run(null,{request:async url=>{
 calls++;const heap=process.memoryUsage().heapUsed;peak=Math.max(peak,heap);if(calls<=20)early=Math.max(early,heap);
 return body(Array.from({length:1000},()=>row()),{current_page:calls,next_page_url:calls<100?url.split('?')[0]+'?page='+(calls+1):null,total:100000});
 }});
 assert.equal(calls,100);assert.equal(r.traversal.rows,100000);assert.equal(r.review.productCandidates.length,1);assert.equal(r.review.productCandidates[0].affectedRows,100000);
 assert(Buffer.byteLength(JSON.stringify(r))<=MAX_OUTPUT_BYTES);assert(peak-early<96*1024*1024);
 console.log('Synthetic diagnostic memory result: '+JSON.stringify({rows:100000,pages:100,maxCandidateEntries:12,maxOutputBytes:MAX_OUTPUT_BYTES,earlyPeakHeapBytes:early,peakHeapBytes:peak}));
});

test('failed artifact retention does not clean up the diagnostic runtime',async()=>temp(async dir=>{
 const envelope=await run();let cleaned=false;
 await assert.rejects(runAndRetain(process.execPath,['-e','process.stdout.write('+JSON.stringify(JSON.stringify(envelope))+');'],
  {env:{},timeoutMs:5000},path.join(dir,'missing','result.json'),async()=>{cleaned=true;}));
 assert.equal(cleaned,false);
}));
