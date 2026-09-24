'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fail } = require('./errors');
const MIGRATION_LOCK = [1935764581, 1];
const DEFAULT_DIRECTORY = path.join(__dirname, '../../migrations/sales-db');
async function migrate(database, directory = DEFAULT_DIRECTORY) {
  const names = (await fs.readdir(directory)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!names.length || new Set(names.map(name => name.slice(0, 3))).size !== names.length) fail('MIGRATION_MISMATCH');
  const files = await Promise.all(names.map(async name => {
    const sql = await fs.readFile(path.join(directory, name), 'utf8');
    return { version: name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
  return database.transaction(async session => {
    // Transaction-scoped lock on this same independent session also protects
    // first bootstrap. Rollback/connection termination releases it automatically.
    await session.query('SELECT pg_advisory_xact_lock($1, $2)', MIGRATION_LOCK);
    await session.query('CREATE SCHEMA IF NOT EXISTS sales_foundation');
    await session.query(`CREATE TABLE IF NOT EXISTS sales_foundation.schema_migration (
      version text PRIMARY KEY, checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    const { rows } = await session.query('SELECT version, checksum FROM sales_foundation.schema_migration ORDER BY version');
    // Only an exact applied prefix is accepted; no old binary on a newer schema.
    if (rows.some((row, i) => files[i]?.version !== row.version || files[i]?.checksum !== row.checksum)) fail('MIGRATION_MISMATCH');
    for (const file of files.slice(rows.length)) {
      await session.query(file.sql);
      await session.query('INSERT INTO sales_foundation.schema_migration (version, checksum) VALUES ($1, $2)', [file.version, file.checksum]);
    }
    return { applied: files.length - rows.length, total: files.length };
  });
}
module.exports = { migrate, MIGRATION_LOCK };
