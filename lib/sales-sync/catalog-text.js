'use strict';
const { identifier, paymentCode, whitespaceOnly } = require('../sales-db/values');
const { fail } = require('./errors');

// Same acceptance boundary as PR #13. NFKC is used only for pattern detection;
// no normalized or rejected value is ever returned, stored or put on an error.
function legacyReason(value, kind) {
  if (typeof value !== 'string') return 'UNSUPPORTED_TYPE';
  if (!value.length) return 'EMPTY_TEXT';
  if (value.length > (kind === 'label' ? 160 : 64)) return 'LENGTH_LIMIT';
  if (/[\p{Cc}\p{Cf}]/u.test(value)) {
    if (/[\r\n]/.test(value)) return 'FORBIDDEN_LINE_BREAK';
    if (/\u001b/.test(value)) return 'ANSI_ESCAPE';
    if (/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)) return 'BIDI_FORMATTING';
    return /\p{Cc}/u.test(value) ? 'CONTROL_CHARACTER' : 'FORMAT_CONTROL';
  }
  const text = value.normalize('NFKC');
  if (/@/.test(text) || /[\w.+-]+\s*(?:@|\[at\]|\(at\))\s*[\w.-]+\.[a-z]{2,}/i.test(text) ||
      /https?:\/\/|www\.|\bBearer\s|-----BEGIN|\b(?:ghp_|github_pat_|sk_live_)/i.test(text) ||
      /\b[a-f0-9]{32,}\b/i.test(text) || /(?:\d[ -]?){13,19}/.test(text) ||
      /\b(?:customer|debtor|clerk|employee|cashier|card(?:number)?|phone|mobile|e-?mail|name|contact|kunde|kundenavn|navn|medarbejder|telefon|cpr|adresse|address|iban|password|secret|token|api[_ -]?key|authorization)\s*[:=#]/i.test(text) ||
      /\b(?:Mr|Mrs|Ms)\.\s+\p{L}+\s+\p{L}+/u.test(text) ||
      (kind === 'label' && /\+?\d(?:[\s().-]*\d){6,}/.test(text))) return 'SENSITIVE_PATTERN';
  try {
    if (kind === 'id') identifier(value);
    if (kind === 'code') paymentCode(value);
  } catch { return kind === 'id' ? 'INVALID_IDENTIFIER' : 'INVALID_PAYMENT_CODE'; }
  return null;
}
function reviewText(value, kind = 'label') {
  if (legacyReason(value, kind) || (kind === 'label' && whitespaceOnly(value))) fail('CATALOG_TEXT_REVIEW');
  return value;
}
// Only this field may be empty. Generic labels, IDs and codes keep their
// nonempty contracts; structural diagnostics still report EMPTY_TEXT.
function reviewProductLabel(value) { return value === '' ? '' : reviewText(value); }

const MAX_MEASURE_UNITS = 65536;
const MAX_CHARACTERS = 4;
const malformed = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
function inspectText(value, kind = 'label') {
  // Non-strings are never coerced, stringified, enumerated or traversed.
  if (typeof value !== 'string') return { reason: 'UNSUPPORTED_TYPE', utf16Length: null, characterLength: null,
    utf8ByteLength: null, lengthsCapped: false, offendingCharacters: [], charactersTruncated: false };
  const lengthsCapped = value.length > MAX_MEASURE_UNITS;
  let limit = MAX_MEASURE_UNITS;
  if (lengthsCapped && /[\uD800-\uDBFF]/u.test(value[limit - 1]) && /[\uDC00-\uDFFF]/u.test(value[limit])) limit--;
  const measured = lengthsCapped ? value.slice(0, limit) : value;
  const invalidUnicode = malformed.test(measured);
  let characterLength = 0, position = 0, controls = 0;
  const offendingCharacters = [];
  for (const char of measured) {
    characterLength++;
    // Reveal only non-content control/format code points or lone surrogates.
    // Never encode ordinary characters from a name, secret or transaction as hex.
    if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(char)) {
      controls++;
      if (offendingCharacters.length < MAX_CHARACTERS) offendingCharacters.push({ position,
        codePoint: 'U+' + char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') });
    }
    position += char.length;
  }
  const utf8ByteLength = invalidUnicode ? null : Buffer.byteLength(measured, 'utf8');
  let reason = legacyReason(lengthsCapped ? measured : value, kind);
  // Additional refusals are confined to this explicit structural-only mode.
  if (invalidUnicode) reason = 'INVALID_UNICODE';
  else if (!reason && utf8ByteLength > (kind === 'label' ? 320 : 64)) reason = 'UTF8_BYTE_LIMIT';
  else if (!reason && (/[|`<>\u2028\u2029]/u.test(measured) || /^\s*=/.test(measured) ||
      /^\s*[+-]\s*(?:\d|[A-Za-z_][\w.]*\s*\()/.test(measured) ||
      /["'](?:order(?:line)?(?:id)?|transaction(?:id)?|customer|card|clerk|headers|token|identityKey|sourceKey|fingerprint)["']\s*:/i.test(measured))) reason = 'UNSAFE_OUTPUT_SEQUENCE';
  if (!reason) return null;
  return { reason, utf16Length: measured.length, characterLength, utf8ByteLength, lengthsCapped,
    offendingCharacters, charactersTruncated: controls > MAX_CHARACTERS || lengthsCapped };
}
module.exports = { reviewText, reviewProductLabel, inspectText };
