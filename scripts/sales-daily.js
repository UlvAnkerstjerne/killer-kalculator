#!/usr/bin/env node
'use strict';
const { readRuntime } = require('../lib/sales-worker/config');
const { dailyScope, runDaily, MAX_DURATION_MS } = require('../lib/sales-worker/daily');
const { fail, safeError } = require('../lib/sales-sync/errors');
async function main(args = process.argv.slice(2), env = process.env, output = line => process.stdout.write(line + '\n'), dependencies = {}) {
  const controller = new AbortController(), stop = () => controller.abort();
  const timeout = setTimeout(stop, MAX_DURATION_MS);timeout.unref();
  // A stuck driver cannot keep a cron instance alive forever. A killed process
  // leaves durable audit/checkpoints; the next owner must reconcile them.
  const hardStop = setTimeout(() => process.exit(1), MAX_DURATION_MS + 30000);hardStop.unref();
  process.on('SIGINT', stop);process.on('SIGTERM', stop);
  try {
    if (args.length > 1 || !['--apply','--readiness'].includes(args[0])) fail('INVALID_OPTIONS');
    if (![undefined,'false','true'].includes(env.KK_SALES_SYNC_ENABLED)) fail('INVALID_CONFIG');
    const apply = args[0] === '--apply', enabled = env.KK_SALES_SYNC_ENABLED === 'true';
    if (apply && !enabled) { output(JSON.stringify({ kind:'daily-sales',status:'disabled' }));return 0; }
    const now = dependencies.now || (()=>new Date());
    const scope = dailyScope(env.KK_SALES_SYNC_STORES,env.KK_SALES_DAILY_FROM,now());
    const runtime = readRuntime({apply:true,scope:{stores:[scope.store]}},env);
    const result = await runDaily({store:scope.store,from:scope.from,apply,enabled,...runtime,signal:controller.signal,now,
      requestFor:dependencies.requestFor,emit:value=>output(JSON.stringify(value))});
    output(JSON.stringify(result));
    return ['incomplete','gaps'].includes(result.status) ? 1 : 0;
  } catch(error) {output(JSON.stringify({kind:'daily-sales',status:'incomplete',code:safeError(error).code}));return 1;}
  finally {clearTimeout(timeout);clearTimeout(hardStop);process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
if(require.main===module)main().then(code=>{process.exitCode=code;});
module.exports={main};
