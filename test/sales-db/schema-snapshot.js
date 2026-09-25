'use strict';

// Metadata only: never read facts, identifiers, row contents or key markers.
// Stable definitions omit OIDs and runtime statistics. Owner/ACL configuration
// and objects outside sales_foundation require a separate operational audit.
async function schemaSnapshot(db) {
  const queries = {
    relations: `SELECT c.relname, c.relkind, c.relpersistence, c.relrowsecurity,
        c.relforcerowsecurity, c.relreplident, c.reloptions,
        pg_get_expr(c.relpartbound, c.oid) AS partition_bound
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'sales_foundation' ORDER BY c.relname`,
    columns: `SELECT c.relname, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) AS type,
        a.attnotnull, a.attidentity, a.attgenerated, a.attndims, a.attisdropped,
        a.attstorage, a.attcompression, pg_get_expr(d.adbin, d.adrelid) AS default_value
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = 'sales_foundation' AND a.attnum > 0 ORDER BY c.relname, a.attnum`,
    constraints: `SELECT c.relname, t.typname, x.conname, x.contype, x.condeferrable,
        x.condeferred, x.convalidated, x.connoinherit, pg_get_constraintdef(x.oid) AS definition
      FROM pg_constraint x JOIN pg_namespace n ON n.oid = x.connamespace
      LEFT JOIN pg_class c ON c.oid = x.conrelid LEFT JOIN pg_type t ON t.oid = x.contypid
      WHERE n.nspname = 'sales_foundation' ORDER BY c.relname, t.typname, x.conname`,
    indexes: `SELECT c.relname, i.indisvalid, i.indisready, i.indisreplident,
        pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'sales_foundation' ORDER BY c.relname`,
    types: `SELECT t.typname, t.typtype, t.typnotnull, t.typdefault,
        CASE WHEN t.typbasetype <> 0 THEN format_type(t.typbasetype, t.typtypmod) END AS base_type,
        ARRAY(SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'sales_foundation' ORDER BY t.typname`,
    triggers: `SELECT c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'sales_foundation' AND NOT t.tgisinternal ORDER BY c.relname, t.tgname`,
    routines: `SELECT p.proname, p.prokind, pg_get_function_identity_arguments(p.oid) AS arguments,
        CASE WHEN p.prokind IN ('f', 'p') THEN pg_get_functiondef(p.oid) END AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'sales_foundation' ORDER BY p.proname, arguments`,
    rules: `SELECT c.relname, r.rulename, pg_get_ruledef(r.oid) AS definition
      FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'sales_foundation' ORDER BY c.relname, r.rulename`,
    policies: `SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
      FROM pg_policies WHERE schemaname = 'sales_foundation' ORDER BY tablename, policyname`,
    sequences: `SELECT c.relname, format_type(s.seqtypid, NULL) AS type,
        s.seqstart::text, s.seqincrement::text, s.seqmax::text, s.seqmin::text, s.seqcache::text, s.seqcycle
      FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'sales_foundation' ORDER BY c.relname`,
  };
  return Object.fromEntries(await Promise.all(Object.entries(queries).map(async ([name, sql]) =>
    [name, (await db.query(sql)).rows])));
}

module.exports = { schemaSnapshot };
