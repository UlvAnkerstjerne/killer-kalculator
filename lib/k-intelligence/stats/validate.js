'use strict';
// Input validation shared by every statistics primitive. Nothing here coerces:
// NaN, Infinity, strings, undefined and holes are rejected, never repaired.

class StatsError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'StatsError';
    this.code = code;
  }
}

function fail(code, message) { throw new StatsError(code, message); }

function finiteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_INPUT', `${name} must be a finite number`);
  return value;
}

// Dense array of finite numbers. `min` is the smallest acceptable length.
function numberArray(values, name, min = 1) {
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) fail('INVALID_INPUT', `${name} must be an array`);
  if (values.length === 0) fail('EMPTY_INPUT', `${name} must not be empty`);
  for (let i = 0; i < values.length; i++) {
    if (typeof values[i] !== 'number' || !Number.isFinite(values[i])) fail('INVALID_INPUT', `${name}[${i}] must be a finite number`);
  }
  if (values.length < min) fail('INSUFFICIENT_DATA', `${name} needs at least ${min} values, got ${values.length}`);
  return values;
}

function integer(value, name, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < min || value > max) fail('INVALID_OPTION', `${name} must be an integer in [${min}, ${max}]`);
  return value;
}

function probability(value, name, openInterval = true) {
  finiteNumber(value, name);
  const ok = openInterval ? value > 0 && value < 1 : value >= 0 && value <= 1;
  if (!ok) fail('INVALID_OPTION', `${name} must be in ${openInterval ? '(0, 1)' : '[0, 1]'}`);
  return value;
}

// Calendar date label YYYY-MM-DD (no time zone arithmetic anywhere in this library).
function dateLabel(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('INVALID_INPUT', `${name} must be a YYYY-MM-DD date label`);
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('INVALID_INPUT', `${name} is not a real calendar date`);
  return value;
}

module.exports = { StatsError, fail, finiteNumber, numberArray, integer, probability, dateLabel };
