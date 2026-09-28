'use strict';
// Review transport only. Encoding never establishes catalogue trust.
const {createHash}=require('node:crypto');
const {createReviewedCatalog}=require('../sales-db/facts');
const {storeId}=require('../sales-db/values');
const {reviewText,reviewProductLabel,inspectText}=require('./catalog-text');
const {validateOptions}=require('./options');
const {parseLossless}=require('./parse');
const {traverse}=require('./traverse');
const {validateEnvelope:validateLegacy}=require('./catalog-diagnostic');
const {safeError,fail,checkSignal}=require('./errors');
// Historical traversals can contain more novel business tuples than one day.
// Retain a finite review envelope; privacy/collision/terminal gates are unchanged.
const FORMAT='kk-catalog-encoded-v1', MAX_OUTPUT_BYTES=2*1024*1024, MAX_CANDIDATES=512;
const FIELDS=[['productid','productId','product','product-id','id',false],
 ['productname','productLabel','product','product-label','label',false],
 ['productgroupid','groupId','product','product-group-id','id',true],
 ['productgroup','groupLabel','product','product-group-label','label',true],
 ['paymenttype','paymentType','payment','payment-type','label',false],
 ['paymenttypecode','paymentCode','payment','payment-type-code','code',true]];
const REASONS=new Set(['UNSUPPORTED_TYPE','EMPTY_TEXT','LENGTH_LIMIT','FORBIDDEN_LINE_BREAK','ANSI_ESCAPE',
 'CONTROL_CHARACTER','BIDI_FORMATTING','FORMAT_CONTROL','SENSITIVE_PATTERN','INVALID_IDENTIFIER','INVALID_PAYMENT_CODE',
 'INVALID_UNICODE','UTF8_BYTE_LIMIT']);
const check=v=>{if(!v)throw Error('INVALID_ENCODED_REVIEW');};
const keys=(v,ks)=>check(v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k)));
const count=(n,max=20000000)=>check(Number.isSafeInteger(n)&&n>=0&&n<=max);
const sha=b=>createHash('sha256').update(b).digest('hex');
const tuple=(v,kind)=>JSON.stringify(FIELDS.filter(f=>f[2]===kind).map(f=>v[f[1]]));
function reason(value,field){
 if(field[5]&&value===null)return null;
 if(field[1]==='productLabel'&&value==='')return null;
 // Quoted provider-field shapes may conceal personal data or source IDs.
 // They remain a privacy refusal even when terminal rendering is encoded.
 if(typeof value==='string'&&/["'](?:order(?:line)?(?:id)?|transaction(?:id)?|customer|debtor|clerk|employee|cashier|card(?:number)?|phone|mobile|e-?mail|name|contact|kunde|kundenavn|navn|medarbejder|telefon|cpr|adresse|address|iban|password|secret|token|api[_ -]?key|authorization|headers|identityKey|sourceKey|fingerprint)["']\s*:/i.test(value.normalize('NFKC')))return 'SENSITIVE_PATTERN';
 const issue=inspectText(value,field[4]);
 if(issue&&issue.reason!=='UNSAFE_OUTPUT_SEQUENCE')return issue.reason;
 try{field[1]==='productLabel'?reviewProductLabel(value):reviewText(value,field[4]);}catch{return 'EMPTY_TEXT';}
 return null;
}
function category(value,field){return value===''?'empty':inspectText(value,field[4])?'rendering-sensitive':'ordinary';}
function encode(value,field){
 if(value===null)return null;
 const bytes=Buffer.from(value,'utf8');
 return {role:field[3],encoding:'base64url',data:bytes.toString('base64url'),byteLength:bytes.length,
  codePointLength:[...value].length,sha256:sha(bytes),category:category(value,field)};
}
// The sole decoding boundary validates canonical bytes before returning text.
function decode(value,field){
 if(field[5]&&value===null)return null;
 keys(value,['role','encoding','data','byteLength','codePointLength','sha256','category']);
 check(value.role===field[3]&&value.encoding==='base64url');
 check(typeof value.data==='string'&&/^[A-Za-z0-9_-]*$/.test(value.data)&&value.data.length<=427);
 count(value.byteLength,field[4]==='label'?320:64);count(value.codePointLength,160);
 check(typeof value.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.sha256));
 const bytes=Buffer.from(value.data,'base64url');
 check(bytes.toString('base64url')===value.data&&bytes.length===value.byteLength&&sha(bytes)===value.sha256);
 let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw Error('INVALID_ENCODED_REVIEW');}
 check(Buffer.from(text,'utf8').equals(bytes)&&[...text].length===value.codePointLength);
 check(reason(text,field)===null&&category(text,field)===value.category);
 return text;
}
function base(r){return {...r,format:'kk-catalog-diagnostic-v1',review:r.outcome==='operational-failure'?null:{productCandidates:[],paymentCandidates:[]},
 outcome:r.outcome==='operational-failure'?'operational-failure':'completed',code:r.outcome==='operational-failure'?r.code:null};}
