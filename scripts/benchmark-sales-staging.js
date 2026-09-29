'use strict';
// Synthetic/offline PostgreSQL benchmark; refuses a non-disposable database.
const assert=require('node:assert/strict');
const {disposableConfig}=require('../test/sales-sync/disposable');
const {context,options,raw,provider}=require('../test/sales-sync/helpers');
const {createDatabase}=require('../lib/sales-db/database'),{migrate}=require('../lib/sales-db/migrate');
const {importHistory}=require('../lib/sales-sync/importer');
async function benchmark(batchSize) {
 assert([250,500].includes(batchSize));const config=disposableConfig(),db=createDatabase(config);
 try{
 await db.query('DROP SCHEMA IF EXISTS sales_foundation CASCADE');await migrate(db);
 const pages=Array.from({length:8},(_,p)=>Array.from({length:1000},(_,i)=>raw({orderlineid:'synthetic-bench-'+(p*1000+i),price:'10.123456789012345678',priceexclvat:'8.000000000000000001',count:'0.125'})));
 const mock=provider(pages);const started=performance.now();
 const r=await importHistory({config,context,options,apply:true,request:mock.request,limits:{batchSize}});
 const elapsedMs=Math.round(performance.now()-started);
 assert.equal(r.lineCount,8000);assert.equal(r.revenueIncl,'80987.654312098765424');assert.equal(r.revenueExcl,'64000.000000000000008');
 assert.equal((await db.query('SELECT count(*)::int n FROM sales_foundation.sales_stage_line')).rows[0].n,0);
 return {batchSize,rows:r.lineCount,requests:mock.calls.length,stagingTransactions:8000/batchSize,elapsedMs,peakRssBytes:process.resourceUsage().maxRSS*1024,precisionAndReconciliation:true};
 }finally{await db.close();}
}
if(require.main===module)benchmark(Number(process.argv[2])).then(x=>console.log(JSON.stringify(x))).catch(()=>{console.log('{"code":"SYNTHETIC_BENCHMARK_FAILED"}');process.exitCode=1;});
module.exports={benchmark};
