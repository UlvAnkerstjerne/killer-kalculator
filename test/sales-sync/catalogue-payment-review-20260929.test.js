'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createHash}=require('node:crypto');
const root=path.join(__dirname,'../..'),catalogue=require('../../catalogues/onlinepos-reviewed.json'),proof=require('../../docs/catalogue-payment-review-2026-09-29.json'),provenance=require('../../docs/onlinepos-catalogue-provenance.json');
const {loadCatalog}=require('../../lib/sales-worker/catalog'),{storeId,STORES}=require('../../lib/sales-db/values'),{normalizeLine}=require('../../lib/sales-sync/normalize'),{identity}=require('../sales-db/helpers'),{raw,options}=require('./helpers');
const metrics=require('../../lib/product-metrics'),{metricCoverage}=require('../../lib/sales-metric-coverage');
const F=['storeSlug','productId','productLabel','groupId','groupLabel'],P=['paymentType','paymentCode'],key=(p,f)=>JSON.stringify(f.map(k=>p[k])),sha=x=>createHash('sha256').update(x).digest('hex'),digest=(a,f)=>sha(JSON.stringify([...a].sort((x,y)=>key(x,f)<key(y,f)?-1:key(x,f)>key(y,f)?1:0).map(p=>f.map(k=>p[k]))));
const added=proof.products.map(e=>catalogue.products.find(p=>p.storeSlug===e.store&&p.productId===e.productId));
const payments=[{paymentType:'Gavekort',paymentCode:'mixed 25'},{paymentType:'LifePeaks',paymentCode:'mixed 68'}];
test('private review admits 21 exact products and two explicitly unattributed payments while preserving prior tuples',()=>{
 assert.equal(proof.approved,21);assert.equal(proof.protectedAdmitted,0);assert.equal(proof.isolatedFromRetainedSet,0);assert(added.every(Boolean));
 const prior=catalogue.products.filter(p=>!added.includes(p));assert.equal(prior.length,559);assert.equal(digest(prior,F),proof.previousProductsSha256);
 const oldPayments=catalogue.payments.filter(p=>!payments.some(x=>key(x,P)===key(p,P)));assert.equal(oldPayments.length,9);assert.equal(digest(oldPayments,P),proof.previousPaymentsSha256);
 assert.deepEqual(proof.payments,payments.map(p=>({...p,treatment:'explicitly-unattributed'})));
 assert.equal(sha(fs.readFileSync(root+'/docs/catalogue-payment-review-2026-09-29.json')),provenance.productPaymentReview20260929.sha256);
});
test('exact product admission preserves UTF-8, JSON and escaped UI text and rejects mutations',()=>{
 const c=loadCatalog(),html=fs.readFileSync(root+'/index.html','utf8'),escape=vm.runInNewContext('('+html.match(/function escHtml\(str\) \{[\s\S]*?\n\}/)[0]+')');
 for(let i=0;i<added.length;i++){const p=added[i];assert.equal(sha(key(p,F)),proof.products[i].tupleSha256);const line={...p,storeId:storeId(p.storeSlug),...payments[0]};c.validate(line);
 for(const f of F.filter(f=>f!=='storeSlug')){assert.throws(()=>c.validate({...line,[f]:(p[f]??'')+' synthetic alteration'}),{code:'UNREVIEWED_CATALOG'});if(p[f]!==null){assert.equal(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(p[f])),p[f]);assert.equal(JSON.parse(JSON.stringify(p[f])),p[f]);const rendered=escape(p[f]);assert(!/[<>]/.test(rendered));assert.equal(rendered.replace(/&gt;/g,'>').replace(/&lt;/g,'<').replace(/&amp;/g,'&'),p[f]);}}
 }
});
test('new products stay unclassified with explicit metric incompleteness warnings',()=>{
 for(const p of added){assert.equal(metrics.ALL_KNOWN_IDS.has(p.productId),false);const lines=[{productid:p.productId,count:1,price:100,priceexclvat:80}];assert.deepEqual(metrics.computeMetrics(lines),metrics.computeMetrics([]));const warning=metricCoverage(lines,p.storeSlug);assert.equal(warning.productCountsComplete,false);assert.equal(warning.catalogueReviewCurrent,true);assert.deepEqual(warning.potentiallyIncomplete,['rolls','combos','combo-percent','protein-breakdown','lemonade']);assert.equal(warning.revenueIncludesUnclassified,true);}
});
test('only the two exact payment tuples are accepted; code swaps, label alterations and near matches quarantine',()=>{
 const catalog=loadCatalog();
 for(const store of STORES){const p=catalogue.products.find(p=>p.storeSlug===store),base=raw({productid:p.productId,productname:p.productLabel,productgroupid:p.groupId,productgroup:p.groupLabel});
 for(const payment of payments){const row={...base,paymenttype:payment.paymentType,paymenttypecode:payment.paymentCode},ctx={...options,storeSlug:store,context:{identity,catalog}};normalizeLine(row,ctx);
 const labels=[payment.paymentType+' ',payment.paymentType.toLowerCase(),payment.paymentType+'x','Wolt','Betalingskort'];const codes=[payment.paymentCode+' ',payment.paymentCode.replace(' ','  '),payment.paymentCode.replace('mixed','Mixed'),payment.paymentCode==='mixed 25'?'mixed 68':'mixed 25','mixed 3',null];
 for(const paymenttype of labels)assert.throws(()=>normalizeLine({...row,paymenttype},ctx),{code:'CATALOG_REVIEW'});
 for(const paymenttypecode of codes)assert.throws(()=>normalizeLine({...row,paymenttypecode},ctx),{code:'CATALOG_REVIEW'});
 assert.equal(catalogue.payments.filter(p=>p.paymentCode===payment.paymentCode).length,1);assert.equal(catalogue.payments.filter(p=>p.paymentType===payment.paymentType).length,1);
 }}
});
test('approved payments enter overall revenue but no attributed channel KPI in the actual UI functions',()=>{
 const html=fs.readFileSync(root+'/index.html','utf8'),mapping=html.match(/^const WOLT_VIA_HEAPS = \{[^]*?^};/m),channel=html.match(/^function lineChannel\([^]*?^}/m),kpis=html.match(/^function buildChannelKpis\([^]*?^}/m);assert(mapping&&channel&&kpis);
 const actual=vm.runInNewContext(mapping[0]+'\n'+channel[0]+'\n'+kpis[0]+'\n({lineChannel,buildChannelKpis})');
 for(const store of STORES){for(const p of payments)assert.equal(actual.lineChannel(p.paymentType,store),null);
 const rows=payments.map(p=>({paymenttype:p.paymentType,paymenttypecode:p.paymentCode,priceexclvat:80}));const result=JSON.parse(JSON.stringify(actual.buildChannelKpis(rows,store)));assert.deepEqual(result,{total:160,wolt:0,uberEats:0,heaps:0});
 const combined=JSON.parse(JSON.stringify(actual.buildChannelKpis([...rows,{paymenttype:'Wolt',priceexclvat:20}],store)));assert.deepEqual(combined,{total:180,wolt:20,uberEats:0,heaps:0});}
});