function decodeReview(r){
 try{
  keys(r,['format','outcome','code','approvalRequired','store','start','end','timezone','traversal','review']);check(r.format===FORMAT);
  check(Buffer.byteLength(JSON.stringify(r))<=MAX_OUTPUT_BYTES);validateLegacy(base(r));
  if(r.outcome==='operational-failure'){check(r.review===null);return null;}
  check(['completed','candidates','structural-review'].includes(r.outcome));
  const v=r.review;keys(v,['products','payments','renderingFields','renderingOverflow','refusals','omittedRefusals','candidateOverflow','identifierCollision']);
  count(v.omittedRefusals,120000000);check(typeof v.candidateOverflow==='boolean'&&typeof v.identifierCollision==='boolean');
  check(Array.isArray(v.refusals)&&v.refusals.length<=12);const signatures=new Set();let refused=0;
  for(const f of v.refusals){keys(f,['kind','role','reason','occurrences']);check(FIELDS.some(x=>x[2]===f.kind&&x[3]===f.role)&&REASONS.has(f.reason));count(f.occurrences);check(f.occurrences>0);refused+=f.occurrences;const k=JSON.stringify([f.kind,f.role,f.reason]);check(!signatures.has(k));signatures.add(k);}
  check(refused+v.omittedRefusals<=6*r.traversal.inRangeRows);
  check(Array.isArray(v.renderingFields)&&v.renderingFields.length<=64&&typeof v.renderingOverflow==='boolean');
  const renderingSeen=new Set();let renderingOccurrences=0;
  for(const f of v.renderingFields){keys(f,['kind','role','tupleSha256','fieldSha256','byteLength','codePointLength','catalogueStatus','occurrences']);
   check(FIELDS.some(x=>x[2]===f.kind&&x[3]===f.role));check(/^[a-f0-9]{64}$/.test(f.tupleSha256)&&/^[a-f0-9]{64}$/.test(f.fieldSha256));
   check(['reviewed','unreviewed'].includes(f.catalogueStatus));count(f.byteLength,320);count(f.codePointLength,160);count(f.occurrences);check(f.occurrences>0);renderingOccurrences+=f.occurrences;
   const k=JSON.stringify([f.kind,f.role,f.tupleSha256,f.fieldSha256]);check(!renderingSeen.has(k));renderingSeen.add(k);
  }check(renderingOccurrences<=6*r.traversal.inRangeRows);
  const decoded={products:[],payments:[]},identities=new Map(),groups=new Map();let n=0;
  for(const kind of ['product','payment']){
   const list=v[kind+'s'];check(Array.isArray(list)&&list.length<=MAX_CANDIDATES);n+=list.length;let occurrences=0;const seen=new Set();
   for(const entry of list){keys(entry,['kind','store','occurrences','fields']);check(entry.kind===kind&&entry.store===r.store);count(entry.occurrences);check(entry.occurrences>0);occurrences+=entry.occurrences;
    const fields=FIELDS.filter(f=>f[2]===kind);keys(entry.fields,fields.map(f=>f[1]));
    const result=Object.fromEntries(fields.map(f=>[f[1],decode(entry.fields[f[1]],f)]));
    const k=tuple(result,kind);check(!seen.has(k));seen.add(k);
    if(kind==='product'){
     check(!identities.has(result.productId));identities.set(result.productId,k);
     if(result.groupId!==null){check(!groups.has(result.groupId)||groups.get(result.groupId)===result.groupLabel);groups.set(result.groupId,result.groupLabel);}
     result.storeSlug=r.store;
    }
    decoded[kind+'s'].push(result);
   }
   check(occurrences<=r.traversal.inRangeRows);
  }
  check(n<=MAX_CANDIDATES);
  const structural=refused>0||v.omittedRefusals>0||v.candidateOverflow||v.identifierCollision||v.renderingOverflow;
  check(r.outcome===(structural?'structural-review':n?'candidates':'completed'));
  check(r.code===(structural?'CATALOG_TEXT_REVIEW':null));if(structural)check(n===0);
  return decoded;
 }catch{throw Error('INVALID_ENCODED_REVIEW');}
}
function validateEnvelope(r){decodeReview(r);return r;}
function createReview({catalog,options}){
 const params=validateOptions(options), t={requests:0,pages:0,rows:0,inRangeRows:0,completed:false,terminal:false,declaredTotalPresence:'unknown',declaredTotalMatches:null};
 const products=new Map(),payments=new Map(),refusals=new Map(),identities=new Map(),groups=new Map(),rendering=new Map();
 let renderingOverflow=false,omittedRefusals=0,candidateOverflow=false,identifierCollision=false,total,present=0,absent=0,totalConsistent=true;
 function row(raw){
  t.inRangeRows++;let rejected=false;const fields={};
  for(const f of FIELDS){const value=f[5]?(raw[f[0]]??null):raw[f[0]];const problem=reason(value,f);
   if(problem){rejected=true;const key=JSON.stringify([f[2],f[3],problem]);if(refusals.has(key))refusals.get(key).occurrences++;else if(refusals.size<12)refusals.set(key,{kind:f[2],role:f[3],reason:problem,occurrences:1});else omittedRefusals++;}
   else fields[f[1]]=value;
  }
  if(rejected)return;
  const missing=catalog.reviewFields({...fields,storeId:storeId(params.storeSlug)});
  for(const f of FIELDS){if(fields[f[1]]===null||category(fields[f[1]],f)!=='rendering-sensitive')continue;
   const tupleSha256=sha(JSON.stringify([params.storeSlug,tuple(fields,f[2])])),fieldSha256=sha(Buffer.from(fields[f[1]],'utf8')),key=JSON.stringify([f[2],f[3],tupleSha256,fieldSha256]);
   if(rendering.has(key))rendering.get(key).occurrences++;
   else if(rendering.size<64)rendering.set(key,{kind:f[2],role:f[3],tupleSha256,fieldSha256,byteLength:Buffer.byteLength(fields[f[1]]),codePointLength:[...fields[f[1]]].length,catalogueStatus:missing.some(x=>x.startsWith(f[2]))?'unreviewed':'reviewed',occurrences:1});
   else renderingOverflow=true;
  }
  for(const kind of ['product','payment']){
   if(!missing.some(x=>x.startsWith(kind)))continue;
   const key=tuple(fields,kind),map=kind==='product'?products:payments;
   if(map.has(key)){map.get(key).occurrences++;continue;}
   if(products.size+payments.size>=MAX_CANDIDATES){candidateOverflow=true;continue;}
   if(kind==='product'){
    if(identities.has(fields.productId)&&identities.get(fields.productId)!==key)identifierCollision=true;
    identities.set(fields.productId,key);
    if(fields.groupId!==null){if(groups.has(fields.groupId)&&groups.get(fields.groupId)!==fields.groupLabel)identifierCollision=true;groups.set(fields.groupId,fields.groupLabel);}
   }
   map.set(key,{kind,store:params.storeSlug,occurrences:1,fields:Object.fromEntries(FIELDS.filter(f=>f[2]===kind).map(f=>[f[1],encode(fields[f[1]],f)]))});
  }
 }
 function wrap(request){return async(...args)=>{t.requests++;const body=await request(...args);const page=parseLossless(body,{maxBytes:args[1].maxBytes});
  if(page&&!Array.isArray(page)&&Array.isArray(page.data)){t.pages++;t.rows+=page.data.length;
   if(Object.hasOwn(page,'total')){present++;if(typeof page.total!=='string'||!/^(0|[1-9]\d{0,7})$/.test(page.total))totalConsistent=false;else{totalConsistent&&=total===undefined||total===page.total;total=page.total;}}else absent++;
   t.declaredTotalPresence=present?(absent?'mixed':'present'):'absent';
  }return body;
 };}
 function terminal(){t.terminal=true;t.completed=true;}
 function finish(error){
  t.declaredTotalMatches=present?totalConsistent&&total!==undefined&&Number(total)===t.rows&&t.completed:null;
  let review=null,outcome='operational-failure',code=safeError(error).code;
  if(t.completed&&(!error||code==='CATALOG_REVIEW')){
   const structural=refusals.size>0||omittedRefusals>0||candidateOverflow||identifierCollision||renderingOverflow;
   const ordered=map=>[...map].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,v])=>v);
   review={products:structural?[]:ordered(products),payments:structural?[]:ordered(payments),renderingFields:ordered(rendering),renderingOverflow,refusals:ordered(refusals),omittedRefusals,candidateOverflow,identifierCollision};
   outcome=structural?'structural-review':products.size+payments.size?'candidates':'completed';code=structural?'CATALOG_TEXT_REVIEW':null;
  }
  const r={format:FORMAT,outcome,code,approvalRequired:true,store:params.storeSlug,start:params.start,end:params.end,timezone:'Europe/Copenhagen',traversal:{...t},review};
  try{return validateEnvelope(r);}catch{r.outcome='operational-failure';r.code='DIAGNOSTIC_OPERATION_FAILED';r.review=null;return validateEnvelope(r);}
 }
 return {row,wrap,terminal,finish};
}
async function diagnoseEncodedCatalog({reviewed,request,options,signal,limits={},now=new Date()}){
 if(options?.verificationOf||options?.resumePublication)fail('INVALID_OPTIONS');
 const params=validateOptions(options,now);let catalog;
 try{catalog=createReviewedCatalog(reviewed);}catch{fail('INVALID_CATALOG');}
 const review=createReview({catalog,options});let error;
 try{
  if(typeof options.companyId!=='string'||!/^[1-9]\d{0,63}$/.test(options.companyId))fail('INVALID_OPTIONS');
  await traverse({...limits,...params,companyId:options.companyId,request:review.wrap(request),signal,
   sink:{async batch(){fail('INVALID_OPTIONS');},async progress(){},terminal:review.terminal}},{catalogReviewRow:review.row});checkSignal(signal);
 }catch(e){error=e;}
 return review.finish(error);
}
module.exports={FORMAT,MAX_OUTPUT_BYTES,MAX_CANDIDATES,decodeReview,validateEnvelope,createReview,diagnoseEncodedCatalog};
