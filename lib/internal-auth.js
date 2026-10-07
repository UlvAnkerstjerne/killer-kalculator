'use strict';
// Server-to-server bearer token guard for the read-only internal API.
// Deliberately independent of the browser session, CSRF, CRON and provider
// credentials. Comparison is constant-time over fixed-length digests so the
// presented token's length is not observable either.
const crypto = require('crypto');

const MIN_TOKEN_LENGTH = 32;
const digest = value => crypto.createHash('sha256').update(String(value)).digest();

function createInternalTokenGuard(readExpectedToken) {
  return function requireInternalToken(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const expected = readExpectedToken();
    if (typeof expected !== 'string' || expected.length < MIN_TOKEN_LENGTH) {
      return res.status(503).json({ error: 'Internal read API not configured' });
    }
    const match = /^Bearer ([^\s]+)$/.exec(req.get('authorization') || '');
    const presented = match ? match[1] : '';
    const valid = crypto.timingSafeEqual(digest(presented), digest(expected));
    if (!match || !valid) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };
}

module.exports = { createInternalTokenGuard, MIN_TOKEN_LENGTH };
