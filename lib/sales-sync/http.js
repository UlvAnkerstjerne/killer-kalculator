'use strict';
const https = require('node:https');
const { setTimeout: delay } = require('node:timers/promises');
const { TextDecoder } = require('node:util');
const { ORIGIN, PREFIX } = require('./traverse');
const { fail, ImportError, checkSignal } = require('./errors');
const { MAX_PAGE_BYTES } = require('./parse');

// Explicit CLI transport only. One request at a time, at most 30 starts/minute.
// No redirects, automatic JSON conversion, retry bodies, header logging or .env.
function createHttpRequest({ token, companyId }) {
  if (typeof token !== 'string' || !token.length || token.length > 4096 || /[\r\n]/.test(token) ||
      typeof companyId !== 'string' || !/^[1-9]\d{0,63}$/.test(companyId)) fail('INVALID_OPTIONS');
  let lastStart = 0;
  return async (url, { signal, maxBytes = MAX_PAGE_BYTES } = {}) => {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PAGE_BYTES) fail('INVALID_OPTIONS');
    let parsed;
    try { parsed = new URL(url); } catch { fail('UNSAFE_CONTINUATION'); }
    if (parsed.origin !== ORIGIN || parsed.username || parsed.password || parsed.hash ||
        !new RegExp('^' + PREFIX + '[0-9]+$').test(parsed.pathname)) fail('UNSAFE_CONTINUATION');
    checkSignal(signal);
    const pause = Math.max(0, lastStart + 2000 - Date.now());
    try { if (pause) await delay(pause, undefined, { signal }); } catch { fail('INTERRUPTED'); }
    checkSignal(signal); lastStart = Date.now();
    return new Promise((resolve, reject) => {
      const safeReject = code => reject(new ImportError(code));
      const req = https.get(parsed, { signal, headers: { token, firmaid: companyId, Accept: 'application/json', 'Accept-Encoding': 'identity' } }, res => {
        res.on('error', () => safeReject(signal?.aborted ? 'INTERRUPTED' : 'UPSTREAM_FAILED'));
        res.on('aborted', () => safeReject('UPSTREAM_FAILED'));
        if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
          safeReject(res.statusCode === 429 ? 'UPSTREAM_RATE_LIMIT' : 'UPSTREAM_FAILED'); res.destroy(); return;
        }
        const chunks = []; let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) { safeReject('PAGE_TOO_LARGE'); res.destroy(); }
          else chunks.push(chunk);
        });
        res.on('end', () => {
          try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
          catch { safeReject('INVALID_JSON'); }
        });
      });
      const deadline = setTimeout(() => { safeReject('UPSTREAM_FAILED'); req.destroy(); }, 20000);
      req.on('close', () => clearTimeout(deadline));
      req.on('error', () => safeReject(signal?.aborted ? 'INTERRUPTED' : 'UPSTREAM_FAILED'));
    });
  };
}
module.exports = { createHttpRequest };
