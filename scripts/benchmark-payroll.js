'use strict';
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const { processPayroll, period, DEPARTMENTS, midnight, nextDate } = require('../lib/planday-payroll');
const { createPayrollService } = require('../lib/planday-service');
const { fixture } = require('../test/fixtures/planday.fixture');

async function main() {
  const rows = [];
  for (let day = 0; day < 31; day++) for (const departmentId of Object.keys(DEPARTMENTS)) for (let shift = 0; shift < 24; shift++) {
    const date = nextDate('2026-08-01', day), start = midnight(date) + 8 * 3600000;
    rows.push({ id: `fixture-${day}-${departmentId}-${shift}`, departmentId, start, end: start + 8 * 3600000, amount: 1200, source: 'actual', component: 'hourly' });
  }
  const window = period({ start: '2026-08-01', end: '2026-09-01' }, Date.parse('2026-09-23T12:00:00Z'));
  const times = [];
  for (let i = 0; i < 15; i++) {
    const start = performance.now(); const result = processPayroll({ records: rows }, window); times.push(performance.now() - start);
    assert.equal(result.chain.cost, rows.length * 1200); assert.equal(result.chain.complete, true);
  }
  let calls = 0; const f = fixture();
  const wait = () => new Promise(resolve => setTimeout(resolve, 25));
  const client = { all: async path => { calls++; await wait(); return path.includes('departments') ? f.departments : f.shifts; },
    get: async (_path, args) => { calls++; await wait(); return args.shiftStatus ? f.approved : f.payroll; } };
  const service = createPayrollService({ client, now: () => Date.parse('2026-09-24T12:00:00Z') });
  const args = { start: '2026-09-22', end: '2026-09-23' };
  const start = performance.now(); const results = await Promise.all(Array.from({ length: 20 }, () => service.get(args))); const coldMs = performance.now() - start;
  assert.equal(calls, 4); assert.ok(results.every(r => r.chain.cost === 1200));
  const warmStart = performance.now(); await service.get(args); const warmMs = performance.now() - warmStart; assert.equal(calls, 4);
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ kind: 'deterministic synthetic benchmark; milliseconds, no live providers', records: rows.length,
    totalCost: rows.length * 1200, runs: times.length, medianMs: times[7], p95Ms: times[14],
    concurrentRequests: 20, upstreamCalls: calls, coldMs, warmMs, responseBytes: Buffer.byteLength(JSON.stringify(results[0])), cache: service.sizes() }, null, 2));
}
main().catch(() => { console.error('PAYROLL_BENCHMARK_FAILED'); process.exitCode = 1; });
