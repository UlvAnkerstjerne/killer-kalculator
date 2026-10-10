'use strict';
// Benjamini-Hochberg (1995) step-up adjustment, valid for independent or positively dependent tests.
//   q_(i) = min over j >= i of  p_(j) * m / j ,  capped at 1
// Order is stable: ties in p are ranked by input position, and tied p-values always receive equal q.
// `familySize` (default = number of supplied p-values) is m, the TOTAL number of tests in the family;
// pass it when some tests in the family produced no p-value, so the penalty is not understated.
const { fail, integer, probability } = require('./validate');

function benjaminiHochberg(pValues, { familySize, alpha } = {}) {
  if (!Array.isArray(pValues)) fail('INVALID_INPUT', 'pValues must be an array');
  if (pValues.length === 0) fail('EMPTY_INPUT', 'pValues must not be empty');
  pValues.forEach((p, i) => {
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) fail('INVALID_INPUT', `pValues[${i}] must be a finite number in [0, 1]`);
  });
  const k = pValues.length;
  const m = familySize === undefined ? k : integer(familySize, 'familySize', k);
  if (alpha !== undefined) probability(alpha, 'alpha');

  const order = Array.from({ length: k }, (_, i) => i).sort((a, b) => pValues[a] - pValues[b] || a - b);
  const qValues = new Array(k);
  let running = 1;
  for (let rank = k; rank >= 1; rank--) {
    const index = order[rank - 1];
    running = Math.min(running, pValues[index] * m / rank);
    qValues[index] = running;
  }
  const result = { qValues, familySize: m, method: 'benjamini-hochberg' };
  if (alpha !== undefined) result.rejected = qValues.map(q => q <= alpha);
  return result;
}

module.exports = { benjaminiHochberg };
