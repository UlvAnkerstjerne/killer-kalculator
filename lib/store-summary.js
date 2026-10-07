'use strict';
// Normalized KPI summary for server-to-server consumers (Killer Kockpit).
// Every number is derived with the dashboard's own definitions so the two
// surfaces reconcile exactly:
//   revenue   — SUM(priceexclvat) over the same sales-range lines (no VAT division)
//   products  — canonical lib/product-metrics computeMetrics (reviewed IDs,
//               zero-price staff meals excluded, signed refunds)
//   salary    — Planday salary cost for the store; 0/missing is "unavailable",
//               exactly as the dashboard's `salaries[storeId] || null`
// Raw sales lines never leave this module.
const { computeMetrics } = require('./product-metrics');

const round2 = n => Math.round(n * 100) / 100;

function buildStoreSummaryMetrics(lines, salaryCost) {
  const revenue = lines.reduce((sum, line) => sum + (line.priceexclvat || 0), 0);
  const m = computeMetrics(lines);
  const salary = typeof salaryCost === 'number' && Number.isFinite(salaryCost) && salaryCost ? salaryCost : null;
  const salaryPct = revenue && salary ? salary / revenue * 100 : null;
  return {
    revenueExVat:  round2(revenue),
    salaryCost:    salary,
    salaryPct:     salaryPct === null ? null : round2(salaryPct),
    rollUnits:     m.rollUnits,
    komboUnits:    m.komboUnits,
    komboPct:      m.komboPct === null ? null : round2(m.komboPct),
    lemonadeUnits: m.lemUnits,
  };
}

// Public source vocabulary: Kockpit never needs to know provider names.
function publicSource(source) {
  if (source === 'database' || source === 'hybrid') return source;
  if (source === 'onlinepos') return 'provider';
  return null;
}

module.exports = { buildStoreSummaryMetrics, publicSource };
