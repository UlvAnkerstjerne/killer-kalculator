#!/usr/bin/env node
'use strict';
// Unified entry point: cron services set KK_SALES_DAILY_FROM.
if (process.env.KK_SALES_DAILY_FROM) {
  require('./scripts/sales-daily').main(['--apply']).then(code => { process.exitCode = code; });
} else {
  // Web server: exec replaces this process with server.js
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, ['server.js'], { stdio: 'inherit', cwd: __dirname });
}
