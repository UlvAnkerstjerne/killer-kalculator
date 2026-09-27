-- Forward-only constraint change; the migration runner owns the transaction
-- and checksum ledger. Lock both relations before inspecting either shape.
LOCK TABLE sales_foundation.sales_line, sales_foundation.sales_stage_line IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  tbl regclass;
  label_column smallint;
  found_count integer;
  expected_shape boolean;
  item record;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['sales_foundation.sales_line'::regclass, 'sales_foundation.sales_stage_line'::regclass]
  LOOP
    SELECT attnum INTO label_column FROM pg_attribute
      WHERE attrelid = tbl AND attname = 'product_label' AND NOT attisdropped
        AND atttypid = 'text'::regtype AND attnotnull;
    IF label_column IS NULL THEN RAISE EXCEPTION 'Expected NOT NULL text product_label'; END IF;

    -- Inspect every check touching this column, including multi-column checks.
    -- Missing, extra, unvalidated or altered checks are drift, not permission to
    -- drop an arbitrary constraint. PostgreSQL 16's canonical old definition is
    -- deliberately exact; a different shape requires a separate reviewed change.
    SELECT count(*), bool_and(conkey = ARRAY[label_column] AND convalidated
      AND conislocal AND coninhcount = 0 AND NOT connoinherit
      AND pg_get_constraintdef(oid, false) =
        'CHECK ((((length(product_label) >= 1) AND (length(product_label) <= 160)) AND (product_label !~ ''[[:cntrl:]]''::text)))')
      INTO found_count, expected_shape FROM pg_constraint
      WHERE conrelid = tbl AND contype = 'c' AND label_column = ANY(conkey);
    IF found_count <> 1 OR expected_shape IS NOT TRUE THEN
      RAISE EXCEPTION 'Unexpected product_label constraint shape';
    END IF;
  END LOOP;

  FOR item IN SELECT conrelid::regclass AS tbl, conname FROM pg_constraint
    WHERE conrelid IN ('sales_foundation.sales_line'::regclass, 'sales_foundation.sales_stage_line'::regclass)
      AND contype = 'c' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
        WHERE attrelid = conrelid AND attname = 'product_label')]::smallint[]
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', item.tbl, item.conname);
    -- Explicit Unicode White_Space plus BOM avoids locale-dependent \s/space
    -- classes. btrim is a predicate only: stored text is never trimmed/rewritten.
    -- Control prohibition and the existing 160-character limit remain intact.
    EXECUTE format($check$
      ALTER TABLE %s ADD CONSTRAINT %I CHECK (
        product_label = '' OR (
          length(product_label) BETWEEN 1 AND 160
          AND product_label !~ '[[:cntrl:]]'
          AND btrim(product_label, U&'\0009\000A\000B\000C\000D\0020\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''
        )
      )$check$, item.tbl, item.conname);
  END LOOP;
END $$;
