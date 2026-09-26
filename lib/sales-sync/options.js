'use strict';
const { storeId, date, cphLocal } = require('../sales-db/values');
const { fail } = require('./errors');

function validateOptions(options, now = new Date()) {
  try {
    storeId(options.storeSlug); date(options.start);
    const observedAt = now.toISOString(), today = cphLocal(now.getTime()).slice(0, 10);
    const end = options.end ?? today; date(end);
    if (options.start >= end || end > today) fail('INVALID_OPTIONS');
    // Review modes reject these flags before validation and never load a repository.
    if (options.verificationOf || options.resumePublication) {
      const { runId } = require('./repository');
      if (options.verificationOf) runId(options.verificationOf);
      if (options.resumePublication) runId(options.resumePublication);
    }
    if (options.verificationOf && options.resumePublication) fail('INVALID_OPTIONS');
    return { storeSlug: options.storeSlug, start: options.start, end, observedAt,
      verificationOf: options.verificationOf, resumePublication: options.resumePublication };
  } catch { fail('INVALID_OPTIONS'); }
}
module.exports = { validateOptions };
