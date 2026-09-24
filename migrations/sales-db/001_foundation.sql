-- Explicit migration only. Nothing here is run by production web startup.
CREATE DOMAIN sales_foundation.exact_amount AS numeric
  CHECK (VALUE > -100000000000000000000::numeric
     AND VALUE < 100000000000000000000::numeric AND scale(VALUE) <= 18);
CREATE DOMAIN sales_foundation.business_date AS date
  CHECK (VALUE >= DATE '2000-01-01' AND VALUE < DATE '2100-01-01');
CREATE TYPE sales_foundation.time_quality AS ENUM
  ('missing', 'payment', 'fallback', 'payment_ambiguous', 'fallback_ambiguous');
CREATE TYPE sales_foundation.run_state AS ENUM ('staging', 'published');
CREATE TYPE sales_foundation.reconciliation_state AS ENUM ('active');

CREATE TABLE sales_foundation.sales_store (
  store_id smallint PRIMARY KEY CHECK (store_id BETWEEN 1 AND 6),
  slug text NOT NULL UNIQUE CHECK (slug IN
    ('indre-by', 'vesterbro', 'christianshavn', 'fisketorvet', 'frederiksberg', 'norrebro')),
  CHECK (slug = (ARRAY['indre-by', 'vesterbro', 'christianshavn', 'fisketorvet', 'frederiksberg', 'norrebro'])[store_id])
);
INSERT INTO sales_foundation.sales_store (store_id, slug) VALUES
  (1, 'indre-by'), (2, 'vesterbro'), (3, 'christianshavn'),
  (4, 'fisketorvet'), (5, 'frederiksberg'), (6, 'norrebro');

-- Singleton non-secret marker; an unexpected identity key must fail closed.
CREATE TABLE sales_foundation.identity_key_check (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  key_version smallint NOT NULL UNIQUE CHECK (key_version > 0),
  check_digest bytea NOT NULL CHECK (octet_length(check_digest) = 32)
);
CREATE TABLE sales_foundation.sales_sync_run (
  run_id uuid PRIMARY KEY,
  store_id smallint NOT NULL REFERENCES sales_foundation.sales_store,
  start_date sales_foundation.business_date NOT NULL,
  end_date sales_foundation.business_date NOT NULL,
  observed_at timestamptz NOT NULL CHECK (isfinite(observed_at)),
  published_at timestamptz,
  state sales_foundation.run_state NOT NULL,
  contract_version smallint NOT NULL DEFAULT 1 CHECK (contract_version = 1),
  line_count integer NOT NULL CHECK (line_count BETWEEN 0 AND 10000),
  content_digest bytea NOT NULL CHECK (octet_length(content_digest) = 32),
  UNIQUE (run_id, store_id),
  CHECK (end_date > start_date AND end_date - start_date <= 31),
  CHECK ((state = 'published') = (published_at IS NOT NULL)),
  CHECK (published_at IS NULL OR (isfinite(published_at) AND published_at >= observed_at))
);
CREATE INDEX sales_sync_run_store_observed ON sales_foundation.sales_sync_run (store_id, observed_at DESC);

