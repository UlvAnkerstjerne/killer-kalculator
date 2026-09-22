'use strict';

/**
 * Paginated OnlinePOS range fetcher.
 *
 * Fetches all exportSales/v20 pages for one store over a CPH date range and
 * passes the result through lib/sales-lines processLines for date filtering,
 * deduplication and value-semantic preservation.
 *
 * Design principles
 * ─────────────────
 * • One initial request per range — not one request per day.
 * • Follows next_page_url until null; detects loops, stalls and page limits.
 * • Validates every continuation URL before attaching credentials (HTTPS,
 *   expected origin, expected path prefix).  Never attaches the token to an
 *   unexpected URL.
 * • Throws on any failure: network, HTTP, pagination, or URL validation.
 *   A caller that catches a return value can always trust it is complete.
 * • Never includes tokens or firmaids in thrown errors, logs, or returned meta.
 * • HTTP client is injected — tests never contact the real API.
 */

const { processLines } = require('./sales-lines');

// ── Constants ─────────────────────────────────────────────────────────────────

const EXPECTED_ORIGIN      = 'https://api.onlinepos.dk';
const EXPECTED_PATH_PREFIX = '/api/exportSales/v20/';
const MAX_PAGES            = 50;  // hard guard against runaway pagination

// ── Timestamp conversion ──────────────────────────────────────────────────────

/**
 * Convert a "YYYY-MM-DD" string to Unix seconds for midnight in
 * Europe/Copenhagen.
 *
 * DST-aware algorithm:
 *   Copenhagen is UTC+1 (CET) in winter and UTC+2 (CEST) in summer.
 *   Rather than using a fixed offset or a noon-based heuristic (which gives
 *   the wrong midnight on the spring-forward day because midnight is still
 *   CET while noon is already CEST), we try both candidate offsets and verify
 *   via Intl.DateTimeFormat which one actually represents midnight in CPH.
 *
 * This correctly handles:
 *   • Normal winter days  (CET  = UTC+1)
 *   • Normal summer days  (CEST = UTC+2)
 *   • Spring-forward day  (midnight CET, rest of day CEST)
 *   • Fall-back day       (midnight CEST, rest of day also CEST until 03:00)
 *
 * @param   {string} dateStr  "YYYY-MM-DD"
 * @returns {number}          Unix timestamp in seconds
 * @throws  If dateStr is malformed or midnight cannot be determined
 */
function cphMidnightUnix(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Invalid date format for cphMidnightUnix: '${dateStr}'`);
  }
  const [yr, mo, dy] = dateStr.split('-').map(Number);

  const fmt = new Intl.DateTimeFormat('sv', {
    timeZone:  'Europe/Copenhagen',
    year:      'numeric',
    month:     '2-digit',
    day:       '2-digit',
    hour:      '2-digit',
    minute:    '2-digit',
    second:    '2-digit',
  });

  // CPH is UTC+1 or UTC+2.  Try both: the one where Intl confirms the result
  // is 00:00:00 on dateStr is the correct CPH midnight.
  for (const offsetHours of [1, 2]) {
    const candidateMs = Date.UTC(yr, mo - 1, dy, 0, 0, 0) - offsetHours * 3600_000;
    const parts = fmt.formatToParts(new Date(candidateMs));
    const p = {};
    for (const { type, value } of parts) p[type] = value;
    const gotDate = `${p.year}-${p.month}-${p.day}`;
    const gotTime = `${p.hour}:${p.minute}:${p.second}`;
    if (gotDate === dateStr && gotTime === '00:00:00') {
      return Math.round(candidateMs / 1000);
    }
  }

  throw new Error(`Cannot determine CPH midnight for '${dateStr}'`);
}

// ── URL validation ────────────────────────────────────────────────────────────

/**
 * Validate a pagination continuation URL before the credential header is
 * attached to a request for that URL.
 *
 * Accepts only:
 *   • A string that parses as a valid URL
 *   • Protocol: https:
 *   • Origin: exactly https://api.onlinepos.dk
 *   • Path prefix: /api/exportSales/v20/
 *
 * @param  {unknown} urlStr
 * @throws {Error}   With a safe message (does not contain credentials)
 */
function validateContinuationUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    throw new Error('Continuation URL must be a non-empty string');
  }
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error('Continuation URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Continuation URL must use HTTPS (got ${parsed.protocol})`
    );
  }
  if (parsed.origin !== EXPECTED_ORIGIN) {
    throw new Error(
      `Continuation URL origin must be ${EXPECTED_ORIGIN} (got ${parsed.origin})`
    );
  }
  if (!parsed.pathname.startsWith(EXPECTED_PATH_PREFIX)) {
    throw new Error(
      `Continuation URL path must start with ${EXPECTED_PATH_PREFIX}`
    );
  }
}

// ── Main fetcher ──────────────────────────────────────────────────────────────

