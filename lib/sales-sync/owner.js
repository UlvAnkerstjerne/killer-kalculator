'use strict';
const { Client } = require('pg');
const { fail, safeError } = require('./errors');
// Shares Stage 1's publication lock, so the manual CLI also excludes foundation
// writers. This is ownership of one finite import, not a recurring worker leader.
const IMPORT_LOCK = Object.freeze([1935764581, 2]);
async function withImportOwner(config, work) {
  if (!config?.enabled) fail('DB_DISABLED');
  const client = new Client({ connectionString: config.connectionString,
    connectionTimeoutMillis: 5000, statement_timeout: 15000,
    idle_in_transaction_session_timeout: 20000, application_name: 'kk-sales-backfill' });
  const controller = new AbortController();
  let lost = false;
  client.on('error', () => { lost = true; controller.abort(); });
  const query = async (sql, values = []) => {
    if (lost) fail('LOCK_LOST');
    try { return await client.query(sql, values); }
    catch { if (lost) fail('LOCK_LOST'); fail('DB_OPERATION_FAILED'); }
  };
  try {
    try { await client.connect(); } catch { fail('DB_OPERATION_FAILED'); }
    const { rows: [lock] } = await query('SELECT pg_try_advisory_lock($1, $2) AS acquired', IMPORT_LOCK);
    if (!lock.acquired) fail('IMPORTER_BUSY');
    const session = Object.freeze({ query, signal: controller.signal, transaction: async fn => {
      await query('BEGIN');
      try { const result = await fn(session); await query('COMMIT'); return result; }
      catch (error) { try { await query('ROLLBACK'); } catch {} throw safeError(error); }
    } });
    return await work(session);
  } catch (error) { throw safeError(error); }
  finally {
    // Ending this dedicated connection releases the lock even after cancellation
    // or a failed transaction. Never reacquire on a pooled/replacement connection.
    try { await client.end(); } catch {}
  }
}
module.exports = { withImportOwner, IMPORT_LOCK };
