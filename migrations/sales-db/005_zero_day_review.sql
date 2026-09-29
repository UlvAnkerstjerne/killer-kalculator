-- Forward-only metadata extension. Existing facts, coverage and grants are untouched.
ALTER TABLE sales_foundation.sales_import_scan ADD COLUMN zero_day_policy text NOT NULL DEFAULT 'legacy'
  CHECK (zero_day_policy IN ('legacy', 'review'));
ALTER TABLE sales_foundation.sales_day_state
  DROP CONSTRAINT sales_day_state_status_check,
  DROP CONSTRAINT sales_day_state_evidence_check,
  DROP CONSTRAINT sales_day_verified_evidence,
  ADD COLUMN zero_observation_run uuid,
  ADD COLUMN zero_reviewed_at timestamptz,
  ADD COLUMN zero_reviewed_by text,
  ADD FOREIGN KEY (zero_observation_run, store_id)
    REFERENCES sales_foundation.sales_import_scan (run_id, store_id),
  ADD CONSTRAINT sales_day_state_status_check CHECK
    (status IN ('complete', 'ZERO_OBSERVED_PENDING_REVIEW', 'VERIFIED_CLOSED', 'RETRY_REQUIRED')),
  ADD CONSTRAINT sales_day_state_evidence_check CHECK
    (evidence IN ('complete-single-pass', 'independently-verified', 'verified-empty', 'zero-observed', 'verified-closed')),
  ADD CONSTRAINT sales_day_verified_evidence CHECK
    ((evidence IN ('complete-single-pass', 'zero-observed', 'verified-closed') AND verification_run IS NULL) OR
     (evidence IN ('independently-verified', 'verified-empty') AND verification_run IS NOT NULL)),
  ADD CONSTRAINT sales_day_zero_review CHECK (
    (status = 'complete' AND evidence IN ('complete-single-pass', 'independently-verified', 'verified-empty')
      AND zero_observation_run IS NULL AND zero_reviewed_at IS NULL AND zero_reviewed_by IS NULL) OR
    (status <> 'complete' AND zero_observation_run IS NOT NULL AND line_count = 0
      AND revenue_incl = 0 AND revenue_excl = 0
      AND content_digest = decode('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855','hex')
      AND ((status = 'ZERO_OBSERVED_PENDING_REVIEW' AND evidence = 'zero-observed'
             AND zero_reviewed_at IS NULL AND zero_reviewed_by IS NULL) OR
           (status IN ('VERIFIED_CLOSED','RETRY_REQUIRED')
             AND evidence = CASE WHEN status = 'VERIFIED_CLOSED' THEN 'verified-closed' ELSE 'zero-observed' END
             AND zero_reviewed_by IS NOT NULL AND zero_reviewed_by = 'ulv' AND zero_reviewed_at IS NOT NULL
             AND isfinite(zero_reviewed_at) AND zero_reviewed_at >= source_observed_at))));
