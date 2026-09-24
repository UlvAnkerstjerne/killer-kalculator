'use strict';
// Test-only subprocess. No HTTP implementation, provider token or production URL.
const { withImportOwner } = require('../../lib/sales-sync/owner');
const { importHistory } = require('../../lib/sales-sync/importer');
const { disposableConfig } = require('./disposable');
const { context, options, raw, body, initial } = require('./helpers');
const config = disposableConfig();
async function waitForKill() {
  process.send({ ready: true });
  await new Promise(() => { setInterval(() => {}, 1000); });
}
const task = process.argv[2] === 'scan'
  ? importHistory({ config, context, options, apply: true, request: async url => {
    if (url === initial) return body([raw()], 1, initial + '?page=2');
    await waitForKill(); return body([], 2);
  } })
  : withImportOwner(config, waitForKill);
task.catch(() => { process.exitCode = 1; });
