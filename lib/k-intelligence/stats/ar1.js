'use strict';
// AR(1) sieve ingredients shared by the change-point test and the trend test/interval.
//
// fitAr1: lag-1 Yule-Walker on the mean-removed input, Kendall's small-sample bias correction
//   phi_c = phi + (1 + 3 phi) / n, clamped to [PHI_MIN, PHI_MAX]; innovations are the centred AR residuals.
// simulateAr1: stationary-ish AR(1) path built from RESAMPLED innovations (50-step burn-in).
const PHI_MIN = -0.9, PHI_MAX = 0.95, BURN_IN = 50;

function fitAr1(x) {
  const n = x.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  let c0 = 0, c1 = 0;
  for (let i = 0; i < n; i++) c0 += (x[i] - mean) * (x[i] - mean);
  for (let i = 1; i < n; i++) c1 += (x[i] - mean) * (x[i - 1] - mean);
  const rawPhi = c0 > 0 ? c1 / c0 : 0;
  const phi = Math.min(PHI_MAX, Math.max(PHI_MIN, rawPhi + (1 + 3 * rawPhi) / n));
  const residuals = new Float64Array(n - 1);
  let rMean = 0;
  for (let i = 1; i < n; i++) { residuals[i - 1] = (x[i] - mean) - phi * (x[i - 1] - mean); rMean += residuals[i - 1]; }
  rMean /= n - 1;
  for (let i = 0; i < n - 1; i++) residuals[i] -= rMean;
  return { phi, rawPhi, residuals, degenerate: c0 === 0 };
}

// Fills `out` (length n) with an AR(1) path driven by innovations drawn with replacement from `residuals`.
function simulateAr1(phi, residuals, n, rng, out) {
  const m = residuals.length;
  let prev = 0;
  for (let i = 0; i < BURN_IN; i++) prev = phi * prev + residuals[rng.int(m)];
  for (let i = 0; i < n; i++) { prev = phi * prev + residuals[rng.int(m)]; out[i] = prev; }
  return out;
}

module.exports = { fitAr1, simulateAr1, PHI_MIN, PHI_MAX, BURN_IN };
