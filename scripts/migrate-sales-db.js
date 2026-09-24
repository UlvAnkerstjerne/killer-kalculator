'use strict';
const { readConfig } = require('../lib/sales-db/config');
const { createDatabase } = require('../lib/sales-db/database');
const { migrate } = require('../lib/sales-db/migrate');
const { sanitized } = require('../lib/sales-db/errors');
async function main() {
  let database;
  try {
    database = createDatabase(readConfig());
    const result = await migrate(database);
    console.log(`Sales foundation migrations: ${result.applied} applied, ${result.total} total`);
  } catch (error) {
    console.error(sanitized(error).code);
    process.exitCode = 1;
  } finally { if (database) await database.close(); }
}
main();
