'use strict';
const { createHmac } = require('node:crypto');
const { storeId } = require('./values');
const { fail } = require('./errors');
function framed(parts) {
  return Buffer.concat(parts.flatMap(part => {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    return [length, bytes];
  }));
}
function createIdentity({ key, version }) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !Number.isInteger(version) || version < 1 || version > 32767) fail();
  const secret = Buffer.from(key);
  const digest = parts => createHmac('sha256', secret).update(framed(parts)).digest();
  const check = digest(['kk.sales.identity.check.v1', String(version)]);
  return Object.freeze({ version, check: () => Buffer.from(check),
    protect(storeSlug, sourceLineId) {
      storeId(storeSlug);
      // Numeric IDs have a canonical decimal spelling; synthetic fixture IDs
      // are explicitly supported. No trimming/coercion or ambiguous framing.
      if (typeof sourceLineId !== 'string' ||
          !/^(?:0|[1-9]\d{0,63}|[A-Za-z][A-Za-z0-9_-]{0,63})$/.test(sourceLineId)) fail();
      return digest(['kk.sales.line.v1', storeSlug, sourceLineId]);
    },
  });
}
module.exports = { createIdentity };
