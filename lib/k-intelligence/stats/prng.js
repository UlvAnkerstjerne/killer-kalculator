'use strict';
// Deterministic in-repo PRNG: xoshiro128** seeded through splitmix32.
// Never uses Math.random, so every simulation and bootstrap is reproducible.
const { integer, fail } = require('./validate');

function splitmix32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

function createRng(seed = 1) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) fail('INVALID_OPTION', 'seed must be an integer in [0, 2^32 - 1]');
  const sm = splitmix32(seed);
  let s0 = sm(), s1 = sm(), s2 = sm(), s3 = sm();
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;
  const rotl = (x, k) => (x << k) | (x >>> (32 - k));
  function nextUint32() {
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = s1 << 9;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11);
    return result;
  }
  // 53-bit uniform in [0, 1).
  function uniform() { return ((nextUint32() >>> 5) * 67108864 + (nextUint32() >>> 6)) / 9007199254740992; }
  // Unbiased integer in [0, n) by rejection sampling.
  function int(n) {
    integer(n, 'n', 1, 0xffffffff);
    const limit = 0x100000000 - (0x100000000 % n);
    let x;
    do { x = nextUint32(); } while (x >= limit);
    return x % n;
  }
  // Marsaglia polar method; the spare deviate is cached.
  let spare = null;
  function normal() {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u, v, q;
    do { u = 2 * uniform() - 1; v = 2 * uniform() - 1; q = u * u + v * v; } while (q >= 1 || q === 0);
    const f = Math.sqrt(-2 * Math.log(q) / q);
    spare = v * f;
    return u * f;
  }
  return { uniform, int, normal, nextUint32 };
}

module.exports = { createRng };
