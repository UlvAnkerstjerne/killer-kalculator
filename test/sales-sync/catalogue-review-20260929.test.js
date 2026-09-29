'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createHash}=require('node:crypto');
const root=path.join(__dirname,'../..'),catalogue=require('../../catalogues/onlinepos-reviewed.json'),provenance=require('../../docs/onlinepos-catalogue-provenance.json'),proof=require('../../docs/catalogue-review-2026-09-29.json');
const {loadCatalog}=require('../../lib/sales-worker/catalog'),{storeId}=require('../../lib/sales-db/values'),metrics=require('../../lib/product-metrics'),{metricCoverage}=require('../../lib/sales-metric-coverage');
const F=['storeSlug','productId','productLabel','groupId','groupLabel'],key=p=>JSON.stringify(F.map(k=>p[k])),sha=x=>createHash('sha256').update(x).digest('hex'),sort=a=>[...a].sort((x,y)=>key(x)<key(y)?-1:key(x)>key(y)?1:0);
const added=proof.products.map(e=>catalogue.products.find(p=>p.storeSlug===e.store&&p.productId===e.productId));
test('review bundle preserves all 425 earlier products and all nine payments exactly',()=>{
 assert.equal(proof.approved,134);assert.equal(proof.isolated,21);assert.equal(added.length,134);assert(added.every(Boolean));
 const prior=catalogue.products.filter(p=>!added.includes(p));assert.equal(prior.length,425);assert.equal(sha(JSON.stringify(sort(prior).map(p=>F.map(k=>p[k])))),proof.previousProductsSha256);
 assert.equal(catalogue.payments.length,9);assert.equal(provenance.paymentsSha256,proof.previousPaymentsSha256);
 assert.equal(sha(fs.readFileSync(root+'/docs/catalogue-review-2026-09-29.json')),provenance.productReview20260929.sha256);
 assert(fs.statSync(root+'/docs/onlinepos-catalogue-provenance.json').size<128*1024);
});
test('each admitted exact tuple loads and altered identity, label and group are rejected',()=>{
 const catalog=loadCatalog();
 for(let i=0;i<added.length;i++){const p=added[i];assert.equal(sha(key(p)),proof.products[i].tupleSha256);
 const line={...p,storeId:storeId(p.storeSlug),...catalogue.payments[0]};catalog.validate(line);
 for(const field of F.filter(k=>k!=='storeSlug'))assert.throws(()=>catalog.validate({...line,[field]:(p[field]??'')+' synthetic alteration'}),{code:'UNREVIEWED_CATALOG'});
 }
});
test('admitted values preserve UTF-8, JSON and the actual escaped UI renderer',()=>{
 const source=fs.readFileSync(root+'/index.html','utf8').match(/function escHtml\(str\) \{[\s\S]*?\n\}/)[0],escape=vm.runInNewContext('('+source+')');
 for(const p of added)for(const v of Object.values(p)){if(v===null)continue;assert(Buffer.from(v).equals(Buffer.from(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(v)))));assert.equal(JSON.parse(JSON.stringify(v)),v);
 const rendered=escape(v);assert(!/[<>]/.test(rendered));assert.equal(rendered.replace(/&gt;/g,'>').replace(/&lt;/g,'<').replace(/&amp;/g,'&'),v);}
});
test('new products remain unclassified and warn about all affected product metrics',()=>{
 for(const p of added){assert.equal(metrics.ALL_KNOWN_IDS.has(p.productId),false);const lines=[{productid:p.productId,count:1,price:100,priceexclvat:80}];assert.deepEqual(metrics.computeMetrics(lines),metrics.computeMetrics([]));
 const warning=metricCoverage(lines,p.storeSlug);assert.equal(warning.productCountsComplete,false);assert.equal(warning.catalogueReviewCurrent,true);assert.deepEqual(warning.potentiallyIncomplete,['rolls','combos','combo-percent','protein-breakdown','lemonade']);assert.equal(warning.revenueIncludesUnclassified,true);assert.equal(warning.channelRulesUnchanged,true);}
});
