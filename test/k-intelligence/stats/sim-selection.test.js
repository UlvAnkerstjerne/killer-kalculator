'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { select, runAll, CONFIG } = require('./sim-harness');
const { defaults } = require('../../../lib/k-intelligence/stats');
const { fixture } = require('./helpers');

// Synthetic result sets: one null cell per scenario and four power cells per family.
function results({ nullRates, trendPower, shiftPower }) {
  const out = { 'null cell': { kind: 'null', rates: nullRates } };
  ['t1', 't2', 't3', 't4'].forEach((id, i) => { out[`trend ${id}`] = { kind: 'trend', rates: Object.fromEntries(Object.entries(trendPower).map(([m, v]) => [m, v[i]])) }; });
  ['s1', 's2', 's3', 's4'].forEach((id, i) => { out[`shift ${id}`] = { kind: 'shift', rates: Object.fromEntries(Object.entries(shiftPower).map(([m, v]) => [m, v[i]])) }; });
  return out;
}
const flat = v => [v, v, v, v];

test('selection: a candidate above 0.07 in any null cell is discarded; none surviving means no winner', () => {
  const s = select(results({ nullRates: { A: 0.0701, B: 0.2, C1: 0.071, C2: 0.5 },
    trendPower: { A: flat(0.9), B: flat(0.5) }, shiftPower: { C1: flat(0.9), C2: flat(0.5) } }));
  assert.equal(s.trend.winner, null);
  assert.equal(s.changePoint.winner, null);
  assert.match(s.trend.reason, /no candidate/);
});

test('selection: exactly 0.07 passes (limit is "greater than")', () => {
  const s = select(results({ nullRates: { A: 0.07, B: 0.2, C1: 0.07, C2: 0.2 },
    trendPower: { A: flat(0.3), B: flat(0.9) }, shiftPower: { C1: flat(0.3), C2: flat(0.9) } }));
  assert.equal(s.trend.winner, 'A'); assert.equal(s.changePoint.winner, 'C1');
});

test('selection: a single survivor wins regardless of power', () => {
  const s = select(results({ nullRates: { A: 0.2, B: 0.05, C1: 0.05, C2: 0.2 },
    trendPower: { A: flat(0.99), B: flat(0.1) }, shiftPower: { C1: flat(0.1), C2: flat(0.99) } }));
  assert.equal(s.trend.winner, 'B'); assert.equal(s.changePoint.winner, 'C1');
});

test('selection: both survive -> higher mean power wins; within 0.02 the tie goes to B (trend) and C1 (change point)', () => {
  const higher = select(results({ nullRates: { A: 0.05, B: 0.05, C1: 0.05, C2: 0.05 },
    trendPower: { A: flat(0.30), B: flat(0.27) }, shiftPower: { C1: flat(0.30), C2: flat(0.34) } }));
  assert.equal(higher.trend.winner, 'A');           // 0.03 apart: A is higher
  assert.equal(higher.changePoint.winner, 'C2');
  const tie = select(results({ nullRates: { A: 0.05, B: 0.05, C1: 0.05, C2: 0.05 },
    trendPower: { A: flat(0.31), B: flat(0.30) }, shiftPower: { C1: flat(0.30), C2: flat(0.32) } }));
  assert.equal(tie.trend.winner, 'B');              // 0.01 apart: simpler B
  assert.equal(tie.changePoint.winner, 'C1');       // exactly 0.02 apart is still a tie
  assert.match(tie.trend.reason, /tie/);
});

test('selection: only null cells with ANY method above the limit count against that method (all null cells are used)', () => {
  const r = results({ nullRates: { A: 0.05, B: 0.05, C1: 0.05, C2: 0.05 }, trendPower: { A: flat(0.3), B: flat(0.3) }, shiftPower: { C1: flat(0.3), C2: flat(0.3) } });
  r['second null'] = { kind: 'null', rates: { A: 0.2, B: 0.05, C1: 0.05, C2: 0.05 } };
  assert.equal(select(r).trend.winner, 'B');
});

test('harness smoke: tiny run produces finite rates for every cell and method, and is deterministic', () => {
  const a = runAll({ nullReps: 6, powerReps: 6 }), b = runAll({ nullReps: 6, powerReps: 6 });
  assert.deepEqual(a, b);
  assert.equal(Object.keys(a).length, 16);
  for (const cell of Object.values(a)) for (const rate of Object.values(cell.rates)) assert.ok(rate >= 0 && rate <= 1);
});

test('recorded full run (2000/1000 replicates, B=199) selects NO winner, so no default may be wired', () => {
  const recorded = fixture('sim-results-2026-10-10.json');
  assert.equal(recorded.config.nullReps, CONFIG.nullReps);
  assert.equal(recorded.config.powerReps, CONFIG.powerReps);
  assert.equal(recorded.config.fprLimit, 0.07);
  const s = select(recorded.results);
  assert.equal(s.trend.winner, null);
  assert.equal(s.changePoint.winner, null);
  assert.deepEqual(s, recorded.selection);
  assert.equal(defaults.trendMethod, null, 'a trend default requires a passing pre-registered winner');
  assert.equal(defaults.changePointPhiFit, null, 'a change-point default requires a passing pre-registered winner');
});
