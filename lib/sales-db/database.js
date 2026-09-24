'use strict';
const { Pool } = require('pg');
const { fail, sanitized, FoundationError } = require('./errors');

function createDatabase(config) {
  if (!config?.enabled) fail('DB_DISABLED');
  const pool = new Pool({
    connectionString: config.connectionString,
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 20000,
    application_name: 'kk-sales-foundation',
  });
  // pg removes broken idle clients. Suppress raw driver diagnostics, which can
  // contain credentials or row details. Expose only aggregate health information.
  let idleErrors = 0;
  pool.on('error', () => { idleErrors++; });
  let closed = false;
  async function withSession(work) {
    if (closed) throw new FoundationError('DB_UNAVAILABLE');
    let client;
    let broken = false;
    try {
      client = await pool.connect();
      return await work({ query: async (text, values = []) => {
        if (typeof text !== 'string' || !Array.isArray(values)) fail();
        try { return await client.query(text, values); }
        catch (error) { throw sanitized(error); }
      } });
    } catch (error) {
      // A failed transaction must never return to the pool still open.
      if (client) {
        try { await client.query('ROLLBACK'); } catch { broken = true; }
      }
      throw sanitized(error);
    } finally { if (client) client.release(broken); }
  }
  async function transaction(work) {
    return withSession(async session => {
      await session.query('BEGIN');
      const result = await work(session);
      await session.query('COMMIT');
      return result;
    });
  }
  return Object.freeze({
    withSession, transaction,
    query: (text, values) => withSession(session => session.query(text, values)),
    health: () => ({ idleErrors, total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, closed }),
    close: async () => { if (!closed) { closed = true; await pool.end(); } },
  });
}
module.exports = { createDatabase };
