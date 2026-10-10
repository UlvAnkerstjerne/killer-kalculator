'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function fixture(name) { return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')); }

// Relative-or-absolute closeness: |a-b| <= max(abs, rel*|b|).
function close(actual, expected, { rel = 1e-9, abs = 1e-12 } = {}, label = '') {
  const tolerance = Math.max(abs, rel * Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label} expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)}, tol ${tolerance})`);
}

function throwsCode(fn, code) {
  assert.throws(fn, error => { assert.equal(error.name, 'StatsError'); assert.equal(error.code, code, error.message); return true; });
}

module.exports = { fixture, close, throwsCode };
