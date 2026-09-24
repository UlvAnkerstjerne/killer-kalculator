-- Additive Stage 2 extension. Never invoked by the web process.
ALTER TABLE sales_foundation.sales_sync_run ADD COLUMN run_kind text NOT NULL DEFAULT 'foundation'
  CHECK (run_kind IN ('foundation', 'backfill', 'backfill_bucket'));
-- Preserve the original foundation bounds; explicit backfill runs can span
-- history and publication buckets can exceed the foundation API's 10,000 rows.
ALTER TABLE sales_foundation.sales_sync_run DROP CONSTRAINT sales_sync_run_line_count_check;
DO $$
DECLARE item record; removed integer := 0;
BEGIN
  FOR item IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'sales_foundation.sales_sync_run'::regclass AND contype = 'c'
      AND cardinality(conkey) = 2 AND conkey @> ARRAY(
        SELECT attnum FROM pg_attribute WHERE attrelid = 'sales_foundation.sales_sync_run'::regclass
          AND attname IN ('start_date', 'end_date'))::smallint[]
  LOOP
    EXECUTE format('ALTER TABLE sales_foundation.sales_sync_run DROP CONSTRAINT %I', item.conname);
    removed := removed + 1;
  END LOOP;
  IF removed <> 1 THEN RAISE EXCEPTION 'Unexpected foundation range constraint'; END IF;
END $$;
ALTER TABLE sales_foundation.sales_sync_run
  ADD CONSTRAINT sync_run_count_bound CHECK (line_count BETWEEN 0 AND 20000000 AND (run_kind <> 'foundation' OR line_count <= 10000)),
  ADD CONSTRAINT sync_run_date_bound CHECK (end_date > start_date AND
    (run_kind = 'backfill' OR end_date - start_date <= 31));

CREATE TABLE sales_foundation.sales_import_scan (
  run_id uuid PRIMARY KEY,
  store_id smallint NOT NULL,
  status text NOT NULL CHECK (status IN ('fetching', 'staged', 'validated', 'publication-pending', 'published', 'quarantined', 'failed', 'interrupted')),
  terminal boolean NOT NULL DEFAULT false,
  pages integer NOT NULL DEFAULT 0 CHECK (pages BETWEEN 0 AND 10000),
  received_rows integer NOT NULL DEFAULT 0 CHECK (received_rows BETWEEN 0 AND 20000000),
  review_count integer NOT NULL DEFAULT 0 CHECK (review_count BETWEEN 0 AND 20000000),
  logical_count integer NOT NULL DEFAULT 0 CHECK (logical_count BETWEEN 0 AND 20000000),
  revenue_incl numeric NOT NULL DEFAULT 0,
  revenue_excl numeric NOT NULL DEFAULT 0,
  quantity numeric NOT NULL DEFAULT 0,
  negative_price_count integer NOT NULL DEFAULT 0 CHECK (negative_price_count >= 0),
  negative_quantity_count integer NOT NULL DEFAULT 0 CHECK (negative_quantity_count >= 0),
  refund_incl numeric NOT NULL DEFAULT 0,
  refund_excl numeric NOT NULL DEFAULT 0,
  scan_finished_at timestamptz CHECK (isfinite(scan_finished_at)),
  verification_of uuid,
  verified boolean NOT NULL DEFAULT false,
  error_code text CHECK (error_code IN ('INVALID_PAGE', 'PAGE_TOO_LARGE', 'INVALID_JSON', 'UNSAFE_CONTINUATION',
    'PAGINATION_LOOP', 'PAGE_LIMIT', 'ROW_LIMIT', 'INVALID_LINE', 'STORE_MISMATCH', 'CATALOG_REVIEW',
    'SOURCE_CONFLICT', 'UPSTREAM_FAILED', 'UPSTREAM_RATE_LIMIT', 'INTERRUPTED', 'DB_OPERATION_FAILED',
    'LOCK_LOST', 'INVALID_RUN', 'IDENTITY_MISMATCH', 'RECONCILIATION_REQUIRED', 'VERIFICATION_MISMATCH', 'PUBLICATION_PENDING')),
  UNIQUE (run_id, store_id),
  FOREIGN KEY (run_id, store_id) REFERENCES sales_foundation.sales_sync_run (run_id, store_id),
  FOREIGN KEY (verification_of, store_id) REFERENCES sales_foundation.sales_import_scan (run_id, store_id),
  CHECK (verification_of IS DISTINCT FROM run_id),
  CHECK (NOT verified OR (verification_of IS NOT NULL AND terminal)),
  CHECK (status NOT IN ('staged', 'validated', 'publication-pending', 'published') OR (terminal AND scan_finished_at IS NOT NULL)),
  CHECK (abs(revenue_incl) < 1e30 AND scale(revenue_incl) <= 18 AND abs(revenue_excl) < 1e30 AND scale(revenue_excl) <= 18
    AND abs(quantity) < 1e30 AND scale(quantity) <= 18 AND abs(refund_incl) < 1e30 AND scale(refund_incl) <= 18
    AND abs(refund_excl) < 1e30 AND scale(refund_excl) <= 18)
);
CREATE INDEX sales_import_scan_store_status ON sales_foundation.sales_import_scan (store_id, status);

