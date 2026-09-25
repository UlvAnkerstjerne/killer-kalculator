-- Widen payment_code to accept spaces (OnlinePOS returns codes like "mixed 1").
DO $$
DECLARE item record; removed integer := 0;
BEGIN
  FOR item IN SELECT conname, conrelid::regclass AS tbl FROM pg_constraint
    WHERE conrelid IN ('sales_foundation.sales_line'::regclass, 'sales_foundation.sales_stage_line'::regclass)
      AND contype = 'c'
      AND cardinality(conkey) = 1
      AND conkey[1] = (SELECT attnum FROM pg_attribute WHERE attrelid = conrelid AND attname = 'payment_code')
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', item.tbl, item.conname);
    removed := removed + 1;
  END LOOP;
  IF removed <> 2 THEN RAISE EXCEPTION 'Expected 2 payment_code constraints, found %', removed; END IF;
END $$;

ALTER TABLE sales_foundation.sales_line
  ADD CONSTRAINT sales_line_payment_code_check
  CHECK (payment_code ~ '^[A-Za-z0-9_ -]{1,64}$');

ALTER TABLE sales_foundation.sales_stage_line
  ADD CONSTRAINT sales_stage_line_payment_code_check
  CHECK (payment_code ~ '^[A-Za-z0-9_ -]{1,64}$');