/**
 * Fetch all sales lines for one store over a CPH date range.
 *
 * @param {object}   opts
 * @param {object}   opts.store    Store config: { token: string, firmaid: string|number }
 * @param {string}   opts.start   Inclusive start date "YYYY-MM-DD" (Europe/Copenhagen)
 * @param {string}   opts.end     Exclusive end date   "YYYY-MM-DD" (Europe/Copenhagen)
 * @param {Function} opts.httpGet Injectable HTTP client.
 *                                Signature: async (url: string, headers: object) => { data: object }
 *                                headers contains credentials — never log or expose it.
 *                                On HTTP error: must throw (error.response?.status optional).
 *
 * @returns {Promise<{ lines: Array, meta: FetchMeta }>}
 * @throws  {Error}  On any network, HTTP, URL-validation, pagination or
 *                   processing failure.  The thrown message never contains
 *                   the store token or firmaid.
 *
 * @typedef {object} FetchMeta
 * @property {boolean} ok                True when processing was complete (no invalids, no conflicts)
 * @property {number}  pages             Number of API pages fetched
 * @property {number}  rawLineCount      Total lines received from API before filtering
 * @property {number}  processedLineCount Lines in the returned array
 * @property {number}  outOfRange        Lines outside [start, end)
 * @property {number}  duplicatesRemoved Exact-duplicate lines dropped
 * @property {number}  invalidCount      Lines with bad/missing timestamps
 * @property {Array}   conflicts         [{key,first,second}] same-ID diff-data pairs
 * @property {boolean} complete          From processLines — same as ok when no errors
 * @property {string}  start             Echoed back (safe)
 * @property {string}  end               Echoed back (safe)
 */
async function fetchSalesRange({ store, start, end, httpGet }) {
  // ── Argument validation ─────────────────────────────────────────────────────
  if (!store || store.token === undefined || store.firmaid === undefined) {
    throw new Error('store must provide token and firmaid');
  }
  if (!start || !end) {
    throw new Error('start and end dates are required');
  }
  if (start >= end) {
    throw new Error('start must be strictly before end');
  }
  if (typeof httpGet !== 'function') {
    throw new Error('httpGet must be a function');
  }

  // Credential header — constructed once, never serialised into errors/logs
  const headers = {
    token:   store.token,
    firmaid: String(store.firmaid),
    Accept:  'application/json',
  };

  // ── Initial URL ─────────────────────────────────────────────────────────────
  const startTs    = cphMidnightUnix(start);
  const initialUrl = `${EXPECTED_ORIGIN}${EXPECTED_PATH_PREFIX}${startTs}`;

  // ── Pagination loop ─────────────────────────────────────────────────────────
  const allRaw   = [];
  const seenUrls = new Set();
  let nextUrl    = initialUrl;
  let pages      = 0;
  let lastPage   = undefined;

  while (nextUrl !== null) {
    // Hard page limit
    if (pages >= MAX_PAGES) {
      throw new Error(
        `OnlinePOS fetch exceeded maximum page limit (${MAX_PAGES})`
      );
    }

    // Loop detection
    if (seenUrls.has(nextUrl)) {
      throw new Error(
        `OnlinePOS pagination loop detected (URL repeated at page ${pages + 1})`
      );
    }
    seenUrls.add(nextUrl);

    // Credential-safety: validate every continuation URL before attaching token.
    // The initial URL is exempt — we constructed it from trusted constants.
    if (pages > 0) {
      validateContinuationUrl(nextUrl);   // throws on any violation
    }

    // Fetch — credentials travel in headers, not the URL
    let response;
    try {
      response = await httpGet(nextUrl, headers);
    } catch (err) {
      // Re-throw without leaking token or firmaid
      const status = err.response?.status;
      throw new Error(
        `OnlinePOS request failed on page ${pages + 1}` +
        (status ? ` (HTTP ${status})` : '') +
        ': ' + (err.message || 'network error')
      );
    }

    const envelope    = response.data;
    const pageData    = Array.isArray(envelope?.data) ? envelope.data : [];
    const currentPage = envelope?.current_page;
    const rawNext     = envelope?.next_page_url ?? null;

    // Stall detection: same page number returned twice
    if (currentPage !== undefined && currentPage !== null && currentPage === lastPage) {
      throw new Error(
        `OnlinePOS pagination stalled: server returned page ${currentPage} twice`
      );
    }
    lastPage = currentPage;

    allRaw.push(...pageData);
    pages++;

    // Resolve and pre-validate the next URL
    if (!rawNext) {
      nextUrl = null;
    } else {
      // Pre-validate here so failures are detected immediately after fetching
      // (in addition to the check at the top of the next iteration)
      validateContinuationUrl(rawNext);
      nextUrl = rawNext;
    }
  }

  // ── Process lines through lib/sales-lines ───────────────────────────────────
  const { lines, meta: pm } = processLines({
    firmaid: String(store.firmaid),
    lines:   allRaw,
    start,
    end,
  });

  // ── Return — no credentials in meta ─────────────────────────────────────────
  return {
    lines,
    meta: {
      ok:                pm.complete,
      pages,
      rawLineCount:      allRaw.length,
      processedLineCount: lines.length,
      outOfRange:        pm.outOfRange,
      duplicatesRemoved: pm.duplicatesRemoved,
      invalidCount:      pm.invalidCount,
      conflicts:         pm.conflicts,
      complete:          pm.complete,
      start,
      end,
    },
  };
}

module.exports = { cphMidnightUnix, validateContinuationUrl, fetchSalesRange };
