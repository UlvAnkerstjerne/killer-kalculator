'use strict';

// Never retain driver causes, query parameters, row details or caller values.
const CODES = new Set([
  'INVALID_CONFIG', 'DB_DISABLED', 'DB_UNAVAILABLE', 'DB_OPERATION_FAILED',
  'INVALID_INPUT', 'UNREVIEWED_CATALOG', 'IDENTITY_MISMATCH',
  'MIGRATION_MISMATCH', 'INCOMPLETE_PUBLICATION', 'SOURCE_CONFLICT',
  'RECONCILIATION_REQUIRED', 'RUN_CONFLICT',
]);
class FoundationError extends Error {
  constructor(code) {
    const safe = CODES.has(code) ? code : 'DB_OPERATION_FAILED';
    super(safe);
    this.name = 'FoundationError';
    this.code = safe;
  }
}
function fail(code = 'INVALID_INPUT') { throw new FoundationError(code); }
function sanitized(error) {
  return error instanceof FoundationError ? error : new FoundationError('DB_OPERATION_FAILED');
}
module.exports = { FoundationError, fail, sanitized };
