'use strict';

/**
 * Convert a naive Copenhagen-local datetime string to an ISO date string.
 *
 * The OnlinePOS API returns timestamp_pay as a naive local-time string in
 * Europe/Copenhagen (e.g. "2026-09-20 14:31:00").  Because the string is
 * already expressed in CPH local time, extracting the date portion directly
 * yields the correct CPH calendar date — no further conversion is needed.
 *
 * DST safety: Denmark's DST transitions (spring-forward and fall-back) occur
 * within a single day, never at midnight, so they cannot shift a CPH-local
 * string from one calendar date to another.  Contrast this with fixed
 * 24-hour arithmetic (startUnix + 86400) which produces wrong results on
 * the 23-hour and 25-hour DST-transition days; this function never does that.
 *
 * Validation: month and day are range-checked so that obviously bogus values
 * (e.g. month 13) are rejected visibly rather than silently accepted.
 *
 * @param   {string|null|undefined} tsStr  Naive CPH-local datetime
 *                                         "YYYY-MM-DD HH:MM:SS" or ISO variant
 * @returns {string|null}                  "YYYY-MM-DD", or null when invalid
 */
function toCphDate(tsStr) {
  if (!tsStr || typeof tsStr !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T]\d{2}:\d{2}:\d{2}/.exec(tsStr.trim());
  if (!m) return null;
  const mo = Number(m[2]);
  const dy = Number(m[3]);
  if (mo < 1 || mo > 12 || dy < 1 || dy > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Process raw OnlinePOS exportSales lines for a date range.
 *
 * Responsibilities
 * ─────────────────
 * 1. Date filtering   — inclusive start date, exclusive end date, using CPH
 *                       calendar dates from timestamp_pay (fallback: datetime).
 * 2. Deduplication    — identity = firmaid + orderlineid.
 *                       Exact repeated lines are retained once.
 *                       Legitimate separate lines with identical products /
 *                       prices / counts but different orderlineids are kept.
 * 3. Conflict report  — same identity, different field values → conflict entry.
 * 4. Value semantics  — count is preserved with sign (negative = refund).
 *                       price and priceexclvat are the pre-signed line totals
 *                       (unit_price × count) as returned by the API; this
 *                       module never multiplies either field by count.
 *
 * @param {object}         opts
 * @param {string|number}  opts.firmaid  Store firmaid for dedup identity
 * @param {Array}          opts.lines    Raw lines from exportSales API
 * @param {string}         opts.start    Inclusive start date "YYYY-MM-DD" (CPH)
 * @param {string}         opts.end      Exclusive end date "YYYY-MM-DD" (CPH)
 *
 * @returns {{ lines: Array, meta: ProcessMeta }}
 *
 * @typedef  {object} ProcessMeta
 * @property {number}  inputCount        Total lines received
 * @property {number}  outputCount       Lines in the returned array
 * @property {number}  outOfRange        Lines outside [start, end)
 * @property {number}  duplicatesRemoved Exact-duplicate lines dropped
 * @property {number}  invalidCount      Lines with unparseable timestamps
 * @property {Array}   conflicts         [{key, first, second}] same-ID diff-data
 * @property {boolean} complete          True when invalidCount=0 and no conflicts
 */
function processLines({ firmaid, lines, start, end }) {
  if (firmaid === undefined || firmaid === null) {
    throw new Error('firmaid is required');
  }
  if (!start || !end) {
    throw new Error('start and end dates are required');
  }
  if (start >= end) {
    throw new Error('start must be strictly before end');
  }

  const fid      = String(firmaid);
  const rawLines = Array.isArray(lines) ? lines : [];

  const seen      = new Map();  // key → index in output
  const output    = [];
  const conflicts = [];
  let outOfRange        = 0;
  let invalidCount      = 0;
  let duplicatesRemoved = 0;

  for (const line of rawLines) {
    // ── 1. Validate and parse timestamp ──────────────────────────────────────
    const tsStr   = line.timestamp_pay || line.datetime || null;
    const cphDate = toCphDate(tsStr);

    if (!cphDate) {
      // Reject visibly: invalid / missing timestamps are never treated as zero
      invalidCount++;
      continue;
    }

    // ── 2. Date filter: [start, end) ─────────────────────────────────────────
    if (cphDate < start || cphDate >= end) {
      outOfRange++;
      continue;
    }

    // ── 3. Deduplication by firmaid:orderlineid ───────────────────────────────
    const key = `${fid}:${line.orderlineid}`;

    if (seen.has(key)) {
      const prevIdx = seen.get(key);
      // Compare raw field data (strip the _cphDate we add below)
      const prevRaw = { ...output[prevIdx] };
      delete prevRaw._cphDate;

      if (JSON.stringify(prevRaw) === JSON.stringify(line)) {
        duplicatesRemoved++;
      } else {
        conflicts.push({
          key,
          first:  output[prevIdx],
          second: { ...line, _cphDate: cphDate },
        });
      }
      continue;
    }

    // ── 4. Accept line ────────────────────────────────────────────────────────
    // Append _cphDate (derived, non-sensitive) for callers that need it.
    // count, price, and priceexclvat are passed through unchanged:
    //   • count   — signed; negative for refunds
    //   • price   — already the pre-signed line total (unit_price × count)
    //   • priceexclvat — same, ex 25% VAT
    // Neither price field is multiplied by count here.
    const processed = { ...line, _cphDate: cphDate };
    seen.set(key, output.length);
    output.push(processed);
  }

  return {
    lines: output,
    meta: {
      inputCount:        rawLines.length,
      outputCount:       output.length,
      outOfRange,
      duplicatesRemoved,
      invalidCount,
      conflicts,
      complete: invalidCount === 0 && conflicts.length === 0,
    },
  };
}

module.exports = { toCphDate, processLines };
