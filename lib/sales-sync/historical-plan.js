'use strict';
const {storeId,range,date}=require('../sales-db/values');
const {fail}=require('./errors');
// Run under the same global importer owner as publication. Pending zero reviews
// and operator-owned blocked ranges are not automatic retry candidates.
async function planHistorical(session,{stores,start,end,blockedRanges=[]}) {
  range(start,end,36600);
  if (!Array.isArray(stores) || !stores.length || new Set(stores).size !== stores.length) fail('INVALID_OPTIONS');
  const pending=await session.query(`SELECT 1 FROM sales_foundation.sales_import_scan
    WHERE status='publication-pending' OR (zero_day_policy='review' AND status IN ('staged','validated')) LIMIT 1`);
  if (pending.rows.length) fail('PUBLICATION_PENDING');
  const units=[],blocked=[];
  for (const store of stores) {
    const id=storeId(store);
    const excluded=blockedRanges.filter(b=>b.store===store).map(b=>{date(b.start);date(b.end);if(b.start>=b.end)fail('INVALID_OPTIONS');return b;});
    const {rows}=await session.query(`SELECT ($2::date+n)::text AS date,d.status,d.evidence
      FROM generate_series(0,($3::date-$2::date)-1) n LEFT JOIN sales_foundation.sales_day_state d
      ON d.store_id=$1 AND d.business_date=$2::date+n ORDER BY n`,[id,start,end]);
    for(const r of rows) if(r.status && !(
      (r.status==='complete'&&['complete-single-pass','independently-verified','verified-empty'].includes(r.evidence)) ||
      (r.status==='VERIFIED_CLOSED'&&r.evidence==='verified-closed') ||
      (['ZERO_OBSERVED_PENDING_REVIEW','RETRY_REQUIRED'].includes(r.status)&&r.evidence==='zero-observed'))) fail('INVALID_RUN');
    const missing=rows.filter(r=>r.status===null&&!excluded.some(b=>r.date>=b.start&&r.date<b.end));
    for(const b of excluded) blocked.push({store,start:b.start,end:b.end});
    if(!missing.length)continue;
    const first=missing[0].date;
    const boundary=excluded.filter(b=>b.start>first&&b.start<end).map(b=>b.start).sort()[0]||end;
    // Never join normalized rows from different traversals. A single terminal
    // snapshot reconciles any covered interior days and uses existing buckets.
    units.push({store,start:first,end:boundary,missingDays:missing.filter(d=>d.date<boundary).length,
      coveredOverlapDays:rows.filter(d=>d.date>=first&&d.date<boundary&&['complete','VERIFIED_CLOSED'].includes(d.status)).length});
  }
  return {units,blocked,providerConcurrency:1};
}
module.exports={planHistorical};
