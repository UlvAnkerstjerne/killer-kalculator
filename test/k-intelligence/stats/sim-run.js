'use strict';
// Full pre-registered simulation (2000 / 1000 replicates, B = 199). Usage: npm run sim:kintel [-- --json out.json]
const fs = require('node:fs');
const { CONFIG, runAll, select, formatTables } = require('./sim-harness');

const started = Date.now();
console.log(`T1-S2 pre-registered simulation: null ${CONFIG.nullReps}, power ${CONFIG.powerReps} replicates, bootstrap ${CONFIG.bootstrapReps}`);
const results = runAll({ onCell: (id, c) => process.stderr.write(`  done ${id} (${((Date.now() - started) / 1000).toFixed(0)}s)\n`) });
console.log(formatTables(results));
const selection = select(results);
console.log('\nPRE-REGISTERED SELECTION');
for (const [family, s] of Object.entries(selection)) {
  console.log(`${family}: winner = ${s.winner === null ? 'NONE' : s.winner} (${s.reason})`);
  for (const [id, v] of Object.entries(s.verdicts)) console.log(`   ${id}: max FPR ${v.maxFpr.toFixed(4)}, passes=${v.passes}, mean power ${v.meanPower.toFixed(4)}`);
}
console.log(`\nelapsed ${((Date.now() - started) / 1000).toFixed(1)} s`);
const jsonIndex = process.argv.indexOf('--json');
if (jsonIndex > 0) fs.writeFileSync(process.argv[jsonIndex + 1], JSON.stringify({ config: CONFIG, results, selection }, null, 1));
