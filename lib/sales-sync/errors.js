'use strict';

const CODES = new Set(['INVALID_OPTIONS', 'INVALID_CONFIG', 'DB_DISABLED', 'IDENTITY_MISMATCH', 'INVALID_IDENTITY',
  'INVALID_CATALOG', 'INVALID_PAGE', 'PAGE_TOO_LARGE', 'INVALID_JSON', 'UNSAFE_CONTINUATION',
  'PAGINATION_LOOP', 'PAGE_LIMIT', 'ROW_LIMIT', 'INVALID_LINE', 'STORE_MISMATCH',
  'CATALOG_REVIEW', 'SOURCE_CONFLICT', 'UPSTREAM_FAILED', 'UPSTREAM_RATE_LIMIT',
  'INTERRUPTED', 'IMPORTER_BUSY', 'DB_OPERATION_FAILED', 'LOCK_LOST', 'INVALID_RUN',
  'RECONCILIATION_REQUIRED', 'VERIFICATION_MISMATCH', 'PUBLICATION_PENDING']);
class ImportError extends Error {
  constructor(code) {
    const safe = CODES.has(code) ? code : 'DB_OPERATION_FAILED';
    super(safe); this.name = 'ImportError'; this.code = safe;
  }
}
function fail(code) { throw new ImportError(code); }
function safeError(error) { return new ImportError(error?.code); }
function checkSignal(signal) { if (signal?.aborted) fail('INTERRUPTED'); }
module.exports = { ImportError, fail, safeError, checkSignal };
