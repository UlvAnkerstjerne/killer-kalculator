'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const mode = process.argv[2];
const files = mode === 'regression' ? require('../package.json').scripts.test.split(' ').slice(2)
  : mode === 'foundation' ? ['test/sales-db/postgres.test.js']
    : mode === 'importer' ? ['test/sales-sync/postgres.test.js'] : null;
if (!files) throw new Error('Unknown test suite');
// Buffer diagnostics before displaying them. A failed assertion must not print
// row values, private canaries or an upstream object into durable Actions logs.
const result = spawnSync(process.execPath, ['--require', path.join(__dirname, '../test/sales-sync/network-guard.js'), '--test', '--test-reporter=tap', ...files], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 600000,
});
const output = (result.stdout || '') + (result.stderr || '');
const canaries = [['SYNTHETIC', 'PRIVATE', 'CANARY'].join('_'), ['SYNTHETIC', 'PRIVATE', 'IMPORTER', 'CANARY'].join('_')];
const leaked = canaries.some(value => output.includes(value));
if (leaked) console.log('Privacy canary scan: FAIL (diagnostics suppressed)');
else {
  for (const line of output.split('\n')) {
    if (/^\s*(# Subtest:|ok \d+ -|not ok \d+ -|# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b|# Real PostgreSQL integration server:)/.test(line)) console.log(line);
    if (/^# Synthetic importer memory result: \{["a-zA-Z0-9:, ]+\}$/.test(line)) console.log(line);
  }
  console.log('Privacy canary scan: PASS');
}
if (result.error) console.log('Test process failed or exceeded its bounded output/time limit');
process.exitCode = leaked || result.error || result.status !== 0 ? 1 : 0;
