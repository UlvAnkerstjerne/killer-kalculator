'use strict';
const { fail } = require('./errors');

const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 16;
// Small, bounded JSON grammar. Every number remains its source lexeme; only
// quoted JSON strings use JSON.parse. No reviver/global numeric parser is used.
function parseLossless(text, { maxBytes = MAX_PAGE_BYTES, maxDepth = MAX_DEPTH } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PAGE_BYTES ||
      !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_DEPTH) fail('INVALID_OPTIONS');
  if (typeof text !== 'string') fail('INVALID_JSON');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) fail('PAGE_TOO_LARGE');
  let i = 0, nodes = 0;
  const white = () => { while (/[\x20\t\r\n]/.test(text[i] || '\0')) i++; };
  function string() {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') {
        if (i - start > 65536) fail('INVALID_JSON');
        try {
          const result = JSON.parse(text.slice(start, i));
          // PostgreSQL cannot represent NUL; unpaired surrogates are invalid UTF-8.
          if (/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(result)) fail('INVALID_JSON');
          return result;
        } catch { fail('INVALID_JSON'); }
      }
    }
    fail('INVALID_JSON');
  }
  function value(depth) {
    white(); if (depth > maxDepth || ++nodes > 1000000) fail('INVALID_JSON');
    const c = text[i];
    if (c === '"') return string();
    if (c === '{' || c === '[') {
      const object = c === '{', end = object ? '}' : ']'; i++; white();
      const result = object ? Object.create(null) : [];
      if (text[i] === end) { i++; return result; }
      while (true) {
        let key;
        if (object) {
          if (text[i] !== '"') fail('INVALID_JSON');
          key = string();
          if (['__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(result, key)) fail('INVALID_JSON');
          white(); if (text[i++] !== ':') fail('INVALID_JSON');
        }
        const child = value(depth + 1);
        if (object) result[key] = child; else result.push(child);
        white(); if (text[i] === end) { i++; return result; }
        if (text[i++] !== ',') fail('INVALID_JSON'); white();
      }
    }
    for (const [word, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i)) { i += word.length; return result; }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 130));
    if (!match || match[0].length > 128) fail('INVALID_JSON');
    i += match[0].length; return match[0];
  }
  const result = value(0); white(); if (i !== text.length) fail('INVALID_JSON');
  return result;
}
module.exports = { parseLossless, MAX_PAGE_BYTES, MAX_DEPTH };
