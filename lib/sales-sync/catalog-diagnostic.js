'use strict';
// Explicit review-only contract. Nothing returned here establishes catalogue trust.
const assert = require('node:assert/strict');
const { traverse } = require('./traverse');
const { parseLossless } = require('./parse');
const { validateOptions } = require('./options');
const { createReviewedCatalog } = require('../sales-db/facts');
const { STORES, date, whitespaceOnly } = require('../sales-db/values');
const { reviewText, reviewProductLabel, inspectText } = require('./catalog-text');
const { safeError, fail, checkSignal } = require('./errors');
const FORMAT = 'kk-catalog-diagnostic-v1', MAX_OUTPUT_BYTES = 16384, MAX_ENTRIES = 12;
const FIELDS = [
  ['productid', 'product', 'product-id', 'id', false],
  ['productname', 'product', 'product-label', 'label', false],
  ['productgroupid', 'product', 'product-group-id', 'id', true],
  ['productgroup', 'product', 'product-group-label', 'label', true],
  ['paymenttype', 'payment', 'payment-type', 'label', false],
  ['paymenttypecode', 'payment', 'payment-type-code', 'code', true],
];
const REASONS = new Set(['UNSUPPORTED_TYPE','EMPTY_TEXT','LENGTH_LIMIT','FORBIDDEN_LINE_BREAK','ANSI_ESCAPE',
  'CONTROL_CHARACTER','BIDI_FORMATTING','FORMAT_CONTROL','SENSITIVE_PATTERN','INVALID_IDENTIFIER',
  'INVALID_PAYMENT_CODE','INVALID_UNICODE','UTF8_BYTE_LIMIT','UNSAFE_OUTPUT_SEQUENCE']);
const CODES = new Set(['INVALID_OPTIONS','INVALID_CONFIG','INVALID_CATALOG','INVALID_PAGE','PAGE_TOO_LARGE',
  'INVALID_JSON','UNSAFE_CONTINUATION','PAGINATION_LOOP','PAGE_LIMIT','ROW_LIMIT','INVALID_LINE','STORE_MISMATCH',
  'UPSTREAM_FAILED','UPSTREAM_RATE_LIMIT','INTERRUPTED','DIAGNOSTIC_OPERATION_FAILED']);