CREATE TABLE sales_foundation.sales_import_day (
  run_id uuid NOT NULL,
  store_id smallint NOT NULL,
  business_date sales_foundation.business_date NOT NULL,
  line_count integer NOT NULL CHECK (line_count BETWEEN 0 AND 20000000),
  revenue_incl numeric NOT NULL,
  revenue_excl numeric NOT NULL,
  quantity numeric NOT NULL,
  negative_price_count integer NOT NULL CHECK (negative_price_count >= 0),
  negative_quantity_count integer NOT NULL CHECK (negative_quantity_count >= 0),
  refund_incl numeric NOT NULL,
  refund_excl numeric NOT NULL,
  content_digest bytea NOT NULL CHECK (octet_length(content_digest) = 32),
  PRIMARY KEY (run_id, store_id, business_date),
  FOREIGN KEY (run_id, store_id) REFERENCES sales_foundation.sales_import_scan (run_id, store_id),
  CHECK (abs(revenue_incl) < 1e30 AND scale(revenue_incl) <= 18 AND abs(revenue_excl) < 1e30 AND scale(revenue_excl) <= 18
    AND abs(quantity) < 1e30 AND scale(quantity) <= 18 AND abs(refund_incl) < 1e30 AND scale(refund_incl) <= 18
    AND abs(refund_excl) < 1e30 AND scale(refund_excl) <= 18)
);
CREATE TABLE sales_foundation.sales_import_bucket (
  scan_id uuid NOT NULL,
  store_id smallint NOT NULL,
  start_date sales_foundation.business_date NOT NULL,
  end_date sales_foundation.business_date NOT NULL,
  published_run uuid NOT NULL UNIQUE,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(published_at)),
  PRIMARY KEY (scan_id, store_id, start_date),
  FOREIGN KEY (scan_id, store_id) REFERENCES sales_foundation.sales_import_scan (run_id, store_id),
  FOREIGN KEY (published_run, store_id) REFERENCES sales_foundation.sales_sync_run (run_id, store_id),
  CHECK (end_date > start_date AND end_date - start_date <= 31)
);
CREATE TABLE sales_foundation.sales_import_discrepancy (
  run_id uuid NOT NULL,
  store_id smallint NOT NULL,
  source_key bytea NOT NULL CHECK (octet_length(source_key) = 32),
  kind text NOT NULL CHECK (kind IN ('changed', 'missing')),
  old_date sales_foundation.business_date NOT NULL,
  new_date sales_foundation.business_date,
  old_fingerprint bytea NOT NULL CHECK (octet_length(old_fingerprint) = 32),
  new_fingerprint bytea CHECK (octet_length(new_fingerprint) = 32),
  PRIMARY KEY (run_id, store_id, source_key),
  FOREIGN KEY (run_id, store_id) REFERENCES sales_foundation.sales_import_scan (run_id, store_id),
  CHECK ((kind = 'missing' AND new_date IS NULL AND new_fingerprint IS NULL) OR
    (kind = 'changed' AND new_date IS NOT NULL AND new_fingerprint IS NOT NULL))
);
ALTER TABLE sales_foundation.sales_day_state
  ADD COLUMN evidence text NOT NULL DEFAULT 'complete-single-pass'
    CHECK (evidence IN ('complete-single-pass', 'independently-verified', 'verified-empty')),
  ADD COLUMN verification_run uuid REFERENCES sales_foundation.sales_import_scan (run_id),
  ADD CONSTRAINT sales_day_verified_evidence CHECK
    ((evidence = 'complete-single-pass' AND verification_run IS NULL) OR
     (evidence <> 'complete-single-pass' AND verification_run IS NOT NULL)),
  ADD CONSTRAINT sales_day_verified_empty CHECK (evidence <> 'verified-empty' OR line_count = 0);