CREATE TABLE sales_foundation.sales_line (
  store_id smallint NOT NULL REFERENCES sales_foundation.sales_store,
  source_key bytea NOT NULL CHECK (octet_length(source_key) = 32),
  key_version smallint NOT NULL CHECK (key_version > 0),
  business_date sales_foundation.business_date NOT NULL,
  sale_local timestamp without time zone,
  second_of_day integer CHECK (second_of_day BETWEEN 0 AND 86399),
  time_quality sales_foundation.time_quality NOT NULL,
  product_id text NOT NULL CHECK (product_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  product_label text NOT NULL CHECK (length(product_label) BETWEEN 1 AND 160 AND product_label !~ '[[:cntrl:]]'),
  group_id text CHECK (group_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  group_label text CHECK (length(group_label) BETWEEN 1 AND 160 AND group_label !~ '[[:cntrl:]]'),
  quantity sales_foundation.exact_amount NOT NULL,
  revenue_incl sales_foundation.exact_amount NOT NULL,
  revenue_excl sales_foundation.exact_amount NOT NULL,
  payment_type text NOT NULL CHECK (length(payment_type) BETWEEN 1 AND 160 AND payment_type !~ '[[:cntrl:]]'),
  payment_code text CHECK (payment_code ~ '^[A-Za-z0-9_-]{1,64}$'),
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
  first_seen_at timestamptz NOT NULL CHECK (isfinite(first_seen_at)),
  content_changed_at timestamptz NOT NULL CHECK (isfinite(content_changed_at) AND content_changed_at >= first_seen_at),
  last_seen_run uuid NOT NULL,
  reconciliation_state sales_foundation.reconciliation_state NOT NULL DEFAULT 'active',
  PRIMARY KEY (store_id, source_key),
  FOREIGN KEY (last_seen_run, store_id) REFERENCES sales_foundation.sales_sync_run (run_id, store_id),
  FOREIGN KEY (key_version) REFERENCES sales_foundation.identity_key_check (key_version),
  CHECK ((time_quality = 'missing' AND sale_local IS NULL AND second_of_day IS NULL) OR
    (time_quality <> 'missing' AND sale_local IS NOT NULL AND second_of_day IS NOT NULL
     AND sale_local::date = business_date
     AND extract(epoch FROM sale_local::time) = second_of_day
     AND (sale_local AT TIME ZONE 'Europe/Copenhagen') AT TIME ZONE 'Europe/Copenhagen' = sale_local
     AND (time_quality IN ('payment_ambiguous', 'fallback_ambiguous')) =
       (((sale_local - interval '1 hour') AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Copenhagen' = sale_local
        AND ((sale_local - interval '2 hours') AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Copenhagen' = sale_local)))
);
CREATE INDEX sales_line_active_range ON sales_foundation.sales_line
  (store_id, business_date, second_of_day, source_key) WHERE reconciliation_state = 'active';

CREATE TABLE sales_foundation.sales_stage_line (
  LIKE sales_foundation.sales_line INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  run_id uuid NOT NULL,
  source_page integer NOT NULL CHECK (source_page >= 1),
  source_position integer NOT NULL CHECK (source_position >= 0),
  PRIMARY KEY (run_id, store_id, source_key),
  FOREIGN KEY (run_id, store_id) REFERENCES sales_foundation.sales_sync_run (run_id, store_id),
  FOREIGN KEY (last_seen_run, store_id) REFERENCES sales_foundation.sales_sync_run (run_id, store_id),
  FOREIGN KEY (store_id) REFERENCES sales_foundation.sales_store,
  FOREIGN KEY (key_version) REFERENCES sales_foundation.identity_key_check (key_version)
);
CREATE INDEX sales_stage_line_range ON sales_foundation.sales_stage_line (run_id, store_id, business_date);

CREATE TABLE sales_foundation.sales_day_state (
  store_id smallint NOT NULL REFERENCES sales_foundation.sales_store,
  business_date sales_foundation.business_date NOT NULL,
  published_run uuid NOT NULL,
  verified_at timestamptz NOT NULL CHECK (isfinite(verified_at)),
  source_observed_at timestamptz NOT NULL CHECK (isfinite(source_observed_at)),
  status text NOT NULL CHECK (status = 'complete'),
  line_count integer NOT NULL CHECK (line_count >= 0),
  revenue_incl numeric NOT NULL CHECK (revenue_incl > '-Infinity'::numeric AND revenue_incl < 'Infinity'::numeric AND scale(revenue_incl) <= 18),
  revenue_excl numeric NOT NULL CHECK (revenue_excl > '-Infinity'::numeric AND revenue_excl < 'Infinity'::numeric AND scale(revenue_excl) <= 18),
  content_digest bytea NOT NULL CHECK (octet_length(content_digest) = 32),
  PRIMARY KEY (store_id, business_date),
  FOREIGN KEY (published_run, store_id) REFERENCES sales_foundation.sales_sync_run (run_id, store_id),
  CHECK (verified_at >= source_observed_at)
);
