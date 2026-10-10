'use strict';
// Informational (NOT part of the pre-registered selection): empirical coverage of the 95% slope interval.
// Truth: a linear trend of total change 1.0 innovation SD over the window plus AR(1) noise (phi 0.3 / 0.6, N(0,1)).
// Compares trendInterval (sieve-bootstrap percentile) with Sen's independence interval.
// Usage: node test/k-intelligence/stats/interval-coverage.js [replicates=300]
const { createRng, trendInterval } = require('../../../lib/k-intelligence/stats');
const { arSeries } = require('./sim-harness');

const reps = Number(process.argv[2]) || 300, B = 199;
console.log(`interval coverage, ${reps} replicates/cell, bootstrap ${B}, nominal 0.95`);
console.log('cell                    bootstrap  Sen-independence  (mean width: bootstrap / Sen)');
let seed = 91000;
for (const n of [52, 90]) for (const phi of [0.3, 0.6]) {
  const rng = createRng(seed++), boot = createRng(seed++ + 500);
  const trueSlope = 1.0 / (n - 1);
  let hitBoot = 0, hitSen = 0, wBoot = 0, wSen = 0;
  for (let r = 0; r < reps; r++) {
    const x = arSeries(n, [phi], 'normal', rng).map((v, i) => v + i * trueSlope);
    const iv = trendInterval(x, { bootstrapReps: B, rng: boot });
    const sen = iv.referenceIndependenceCi;
    if (iv.low <= trueSlope && trueSlope <= iv.high) hitBoot++;
    if (sen.low <= trueSlope && trueSlope <= sen.high) hitSen++;
    wBoot += iv.high - iv.low; wSen += sen.high - sen.low;
  }
  console.log(`n=${n} AR1 phi=${phi}`.padEnd(24), (hitBoot / reps).toFixed(3).padStart(9), (hitSen / reps).toFixed(3).padStart(17),
    `   (${(wBoot / reps).toExponential(2)} / ${(wSen / reps).toExponential(2)})`);
}
