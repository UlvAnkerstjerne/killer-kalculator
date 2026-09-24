'use strict';
const { createHash } = require('node:crypto');
const { range } = require('../sales-db/values');
const SCALE = 10n ** 18n;
function units(value) {
  const negative = value.startsWith('-');
  const [integer, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return (BigInt(integer) * SCALE + BigInt(fraction.padEnd(18, '0'))) * (negative ? -1n : 1n);
}
function amount(value) {
  const negative = value < 0n, abs = negative ? -value : value;
  const fraction = (abs % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + (abs / SCALE) + (fraction ? '.' + fraction : '');
}
function accumulator() {
  let count = 0, incl = 0n, excl = 0n, quantity = 0n, negativePrice = 0, negativeQuantity = 0;
  let refundIncl = 0n, refundExcl = 0n;
  const hash = createHash('sha256');
  return {
    add(line) {
      count++;
      const i = units(line.revenueIncl), e = units(line.revenueExcl), q = units(line.quantity);
      incl += i; excl += e; quantity += q;
      if (i < 0n || e < 0n) { negativePrice++; refundIncl += i; refundExcl += e; }
      if (q < 0n) negativeQuantity++;
      hash.update(line.sourceKey).update(line.fingerprint);
    },
    finish() { return { count, revenueIncl: amount(incl), revenueExcl: amount(excl), quantity: amount(quantity),
      negativePrice, negativeQuantity, refundIncl: amount(refundIncl), refundExcl: amount(refundExcl), digest: hash.digest() }; },
  };
}
// Input must be ordered by protected source key, independent of source ordering.
// At most 36,525 small date accumulators and one database batch are retained.
async function summarize(orderedLines, start, end) {
  const days = new Map(range(start, end, 36600).map(date => [date, accumulator()]));
  const total = accumulator();
  for await (const line of orderedLines) {
    if (line.businessDate < start || line.businessDate >= end) continue;
    total.add(line); days.get(line.businessDate).add(line);
  }
  return { total: total.finish(), days: [...days].map(([date, value]) => ({ date, ...value.finish() })) };
}
function sameSummary(a, b) {
  return ['count', 'revenueIncl', 'revenueExcl', 'quantity', 'negativePrice', 'negativeQuantity', 'refundIncl', 'refundExcl']
    .every(key => a[key] === b[key]) && a.digest.equals(b.digest);
}
function months(start, end) {
  const result = []; let cursor = start;
  while (cursor < end) {
    const year = Number(cursor.slice(0, 4)), month = Number(cursor.slice(5, 7));
    const next = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    const stop = next < end ? next : end;
    result.push({ start: cursor, end: stop }); cursor = stop;
  }
  return result;
}
module.exports = { units, amount, accumulator, summarize, sameSummary, months };
