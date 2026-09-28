-- Apply only after authorization to create the dedicated production login.
-- Supply the generated password privately; never add it to this file or argv.
CREATE ROLE kk_sales_dashboard LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
ALTER ROLE kk_sales_dashboard SET default_transaction_read_only = on;
ALTER ROLE kk_sales_dashboard SET statement_timeout = '15s';
ALTER ROLE kk_sales_dashboard SET idle_in_transaction_session_timeout = '15s';
GRANT USAGE ON SCHEMA sales_foundation TO kk_sales_dashboard;
GRANT SELECT (version, checksum) ON sales_foundation.schema_migration TO kk_sales_dashboard;
GRANT SELECT (store_id, business_date, status, evidence, line_count,
  source_observed_at, revenue_incl, revenue_excl)
  ON sales_foundation.sales_day_state TO kk_sales_dashboard;
GRANT SELECT (store_id, business_date, sale_local, second_of_day, time_quality,
  product_id, product_label, group_id, group_label, quantity, revenue_incl,
  revenue_excl, payment_type, payment_code, reconciliation_state)
  ON sales_foundation.sales_line TO kk_sales_dashboard;
-- No membership, table ownership, staging, source_key, fingerprint, identity,
-- write, CREATE SCHEMA, or grant-option privileges are granted.
