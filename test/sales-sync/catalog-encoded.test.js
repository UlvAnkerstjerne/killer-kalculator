'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {diagnoseEncodedCatalog,decodeReview,validateEnvelope,MAX_CANDIDATES,MAX_OUTPUT_BYTES}=require('../../lib/sales-sync/catalog-encoded');
const {inspectProcessResult,captureProcess,runAndRetain,persistEvidence}=require('../../lib/sales-sync/diagnostic-process');
const {createReviewedCatalog}=require('../../lib/sales-db/facts');
const {main,parseArgs}=require('../../scripts/sales-backfill');
const options={storeSlug:'norrebro',companyId:'12345',start:'2025-01-01',end:'2025-01-02'};
const reviewed={products:[],payments:[{paymentType:'Synthetic payment',paymentCode:'mixed 1'}]};
const row=(extra={})=>({firmaid:'12345',timestamp_pay:options.start,productid:'synthetic-product',productname:'Synthetic label ',productgroupid:'synthetic-group',productgroup:'Synthetic group',paymenttype:'Synthetic payment',paymenttypecode:'mixed 1',...extra});
const body=(data,extra={})=>JSON.stringify({data,current_page:1,next_page_url:null,...extra});
const run=(rows=[row()],extra={})=>diagnoseEncodedCatalog({reviewed,options,request:async()=>body(rows),...extra});
const CANARY=['SYNTHETIC','PRIVATE','IMPORTER','CANARY'].join('_');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const inspect=(v,extra={})=>inspectProcessResult({stdout:JSON.stringify(v)+'\n',exitCode:0,...extra});
async function temp(work){const d=await fs.mkdtemp(path.join(os.tmpdir(),'kk-encoded-test-'));try{return await work(d);}finally{await fs.rm(d,{recursive:true,force:true});}}
const texts=['Ordinary product','pipe | and ``` fences','<script>synthetic()</script>','=SUM(A1)','+demo()',`quotes ' " backslash \\`,'Kebab 🥙 æ ø å','e\u0301','  label  ','','line\u2028separator','dash\u2029separator'];
for(const [i,text] of texts.entries())test('encoded exact UTF-8 round trip fixture '+i,async()=>{
 const r=await run([row({productname:text})]);assert.equal(r.outcome,'candidates');const d=decodeReview(r);assert(Buffer.from(d.products[0].productLabel).equals(Buffer.from(text)));
 const f=r.review.products[0].fields.productLabel;assert.equal(f.sha256,digest(Buffer.from(text)));assert.equal(f.byteLength,Buffer.byteLength(text));assert.equal(f.codePointLength,[...text].length);
 assert(!JSON.stringify(r).includes('<script>'));assert.throws(()=>createReviewedCatalog(r));
});
for(const [name,text] of [['ansi','a\u001b[31m'],['newline','a\nb'],['carriage','a\rb'],['tab','a\tb'],['blank','  '],['nul','a\0b'],['surrogate','a\ud800'],['oversize','x'.repeat(161)],['bytes','🥙'.repeat(81)],['format','a\u200db'],['sensitive','customer:'+CANARY],['quoted-provider-field','"orderid": example'],['quoted-personal-field','"customer":'+CANARY],['quoted-secret-field','"token":'+CANARY],['compatibility-provider-field','"ｃｕｓｔｏｍｅｒ":'+CANARY]])test('encoded refusal '+name+' cannot retain rejected bytes',async()=>{
 const r=await run([row({productname:text})]);assert(['structural-review','operational-failure'].includes(r.outcome));assert(!JSON.stringify(r).includes(CANARY));assert(!JSON.stringify(r).includes(Buffer.from(text).toString('base64url')));assert.equal(r.review?.products.length||0,0);
});
test('candidate duplicates aggregate occurrences; multiple tuples remain distinct',async()=>{
 const r=await run([row(),row(),row({productid:'other',productname:'Other'})]);assert.equal(r.review.products.length,2);assert.deepEqual(r.review.products.map(p=>p.occurrences).sort(),[1,2]);assert.equal(r.traversal.inRangeRows,3);
});
test('historical candidate bound permits 512, refuses 513 without truncating traversal',async()=>{
 for(const n of [MAX_CANDIDATES,MAX_CANDIDATES+1]){const r=await run(Array.from({length:n},(_,i)=>row({productid:'product-'+i})));assert.equal(r.traversal.rows,n);assert(r.traversal.terminal);assert.equal(r.outcome,n===MAX_CANDIDATES?'candidates':'structural-review');assert.equal(r.review.candidateOverflow,n>MAX_CANDIDATES);assert(Buffer.byteLength(JSON.stringify(r))<=MAX_OUTPUT_BYTES);}
});
test('identifier and group collisions refuse all candidate output',async()=>{
 for(const second of [{productname:'Changed'},{productid:'different',productgroup:'Changed group'}]){const r=await run([row(),row(second)]);assert.equal(r.outcome,'structural-review');assert(r.review.identifierCollision);assert.deepEqual(r.review.products,[]);}
});
test('payment candidates stay separate and never acquire product approval',async()=>{const r=await run([row({paymenttype:'New tender'})]);assert.equal(r.review.payments.length,1);assert.equal(decodeReview(r).payments[0].paymentType,'New tender');assert.equal(r.approvalRequired,true);});
test('strict date filter, multi-page terminal and declared total validation',async()=>{
 let calls=0;const r=await run(null,{request:async url=>body([row({timestamp_pay:++calls===1?options.end:options.start})],{current_page:calls,next_page_url:calls===1?url+'?page=2':null,total:2})});assert.equal(calls,2);assert.equal(r.traversal.rows,2);assert.equal(r.traversal.inRangeRows,1);assert(r.traversal.terminal);assert(r.traversal.declaredTotalMatches);
});
for(const [name,request] of [['total mismatch',async()=>body([row()],{total:2})],['missing terminal',async()=>JSON.stringify({data:[row()],current_page:1})],['raw exception',async()=>{throw Error(CANARY);}]])test('no encoded candidates after '+name,async()=>{let calls=0;const r=await run(null,{request:async()=>{calls++;return request();}});assert.equal(calls,1);assert.equal(r.outcome,'operational-failure');assert.equal(r.review,null);assert(!JSON.stringify(r).includes(CANARY));});
const mutations=[['malformed base64',r=>r.review.products[0].fields.productLabel.data+='='],['bad byte length',r=>r.review.products[0].fields.productLabel.byteLength++],['bad digest',r=>r.review.products[0].fields.productLabel.sha256='0'.repeat(64)],['unknown role',r=>r.review.products[0].fields.productLabel.role='token'],['wrong category',r=>r.review.products[0].fields.productLabel.category='other'],['excessive envelope',r=>r.extra='x'.repeat(MAX_OUTPUT_BYTES)],['duplicate tuple',r=>{r.review.products.push(r.review.products[0]);r.traversal.rows=r.traversal.inRangeRows=2;}],['candidate count',r=>r.review.products=Array(MAX_CANDIDATES+1).fill(r.review.products[0])],['forbidden provider field',r=>r.review.products[0].orderlineid=CANARY],['incorrect code points',r=>r.review.products[0].fields.productLabel.codePointLength++],['invalid UTF8',r=>{const f=r.review.products[0].fields.productLabel,b=Buffer.from([255]);Object.assign(f,{data:b.toString('base64url'),byteLength:1,codePointLength:1,sha256:digest(b)});}]];
for(const [name,mutate] of mutations)test('strict decoder rejects '+name+' with fixed error',async()=>{const r=await run();mutate(r);assert.throws(()=>validateEnvelope(r),{message:'INVALID_ENCODED_REVIEW'});assert.equal(inspect(r).envelope,null);});
test('encoded privacy canaries never enter transport, including encoding of raw noncatalogue fields',async()=>{
 const r=await run([row({customer:CANARY,card:CANARY,clerk:CANARY,orderlineid:CANARY,sourceKey:CANARY,headers:{token:CANARY},responseBody:CANARY})]);const text=JSON.stringify(r);assert(!text.includes(CANARY));assert(!text.includes(Buffer.from(CANARY).toString('base64url')));assert.equal(r.outcome,'candidates');
});
for(const suffix of ['\n{}','\ntrailing'])test('encoded controller rejects multiple or trailing output '+suffix.length,async()=>{const r=inspect(await run(),{stdout:JSON.stringify(await run())+suffix});assert.equal(r.envelope,null);assert.equal(r.failure,'INVALID_ENVELOPE');});
test('encoded stderr is separate, rejected and never persisted',async()=>{const r=inspect(await run(),{stderr:CANARY});assert.equal(r.failure,'UNEXPECTED_STDERR');assert.equal(r.envelope,null);});
for(const exit of [0,1])test('encoded atomic retention before cleanup with exit '+exit,async()=>temp(async d=>{
 const envelope=await run([row({productname:'<b>inert</b>'})]),file=path.join(d,'evidence.json');let cleaned=false;
 const r=await runAndRetain(process.execPath,['-e','process.stdout.write('+JSON.stringify(JSON.stringify(envelope))+');process.exitCode='+exit],{env:{},timeoutMs:5000},file,async()=>{assert.equal(JSON.parse(await fs.readFile(file)).envelope.format,envelope.format);cleaned=true;});assert(cleaned);assert.equal(r.process.exitCode,exit);assert.equal(r.status,'candidates');assert.deepEqual(await fs.readdir(d),['evidence.json']);assert.equal((await fs.stat(file)).mode&0o777,0o600);
}));
test('encoded operational failure retains only fixed evidence and then cleans',async()=>temp(async d=>{
 let cleaned=false;const r=await runAndRetain(process.execPath,['-e','process.stderr.write('+JSON.stringify(CANARY)+');process.exitCode=1'],{env:{},timeoutMs:5000},path.join(d,'evidence.json'),async()=>{cleaned=true;});assert(cleaned);assert(!JSON.stringify(r).includes(CANARY));assert.equal(r.envelope,null);
}));
test('encoded timeout and signal preserve complete safe envelope but fail operation',async()=>{for(const extra of [{timedOut:true},{signal:'SIGTERM'}]){const r=inspect(await run(),extra);assert(r.envelope);assert.equal(r.status,'operational-failure');assert(r.failure);}});
test('encoded retention failure never cleans runtime',async()=>temp(async d=>{let cleaned=false;const r=await run();await assert.rejects(runAndRetain(process.execPath,['-e','process.stdout.write('+JSON.stringify(JSON.stringify(r))+')'],{env:{},timeoutMs:5000},path.join(d,'missing','out'),async()=>{cleaned=true;}));assert(!cleaned);}));
test('encoded mode rejects all other modes',()=>{for(const flag of ['--apply','--dry-run','--validate','--diagnose-catalog','--export-catalog-review','--diagnose-catalog-text','--diagnose-catalog-review','--help'])assert.throws(()=>parseArgs(['--diagnose-catalog-encoded',flag]));});
test('encoded CLI has no DB, identity, writes, unrelated network or ambient credential access',async()=>temp(async d=>{
 const file=path.join(d,'catalog.json');await fs.writeFile(file,JSON.stringify(reviewed));const args=['--store',options.storeSlug,'--from',options.start,'--through',options.end,'--catalog',file,'--diagnose-catalog-encoded'];
 const script=`const M=require('node:module'),load=M._load;M._load=function(id,...a){if(id==='pg'||/sales-db\\/(?:config|database|repository|identity|migrate)$|sales-sync\\/(?:importer|repository|owner)$/.test(id))throw Error('Forbidden module');return load.call(this,id,...a);};require('node:crypto').createHmac=()=>{throw Error('Forbidden identity');};const fs=require('node:fs');for(const key of ['writeFile','writeFileSync','appendFile','appendFileSync','rename','renameSync','createWriteStream'])fs[key]=()=>{throw Error('Forbidden write');};for(const key of ['writeFile','appendFile','rename'])fs.promises[key]=()=>{throw Error('Forbidden write');};const env=new Proxy({KK_BACKFILL_COMPANY_ID:'12345'},{get(t,k){if(!['KK_BACKFILL_COMPANY_ID','KK_BACKFILL_TOKEN'].includes(k))throw Error('Forbidden env');return t[k];}});let calls=0;require('./scripts/sales-backfill').main(${JSON.stringify(args)},env,undefined,{request:async()=>{if(++calls>1)throw Error('No retry');return ${JSON.stringify(body([row({productname:'<b>inert</b>',customer:CANARY})]))};}}).then(code=>{process.exitCode=code;});`;
 const p=spawnSync(process.execPath,['--require',path.resolve(__dirname,'network-guard.js'),'-e',script],{cwd:path.resolve(__dirname,'../..'),env:{},encoding:'utf8',timeout:10000});assert.equal(p.status,0);assert.equal(p.stderr,'');assert(!p.stdout.includes(CANARY));assert.equal(JSON.parse(p.stdout).outcome,'candidates');
}));
test('encoded collector bounded memory over 100000 rows and 100 pages',async()=>{
 let calls=0,peak=0,early=0;const r=await run(null,{request:async url=>{calls++;const heap=process.memoryUsage().heapUsed;peak=Math.max(peak,heap);if(calls<=20)early=Math.max(early,heap);return body(Array.from({length:1000},()=>row()),{current_page:calls,next_page_url:calls<100?url.split('?')[0]+'?page='+(calls+1):null,total:100000});}});assert.equal(r.review.products.length,1);assert.equal(r.review.products[0].occurrences,100000);assert.equal(r.traversal.rows,100000);assert(peak-early<96*1024*1024);console.log('Synthetic encoded memory result: '+JSON.stringify({rows:100000,pages:100,maxCandidates:MAX_CANDIDATES,maxOutputBytes:MAX_OUTPUT_BYTES,earlyHeap:early,peakHeap:peak}));
});

