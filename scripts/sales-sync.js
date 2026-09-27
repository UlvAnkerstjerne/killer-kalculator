#!/usr/bin/env node
'use strict';
const { parseArgs, readOptions, readRuntime } = require('../lib/sales-worker/config');
const { runWorker } = require('../lib/sales-worker/worker');
const { safeError } = require('../lib/sales-sync/errors');

async function main(args = process.argv.slice(2), env = process.env, output = line => process.stdout.write(line + '\n'), dependencies = {}) {
  const controller = new AbortController(), stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const values = parseArgs(args);
    if (values['--help']) {
      output('Usage: node scripts/sales-sync.js [--plan | --dry-run | --apply] --store <slug> | --stores <comma-separated-slugs> [--from <inclusive-date>] [--through <exclusive-date>] [--max-days <1..7>]');
      return 0;
    }
    const now = dependencies.now || (() => new Date());
    const options = readOptions(values, env, now());
    const runtime = options.apply && !options.enabled ? {} : readRuntime(options, env);
    const result = await runWorker({ options, ...runtime, signal: controller.signal, now, requestFor: dependencies.requestFor });
    output(JSON.stringify(result));
    return result.status === 'incomplete' ? 1 : 0;
  } catch (error) { output(JSON.stringify({ status: 'incomplete', code: safeError(error).code })); return 1; }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { main };
