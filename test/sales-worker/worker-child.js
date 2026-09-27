'use strict';
// Synthetic subprocess; no HTTP transport, live credentials or database fallback.
const { disposableConfig } = require('../sales-sync/disposable');
const { worker, row, body } = require('./helpers');
let calls = 0;
worker(disposableConfig(), { requestFor: () => async url => {
  if (++calls === 1) return body([row()], 1, url + '?page=2');
  process.send({ ready: true });
  await new Promise(() => { setInterval(() => {}, 1000); });
} }).then(() => { process.exitCode = 1; }).catch(() => { process.exitCode = 1; });
