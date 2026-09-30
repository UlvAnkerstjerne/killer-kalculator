'use strict';
const { storeId, date } = require('../sales-db/values');
const { fail } = require('./errors');
// Called only after terminal snapshot reconciliation, inside its atomic bucket.
async function observeZeroDays(session, run, { start = run.start, end = run.end } = {}) {
  await session.query(`INSERT INTO sales_foundation.sales_day_state
    (store_id,business_date,published_run,verified_at,source_observed_at,status,line_count,
     revenue_incl,revenue_excl,content_digest,evidence,zero_observation_run)
    SELECT d.store_id,d.business_date,d.run_id,clock_timestamp(),r.observed_at,
      'ZERO_OBSERVED_PENDING_REVIEW',0,0,0,d.content_digest,'zero-observed',d.run_id
    FROM sales_foundation.sales_import_day d
    JOIN sales_foundation.sales_sync_run r USING(run_id,store_id)
    JOIN sales_foundation.sales_import_scan i USING(run_id,store_id)
    WHERE d.run_id=$1 AND d.store_id=$2 AND d.business_date >=$3 AND d.business_date <$4
      AND i.terminal AND d.line_count=0 AND d.revenue_incl=0 AND d.revenue_excl=0
      AND d.quantity=0 AND d.negative_price_count=0 AND d.negative_quantity_count=0
      AND d.refund_incl=0 AND d.refund_excl=0
      AND NOT EXISTS (SELECT 1 FROM sales_foundation.sales_line f
        WHERE f.store_id=d.store_id AND f.business_date=d.business_date)
    ON CONFLICT (store_id,business_date) DO NOTHING`, [run.id,run.store,start,end]);
}
// One explicit reviewed run at a time. No HTTP, no staging reconstruction and no
// claim that the old failed scan passed publication preflight. Only its durable
// zero observations are preserved for human review.
async function retainZeroObservations(session, id) {
  require('./repository').runId(id);
  return session.transaction(async () => {
    const {rows:[r]} = await session.query(`SELECT r.store_id AS store,r.start_date::text AS start,
      r.end_date::text AS end FROM sales_foundation.sales_sync_run r
      JOIN sales_foundation.sales_import_scan i USING(run_id,store_id)
      WHERE r.run_id=$1 AND i.terminal AND i.scan_finished_at IS NOT NULL
        AND i.status='failed' AND i.error_code='INVALID_RUN' AND i.review_count=0
        AND i.verification_of IS NULL AND i.logical_count=r.line_count
        AND (SELECT count(*) FROM sales_foundation.sales_import_day d WHERE d.run_id=r.run_id)=r.end_date-r.start_date
        AND (SELECT sum(d.line_count) FROM sales_foundation.sales_import_day d WHERE d.run_id=r.run_id)=i.logical_count
        AND NOT EXISTS (SELECT 1 FROM sales_foundation.sales_stage_line s WHERE s.run_id=r.run_id)
        AND NOT EXISTS (SELECT 1 FROM sales_foundation.sales_import_bucket b WHERE b.scan_id=r.run_id)
        AND NOT EXISTS (SELECT 1 FROM sales_foundation.sales_import_discrepancy x WHERE x.run_id=r.run_id)`, [id]);
    if (!r) fail('INVALID_RUN');
    await observeZeroDays(session,{id,...r});
    return listZeroDays(session);
  });
}
async function listZeroDays(session) {
  const {rows} = await session.query(`SELECT s.slug AS store,d.business_date::text AS date,d.status,
    d.source_observed_at AS "observedAt",d.zero_reviewed_at AS "reviewedAt"
    FROM sales_foundation.sales_day_state d JOIN sales_foundation.sales_store s USING(store_id)
    WHERE d.zero_observation_run IS NOT NULL ORDER BY d.store_id,d.business_date`);
  return rows;
}
// Private operator API: the caller must hold the importer lock and have Ulv's
// explicit per-date decision. Expected observation prevents stale approval.
async function reviewZeroDay(session, {storeSlug,businessDate,observationRun,decision,reviewedBy}) {
  if (!['VERIFIED_CLOSED','RETRY_REQUIRED'].includes(decision) || reviewedBy !== 'ulv') fail('INVALID_OPTIONS');
  const id=storeId(storeSlug);date(businessDate);require('./repository').runId(observationRun);
  return session.transaction(async () => {
    const {rows:[r]}=await session.query(`SELECT status,zero_observation_run FROM sales_foundation.sales_day_state
      WHERE store_id=$1 AND business_date=$2 FOR UPDATE`,[id,businessDate]);
    if (!r || r.zero_observation_run !== observationRun || !['ZERO_OBSERVED_PENDING_REVIEW','RETRY_REQUIRED',decision].includes(r.status)) fail('INVALID_RUN');
    if ((await session.query('SELECT 1 FROM sales_foundation.sales_line WHERE store_id=$1 AND business_date=$2 LIMIT 1',[id,businessDate])).rows.length) fail('RECONCILIATION_REQUIRED');
    if (r.status !== decision) await session.query(`UPDATE sales_foundation.sales_day_state SET status=$3,
      evidence=CASE WHEN $3='VERIFIED_CLOSED' THEN 'verified-closed' ELSE 'zero-observed' END,
      zero_reviewed_at=clock_timestamp(),zero_reviewed_by='ulv' WHERE store_id=$1 AND business_date=$2`,[id,businessDate,decision]);
    return {store:storeSlug,date:businessDate,status:decision};
  });
}
module.exports={observeZeroDays,retainZeroObservations,listZeroDays,reviewZeroDay};