test('rendering metadata distinguishes reviewed and novel tuple occurrences without decoded text',async()=>{
 const product={storeSlug:options.storeSlug,productId:'synthetic-product',productLabel:'<b>known</b>',groupId:'synthetic-group',groupLabel:'Synthetic group'};
 const r=await run([row({productname:product.productLabel}),row({productname:product.productLabel}),row({productid:'new',productname:'=new'})],{reviewed:{...reviewed,products:[product]}});
 assert.equal(r.review.products.length,1);assert.equal(r.review.renderingFields.length,2);assert.deepEqual(r.review.renderingFields.map(f=>f.occurrences).sort(),[1,2]);assert.deepEqual(r.review.renderingFields.map(f=>f.catalogueStatus).sort(),['reviewed','unreviewed']);assert(!JSON.stringify(r).includes('<b>known</b>'));
});

test('larger historical envelope still refuses every candidate when protected text occurs late',async()=>{
 const rows=Array.from({length:100},(_,i)=>row({productid:'history-'+i}));rows.push(row({productid:'late-refusal',productname:'customer:'+CANARY}));const r=await run(rows);assert.equal(r.outcome,'structural-review');assert.equal(r.review.products.length,0);assert(!JSON.stringify(r).includes(CANARY));assert.equal(r.review.refusals[0].reason,'SENSITIVE_PATTERN');
});
test('historical capacity covers maximum UTF-8 field lengths and strict subprocess retention',async()=>{
 const label='ø'.repeat(160);const rows=Array.from({length:MAX_CANDIDATES},(_,i)=>row({productid:'history-'+i,productname:label,productgroup:label}));const r=await run(rows);assert.equal(r.outcome,'candidates');assert.equal(decodeReview(r).products.length,MAX_CANDIDATES);assert(Buffer.byteLength(JSON.stringify(r))<MAX_OUTPUT_BYTES);assert.equal(inspect(r).envelope.review.products.length,MAX_CANDIDATES);
});
