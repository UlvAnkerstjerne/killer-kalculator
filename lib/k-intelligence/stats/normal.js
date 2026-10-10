'use strict';
// Standard normal distribution, implemented in-repo.
//
// erfc uses two relative-accuracy-preserving branches (no 1 - erf cancellation in the tail):
//   |x| < 2   non-alternating series   erf(x) = 2/sqrt(pi) * exp(-x^2) * sum_k 2^k x^(2k+1) / (2k+1)!!
//   |x| >= 2  Laplace continued fraction (evaluated backwards, fixed depth)
//             erfc(x) = exp(-x^2) / sqrt(pi) / (x + (1/2)/(x + (2/2)/(x + (3/2)/(x + ...))))
// The quantile is a rational first guess refined by Halley steps on the accurate CDF.
const { finiteNumber, fail } = require('./validate');

const SQRT_PI = Math.sqrt(Math.PI);
const SQRT_2 = Math.SQRT2;
const SQRT_2PI = Math.sqrt(2 * Math.PI);
const CF_DEPTH = 300;

function erfcPositive(x) {
  if (x < 2) {
    const x2 = x * x;
    let term = x, sum = x;
    for (let k = 1; k < 200; k++) {
      term *= 2 * x2 / (2 * k + 1);
      sum += term;
      if (term < sum * 1e-17) break;
    }
    return 1 - (2 / SQRT_PI) * Math.exp(-x2) * sum;
  }
  let f = x;
  for (let k = CF_DEPTH; k >= 1; k--) f = x + (k / 2) / f;
  return Math.exp(-x * x) / SQRT_PI / f;
}

function erfc(x) {
  finiteNumber(x, 'x');
  if (x === 0) return 1;
  return x > 0 ? erfcPositive(x) : 2 - erfcPositive(-x);
}

// Lower tail P(Z <= z).
function normalCdf(z) { finiteNumber(z, 'z'); return 0.5 * erfc(-z / SQRT_2); }
// Upper tail P(Z > z); keeps relative accuracy for large positive z.
function normalSf(z) { finiteNumber(z, 'z'); return 0.5 * erfc(z / SQRT_2); }
function normalPdf(z) { finiteNumber(z, 'z'); return Math.exp(-0.5 * z * z) / SQRT_2PI; }
// Two-sided p-value 2 * P(Z > |z|).
function twoSidedP(z) { finiteNumber(z, 'z'); return erfc(Math.abs(z) / SQRT_2); }

// Inverse CDF. p must be in (0, 1).
function normalQuantile(p) {
  finiteNumber(p, 'p');
  if (!(p > 0 && p < 1)) fail('INVALID_INPUT', 'p must be in (0, 1)');
  if (p === 0.5) return 0;
  if (p > 0.5) return -normalQuantile(1 - p);
  // Abramowitz & Stegun 26.2.23 first guess for the lower tail, then Halley refinement.
  const t = Math.sqrt(-2 * Math.log(p));
  let x = -(t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t));
  for (let i = 0; i < 8; i++) {
    const e = normalCdf(x) - p;
    const u = e * SQRT_2PI * Math.exp(0.5 * x * x);
    const step = u / (1 + 0.5 * x * u);
    x -= step;
    if (Math.abs(step) < 1e-15 * Math.max(1, Math.abs(x))) break;
  }
  return x;
}

module.exports = { erfc, normalCdf, normalSf, normalPdf, twoSidedP, normalQuantile };
