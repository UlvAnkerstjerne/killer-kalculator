'use strict';
// Simulation harness for the T1-S2 pre-registered comparison. Not a test file (no .test.js suffix).
//
// PRE-REGISTRATION (fixed before any result was produced; do not change after seeing results):
//   Candidates   trend:        A = 'sieve-bootstrap'   B = 'prewhitened-mk'
//                change-point: C1 = phiFit 'global'    C2 = phiFit 'segment'
//   Null cells   n in {52, 90} x { AR(1) phi 0, 0.3, 0.6 with N(0,1) innovations,
//                                  AR(2) phi1 0.5, phi2 0.2 with Student-t(df=4) innovations }   (8 cells)
//   Power cells  n in {52, 90}, AR(1) phi 0.3, N(0,1) innovations (innovation SD = 1):
//                  trend: total linear change 0.5 and 1.0 SD over the window
//                  shift: level shift of 0.5 and 1.0 SD starting at index floor(0.4 n)               (8 cells)
//   Rejection    p < 0.05. FPR limit 0.07. Replicates: 2000 per null cell, 1000 per power cell, B = 199.
//   Selection    Trend: discard any candidate with FPR > 0.07 in ANY null cell; among survivors take the higher
//                mean power over the four trend power cells; difference <= 0.02 -> B.
//                Change-point: same rule over the four shift power cells; difference <= 0.02 -> C1.
//                If no candidate survives: report "no winner" and stop (thresholds are never adjusted).
const { createRng, trendTest, detectMeanShift } = require('../../../lib/k-intelligence/stats');

const CONFIG = Object.freeze({
  alpha: 0.05, fprLimit: 0.07, tieMargin: 0.02, nullReps: 2000, powerReps: 1000, bootstrapReps: 199,
  minSegment: 8, sizes: [52, 90], shiftStart: 0.4, seedBase: 20261010,
});

const METHODS = Object.freeze({
  A: { family: 'trend', label: 'A sieve-bootstrap trend', run: (x, rng) => trendTest(x, { method: 'sieve-bootstrap', bootstrapReps: CONFIG.bootstrapReps, rng }).p },
  B: { family: 'trend', label: 'B AR(1) pre-whitened MK', run: x => trendTest(x, { method: 'prewhitened-mk' }).p },
  C1: { family: 'changePoint', label: 'C1 shift, phi from global residuals', run: (x, rng) => detectMeanShift(x, { phiFit: 'global', minSegment: CONFIG.minSegment, bootstrapReps: CONFIG.bootstrapReps, rng }).pValue },
  C2: { family: 'changePoint', label: 'C2 shift, phi from segment residuals', run: (x, rng) => detectMeanShift(x, { phiFit: 'segment', minSegment: CONFIG.minSegment, bootstrapReps: CONFIG.bootstrapReps, rng }).pValue },
});

function studentT4(rng) {
  const z = rng.normal();
  let chi = 0;
  for (let i = 0; i < 4; i++) { const g = rng.normal(); chi += g * g; }
  return z / Math.sqrt(chi / 4);
}

// AR(p) path (p <= 2) with 100 burn-in steps; innovations 'normal' (SD 1) or 't4' (SD sqrt 2).
function arSeries(n, phi, innovations, rng) {
  const draw = innovations === 't4' ? () => studentT4(rng) : () => rng.normal();
  let a = 0, b = 0;
  const out = new Array(n);
  for (let i = -100; i < n; i++) {
    const v = (phi[0] || 0) * a + (phi[1] || 0) * b + draw();
    b = a; a = v;
    if (i >= 0) out[i] = v;
  }
  return out;
}

function buildCells() {
  const nullCells = [], powerCells = [];
  let index = 0;
  const seed = () => CONFIG.seedBase + 1009 * (++index);
  for (const n of CONFIG.sizes) {
    for (const phi of [0, 0.3, 0.6]) {
      nullCells.push({ id: `null n=${n} AR1 phi=${phi}`, kind: 'null', n, reps: CONFIG.nullReps, seed: seed(),
        make: rng => arSeries(n, [phi], 'normal', rng) });
    }
    nullCells.push({ id: `null n=${n} AR2(.5,.2) t4`, kind: 'null', n, reps: CONFIG.nullReps, seed: seed(),
      make: rng => arSeries(n, [0.5, 0.2], 't4', rng) });
  }
  for (const n of CONFIG.sizes) {
    for (const size of [0.5, 1.0]) {
      powerCells.push({ id: `trend n=${n} ${size}SD`, kind: 'trend', n, reps: CONFIG.powerReps, seed: seed(),
        make: rng => arSeries(n, [0.3], 'normal', rng).map((v, i) => v + size * i / (n - 1)) });
    }
    for (const size of [0.5, 1.0]) {
      powerCells.push({ id: `shift n=${n} ${size}SD`, kind: 'shift', n, reps: CONFIG.powerReps, seed: seed(),
        make: rng => arSeries(n, [0.3], 'normal', rng).map((v, i) => v + (i >= Math.floor(CONFIG.shiftStart * n) ? size : 0)) });
    }
  }
  return { nullCells, powerCells };
}