const pkey = p => JSON.stringify([p.storeSlug,p.productId,p.productLabel,p.groupId,p.groupLabel]);
const equivalent = p => JSON.stringify([p.productLabel,p.groupId,p.groupLabel]);
const paykey = p => JSON.stringify([p.paymentType,p.paymentCode]);
const sorted = map => [...map].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([,v]) => v);
function issue(value, kind, emptyAllowed) {
  if (emptyAllowed && value === '') return null;
  const problem = inspectText(value, kind);
  if (problem) return problem;
  if (kind === 'label' && whitespaceOnly(value)) return { reason:'EMPTY_TEXT', utf16Length:value.length,
    characterLength:[...value].length, utf8ByteLength:Buffer.byteLength(value), lengthsCapped:false,
    offendingCharacters:[], charactersTruncated:false };
  return null;
}
function collector(reviewed, store) {
  try { createReviewedCatalog(reviewed); } catch { fail('INVALID_CATALOG'); }
  const known = new Set(reviewed.products.map(pkey)), cross = new Set(reviewed.products.filter(p => p.storeSlug !== store).map(equivalent));
  const payments = new Set(reviewed.payments.map(paykey)), products = new Map(), pays = new Map(), diagnostics = new Map();
  let inRangeRows = 0, rejectedRows = 0, rejectedFields = 0, overflow = false;
  function add(map, key, tuple) {
    const prior = map.get(key);
    if (prior) prior.affectedRows++;
    else if (products.size + pays.size < MAX_ENTRIES) map.set(key, {...tuple, affectedRows:1});
    else overflow = true;
  }
  return {
    row(raw) {
      inRangeRows++; let rejected = false;
      for (const [key,candidateKind,fieldRole,kind,nullable] of FIELDS) {
        const value = raw[key]; if (nullable && value == null) continue;
        const problem = issue(value, kind, key === 'productname');
        if (!problem) continue;
        rejected = true; rejectedFields++;
        const diagnostic = {candidateKind,fieldRole,...problem}, signature = JSON.stringify(diagnostic), prior = diagnostics.get(signature);
        if (prior) prior.occurrences++;
        else {
          diagnostics.set(signature,{...diagnostic,occurrences:1});
          if (diagnostics.size > MAX_ENTRIES) diagnostics.delete([...diagnostics.keys()].sort().at(-1));
        }
      }
      if (rejected) { rejectedRows++; return; }
      // Read exactly six catalogue fields, never monetary, identity or personal fields.
      const product = {storeSlug:store,productId:reviewText(raw.productid,'id'),productLabel:reviewProductLabel(raw.productname),
        groupId:raw.productgroupid == null ? null : reviewText(raw.productgroupid,'id'),
        groupLabel:raw.productgroup == null ? null : reviewText(raw.productgroup)};
      const payment = {storeSlug:store,paymentType:reviewText(raw.paymenttype),paymentCode:raw.paymenttypecode == null ? null : reviewText(raw.paymenttypecode,'code')};
      if (!known.has(pkey(product))) add(products,pkey(product),{...product,classification:cross.has(equivalent(product))?'mechanical-cross-store-equivalent':'novel'});
      if (!payments.has(paykey(payment))) add(pays,paykey(payment),{...payment,classification:'novel'});
    },
    count: () => inRangeRows,
    finish() {
      if (rejectedFields) {
        const kept = sorted(diagnostics), omittedFields = rejectedFields - kept.reduce((n,d) => n+d.occurrences,0);
        return {outcome:'structural-review',code:'CATALOG_TEXT_REVIEW',review:{rejectedRows,rejectedFields,
          diagnosticLimit:MAX_ENTRIES,diagnosticsTruncated:omittedFields>0,omittedFields,diagnostics:kept}};
      }
      if (overflow) fail('ROW_LIMIT');
      const productCandidates = sorted(products), paymentCandidates = sorted(pays);
      return {outcome:products.size+pays.size?'candidates':'completed',code:null,review:{productCandidates,paymentCandidates}};
    },
  };
}
function emptyTraversal() {
  return {requests:0,pages:0,rows:0,inRangeRows:0,completed:false,terminal:false,
    declaredTotalPresence:'unknown',declaredTotalMatches:null};
}
function failure(error) { const code = safeError(error).code; return CODES.has(code) ? code : 'DIAGNOSTIC_OPERATION_FAILED'; }
async function diagnoseCatalogReview({reviewed,request,options,signal,limits={},now=new Date()}) {
  // Valid scope is required even for a retained operational envelope.
  if (options?.verificationOf || options?.resumePublication) fail('INVALID_OPTIONS');
  const params = validateOptions(options,now);
  const result = {format:FORMAT,outcome:'operational-failure',code:null,approvalRequired:true,
    store:params.storeSlug,start:params.start,end:params.end,timezone:'Europe/Copenhagen',traversal:emptyTraversal(),review:null};
  const t = result.traversal; let rows, total, totalConsistent = true, present = 0, absent = 0;
  try {
    if (typeof options.companyId !== 'string' || !/^[1-9]\d{0,63}$/.test(options.companyId)) fail('INVALID_OPTIONS');
    rows = collector(reviewed,params.storeSlug);
    const countedRequest = async (...args) => {
      t.requests++;
      const body = await request(...args);
      // Bounded observation only. traverse remains authoritative for pagination,
      // dates, store and totals; parsed source objects never enter the envelope.
      const page = parseLossless(body,{maxBytes:args[1].maxBytes});
      if (page && !Array.isArray(page) && Array.isArray(page.data)) {
        t.pages++; t.rows += page.data.length;
        if (Object.hasOwn(page,'total')) {
          present++;
          if (typeof page.total !== 'string' || !/^(0|[1-9]\d{0,7})$/.test(page.total)) totalConsistent = false;
          else { totalConsistent &&= total === undefined || total === page.total; total = page.total; }
        } else absent++;
        t.declaredTotalPresence = present ? (absent?'mixed':'present') : 'absent';
      }
      return body;
    };
    const traversal = await traverse({...limits,...params,companyId:options.companyId,request:countedRequest,signal,
      sink:{async batch(){fail('INVALID_OPTIONS');},async progress(){}}},{catalogReviewRow:rows.row});
    checkSignal(signal);
    t.completed = true; t.terminal = traversal.terminal;
    Object.assign(result,rows.finish());
  } catch (error) { result.outcome='operational-failure'; result.code=failure(error); result.review=null; }
  t.inRangeRows = rows ? rows.count() : 0;
  t.declaredTotalMatches = present ? totalConsistent && total !== undefined && Number(total) === t.rows && t.completed : null;
  try { validateEnvelope(result); }
  catch { result.outcome='operational-failure'; result.code='DIAGNOSTIC_OPERATION_FAILED'; result.review=null; validateEnvelope(result); }
  return result;
}
const keys = (o, list) => { assert(o && Object.getPrototypeOf(o) === Object.prototype); assert.deepEqual(Object.keys(o).sort(),list.slice().sort()); };
const number = (n,max=20000000) => assert(Number.isSafeInteger(n) && n>=0 && n<=max);
function validateEnvelope(r) {
  keys(r,['format','outcome','code','approvalRequired','store','start','end','timezone','traversal','review']);
  assert.equal(r.format,FORMAT); assert.equal(r.approvalRequired,true); assert(STORES.includes(r.store));
  date(r.start); date(r.end); assert(r.start<r.end); assert.equal(r.timezone,'Europe/Copenhagen');
  assert(['operational-failure','structural-review','candidates','completed'].includes(r.outcome));
  const t=r.traversal;
  keys(t,['requests','pages','rows','inRangeRows','completed','terminal','declaredTotalPresence','declaredTotalMatches']);
  for(const k of ['requests','pages']) number(t[k],10000);
  for(const k of ['rows','inRangeRows']) number(t[k]);
  assert(t.pages<=t.requests && t.inRangeRows<=t.rows); assert.equal(typeof t.completed,'boolean'); assert.equal(typeof t.terminal,'boolean');
  assert.equal(t.terminal,t.completed); assert(['unknown','absent','present','mixed'].includes(t.declaredTotalPresence));
  if (['unknown','absent'].includes(t.declaredTotalPresence)) assert.equal(t.declaredTotalMatches,null);
  else assert.equal(typeof t.declaredTotalMatches,'boolean');
  if (r.outcome === 'operational-failure') { assert(CODES.has(r.code)); assert.equal(r.review,null); }
  else {
    assert(t.completed && t.terminal && t.pages>0 && t.pages===t.requests);
    assert.notEqual(t.declaredTotalPresence,'unknown');
    if (['present','mixed'].includes(t.declaredTotalPresence)) assert.equal(t.declaredTotalMatches,true);
    if (r.outcome === 'structural-review') {
      assert.equal(r.code,'CATALOG_TEXT_REVIEW');
      const v=r.review; keys(v,['rejectedRows','rejectedFields','diagnosticLimit','diagnosticsTruncated','omittedFields','diagnostics']);
      number(v.rejectedRows); number(v.rejectedFields,120000000); number(v.omittedFields,120000000);
      assert(v.rejectedRows>0 && v.rejectedRows<=t.inRangeRows && v.rejectedFields>=v.rejectedRows && v.rejectedFields<=6*v.rejectedRows);
      assert.equal(v.diagnosticLimit,MAX_ENTRIES); assert.equal(v.diagnosticsTruncated,v.omittedFields>0);
      assert(Array.isArray(v.diagnostics) && v.diagnostics.length>0 && v.diagnostics.length<=MAX_ENTRIES);
      let fields=0; const seen=new Set();
      for(const d of v.diagnostics) {
        keys(d,['candidateKind','fieldRole','reason','utf16Length','characterLength','utf8ByteLength','lengthsCapped','offendingCharacters','charactersTruncated','occurrences']);
        assert(FIELDS.some(f=>f[1]===d.candidateKind && f[2]===d.fieldRole)); assert(REASONS.has(d.reason));
        assert.equal(typeof d.lengthsCapped,'boolean'); assert.equal(typeof d.charactersTruncated,'boolean');
        for(const k of ['utf16Length','characterLength','utf8ByteLength']) if(d[k]!==null) number(d[k],196608);
        assert(Array.isArray(d.offendingCharacters) && d.offendingCharacters.length<=4);
        for(const c of d.offendingCharacters) {
          keys(c,['position','codePoint']); number(c.position,65535); assert(/^U\+[A-F0-9]{4,6}$/.test(c.codePoint));
          const cp=parseInt(c.codePoint.slice(2),16); assert(cp<=0x10ffff && /[\p{Cc}\p{Cf}\p{Cs}]/u.test(String.fromCodePoint(cp)));
        }
        number(d.occurrences); assert(d.occurrences>0); fields+=d.occurrences;
        const signature=JSON.stringify({...d,occurrences:0}); assert(!seen.has(signature)); seen.add(signature);
      }
      assert.equal(fields+v.omittedFields,v.rejectedFields);
    } else {
      assert.equal(r.code,null); keys(r.review,['productCandidates','paymentCandidates']); let count=0;
      for(const name of ['productCandidates','paymentCandidates']) {
        const list=r.review[name], product=name==='productCandidates', seen=new Set(); let affected=0;
        assert(Array.isArray(list) && list.length<=MAX_ENTRIES); count+=list.length;
        for(const v of list) {
          keys(v,product?['storeSlug','productId','productLabel','groupId','groupLabel','classification','affectedRows']:
            ['storeSlug','paymentType','paymentCode','classification','affectedRows']);
          assert.equal(v.storeSlug,r.store); number(v.affectedRows); assert(v.affectedRows>0); affected+=v.affectedRows;
          assert((product?['novel','mechanical-cross-store-equivalent']:['novel']).includes(v.classification));
          for(const [k,kind,nullable,empty] of product?[['productId','id',false,false],['productLabel','label',false,true],['groupId','id',true,false],['groupLabel','label',true,false]]:
            [['paymentType','label',false,false],['paymentCode','code',true,false]]) {
            if(nullable && v[k]===null) continue;
            assert.equal(issue(v[k],kind,empty),null); if(empty) reviewProductLabel(v[k]); else reviewText(v[k],kind);
          }
          const key=product?pkey(v):paykey(v); assert(!seen.has(key)); seen.add(key);
        }
        assert(affected<=t.inRangeRows);
      }
      assert(count<=MAX_ENTRIES); assert.equal(r.outcome,count?'candidates':'completed');
    }
  }
  assert(Buffer.byteLength(JSON.stringify(r),'utf8')<=MAX_OUTPUT_BYTES);
  return r;
}
module.exports={diagnoseCatalogReview,validateEnvelope,FORMAT,MAX_OUTPUT_BYTES,MAX_ENTRIES};