// Every method sees the SAME series in a cell (paired); each method has its own bootstrap stream.
function runCell(cell, methodIds, overrides = {}) {
  const reps = overrides.reps || cell.reps;
  const rng = createRng(cell.seed);
  const boot = Object.fromEntries(methodIds.map((id, k) => [id, createRng((cell.seed * 31 + k + 1) >>> 0)]));
  const rejected = Object.fromEntries(methodIds.map(id => [id, 0]));
  for (let r = 0; r < reps; r++) {
    const x = cell.make(rng);
    for (const id of methodIds) if (METHODS[id].run(x, boot[id]) < CONFIG.alpha) rejected[id]++;
  }
  return Object.fromEntries(methodIds.map(id => [id, rejected[id] / reps]));
}

function runAll({ methodIds = Object.keys(METHODS), nullReps, powerReps, onCell } = {}) {
  const { nullCells, powerCells } = buildCells();
  const results = {};
  for (const cell of [...nullCells, ...powerCells]) {
    const reps = cell.kind === 'null' ? nullReps : powerReps;
    results[cell.id] = { kind: cell.kind, reps: reps || cell.reps, rates: runCell(cell, methodIds, reps ? { reps } : {}) };
    if (onCell) onCell(cell.id, results[cell.id]);
  }
  return results;
}

const mean = values => values.reduce((a, b) => a + b, 0) / values.length;

// Pre-registered rule. `results` is the output of runAll.
function select(results) {
  const entries = Object.entries(results);
  const evaluate = ids => Object.fromEntries(ids.map(id => {
    const nullRates = entries.filter(([, c]) => c.kind === 'null').map(([cell, c]) => ({ cell, rate: c.rates[id] }));
    const violations = nullRates.filter(r => r.rate > CONFIG.fprLimit);
    return [id, { maxFpr: Math.max(...nullRates.map(r => r.rate)), violations, passes: violations.length === 0 }];
  }));
  const decide = (ids, powerKind, tieBreaker) => {
    const verdicts = evaluate(ids);
    const powerCells = entries.filter(([, c]) => c.kind === powerKind);
    for (const id of ids) verdicts[id].meanPower = mean(powerCells.map(([, c]) => c.rates[id]));
    const survivors = ids.filter(id => verdicts[id].passes);
    let winner = null, reason;
    if (survivors.length === 0) reason = 'no candidate passed the FPR limit in every null cell';
    else if (survivors.length === 1) { winner = survivors[0]; reason = `only ${winner} passed the FPR limit`; }
    else {
      const [first, second] = ids, diff = verdicts[first].meanPower - verdicts[second].meanPower;
      if (Math.abs(diff) <= CONFIG.tieMargin + 1e-12) { winner = tieBreaker; reason = `mean power within ${CONFIG.tieMargin} (${diff.toFixed(4)}): tie goes to ${tieBreaker}`; }
      else { winner = diff > 0 ? first : second; reason = `higher mean ${powerKind} power (${diff.toFixed(4)} difference)`; }
    }
    return { winner, reason, verdicts };
  };
  return { trend: decide(['A', 'B'], 'trend', 'B'), changePoint: decide(['C1', 'C2'], 'shift', 'C1') };
}

function formatTables(results, methodIds = Object.keys(METHODS)) {
  const lines = [];
  for (const kind of ['null', 'trend', 'shift']) {
    const cells = Object.entries(results).filter(([, c]) => c.kind === kind);
    lines.push('', kind === 'null' ? `FALSE-POSITIVE RATE at alpha ${CONFIG.alpha} (limit ${CONFIG.fprLimit})` : `POWER at alpha ${CONFIG.alpha}, ${kind} cells`);
    lines.push(['cell'.padEnd(26), ...methodIds.map(id => id.padStart(8))].join(' '));
    for (const [cell, c] of cells) lines.push([cell.padEnd(26), ...methodIds.map(id => c.rates[id].toFixed(4).padStart(8))].join(' '));
    if (kind !== 'null') lines.push(['mean'.padEnd(26), ...methodIds.map(id => mean(cells.map(([, c]) => c.rates[id])).toFixed(4).padStart(8))].join(' '));
    else lines.push(['max'.padEnd(26), ...methodIds.map(id => Math.max(...cells.map(([, c]) => c.rates[id])).toFixed(4).padStart(8))].join(' '));
  }
  return lines.join('\n');
}

module.exports = { CONFIG, METHODS, buildCells, runCell, runAll, select, formatTables, arSeries };
