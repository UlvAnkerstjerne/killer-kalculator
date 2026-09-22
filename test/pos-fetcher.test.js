'use strict';
// Tests for lib/pos-fetcher.js
// The HTTP client is always injected — the real OnlinePOS API is never contacted.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  cphMidnightUnix,
  validateContinuationUrl,
  fetchSalesRange,
} = require('../lib/pos-fetcher');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format a Unix-seconds timestamp as "YYYY-MM-DD HH:MM:SS" in Europe/Copenhagen. */
function fmtCPH(unixSec) {
  return new Intl.DateTimeFormat('sv', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(unixSec * 1000));
}

/** Build a minimal sales line for mock API responses. */
const mkLine = (over = {}) => ({
  orderlineid:   1,
  orderid:       100,
  timestamp_pay: '2026-09-20 12:00:00',
  productid:     99001,
  productname:   'Test',
  productgroup:  'Test',
  price:         100,
  priceexclvat:  80,
  discount:      0,
  count:         1,
  paymenttype:   'Betalingskort',
  ...over,
});

const BASE_NEXT = 'https://api.onlinepos.dk/api/exportSales/v20/1789855200';

/** Build a mock page envelope. */
function mkPage(lines, nextUrl = null, currentPage = 1) {
  return {
    data: {
      current_page:  currentPage,
      per_page:      500,
      from:          1,
      to:            lines.length,
      next_page_url: nextUrl,
      data:          lines,
    },
  };
}

/**
 * Build a mock httpGet from an ordered array of page specs.
 * Each entry is either:
 *   { data }          — success response
 *   { throw: Error }  — causes httpGet to throw
 * Returns { httpGet, calls } where calls is an array of [url, headers] pairs.
 */
function mockHttp(pages) {
  const calls = [];
  let idx = 0;
  async function httpGet(url, headers) {
    calls.push([url, headers]);
    if (idx >= pages.length) throw new Error(`Unexpected httpGet call #${idx + 1}`);
    const spec = pages[idx++];
    if (spec.throw) throw spec.throw;
    return spec;
  }
  return { httpGet, calls };
}

const STORE = { token: 'test-token-secret-xK9z', firmaid: '18095' };
const D20   = '2026-09-20';
const D21   = '2026-09-21';

// ── cphMidnightUnix ───────────────────────────────────────────────────────────
describe('cphMidnightUnix', () => {
  // Round-trip helper: convert to Unix, format in CPH, check it's midnight.
  function assertMidnight(dateStr) {
    const ts  = cphMidnightUnix(dateStr);
    const got = fmtCPH(ts);
    assert.equal(got, `${dateStr} 00:00:00`, `Round-trip failed for ${dateStr}`);
  }

  test('known reference: 2026-09-20 = 1789855200 (from investigation)', () => {
    assert.equal(cphMidnightUnix('2026-09-20'), 1789855200);
  });

  test('summer day (CEST, UTC+2): round-trip to CPH midnight', () => {
    assertMidnight('2026-07-15');
  });

  test('winter day (CET, UTC+1): round-trip to CPH midnight', () => {
    assertMidnight('2026-01-15');
  });

  // DST spring-forward: 2026-03-29 02:00 CET → 03:00 CEST
  // Midnight is still CET (UTC+1), NOT CEST (UTC+2).
  // A noon-based heuristic would pick CEST and compute the wrong midnight.
  test('spring-forward day 2026-03-29: midnight is in CET — round-trip correct', () => {
    assertMidnight('2026-03-29');
  });

  test('spring-forward day: result is in CET (UTC+1), not CEST (UTC+2)', () => {
    const ts = cphMidnightUnix('2026-03-29');
    // CPH midnight CET = UTC 23:00 previous day
    // i.e. fmtCPH(ts) must be "2026-03-29 00:00:00"
    assert.equal(fmtCPH(ts), '2026-03-29 00:00:00');
    // And the UTC offset for this candidate is -3600s (UTC+1)
    // Verify: ts + 3600 should be 2026-03-29 00:00 UTC
    const d = new Date((ts + 3600) * 1000);
    assert.equal(d.getUTCHours(),   0);
    assert.equal(d.getUTCMinutes(), 0);
  });

  // DST fall-back: 2026-10-25 03:00 CEST → 02:00 CET
  // Midnight is still CEST (UTC+2).
  test('fall-back day 2026-10-25: midnight is in CEST — round-trip correct', () => {
    assertMidnight('2026-10-25');
  });

  test('day after fall-back 2026-10-26: midnight is in CET — round-trip correct', () => {
    assertMidnight('2026-10-26');
  });

  test('day before spring-forward 2026-03-28: midnight is CET — round-trip correct', () => {
    assertMidnight('2026-03-28');
  });

  test('throws on invalid date format', () => {
    assert.throws(() => cphMidnightUnix('20260920'),  /Invalid date format/);
    assert.throws(() => cphMidnightUnix('2026/09/20'), /Invalid date format/);
    assert.throws(() => cphMidnightUnix(''),           /Invalid date format/);
  });
});

// ── validateContinuationUrl ───────────────────────────────────────────────────
describe('validateContinuationUrl', () => {
  const VALID = `${BASE_NEXT}?page=2`;

  test('valid HTTPS OnlinePOS exportSales URL passes', () => {
    assert.doesNotThrow(() => validateContinuationUrl(VALID));
  });

  test('null is rejected', () => {
    assert.throws(() => validateContinuationUrl(null), /string/);
  });

  test('non-string is rejected', () => {
    assert.throws(() => validateContinuationUrl(42), /string/);
  });

  test('malformed URL is rejected', () => {
    assert.throws(() => validateContinuationUrl('not a url !!'), /valid URL/);
  });

  test('HTTP (non-HTTPS) is rejected', () => {
    assert.throws(
      () => validateContinuationUrl('http://api.onlinepos.dk/api/exportSales/v20/123?page=2'),
      /HTTPS/,
    );
  });

  test('cross-origin URL is rejected', () => {
    assert.throws(
      () => validateContinuationUrl('https://evil.example.com/api/exportSales/v20/123'),
      /origin/,
    );
  });

  test('unexpected path is rejected', () => {
    assert.throws(
      () => validateContinuationUrl('https://api.onlinepos.dk/api/OTHER/endpoint?page=2'),
      /path/,
    );
  });

  test('URL with correct origin but trailing slash path is rejected', () => {
    assert.throws(
      () => validateContinuationUrl('https://api.onlinepos.dk/?page=2'),
      /path/,
    );
  });
});

// ── fetchSalesRange: single-page ──────────────────────────────────────────────
describe('fetchSalesRange — single page', () => {
  test('makes exactly one request and returns filtered lines', async () => {
    const line = mkLine({ orderlineid: 1, timestamp_pay: '2026-09-20 14:00:00' });
    const { httpGet, calls } = mockHttp([mkPage([line])]);

    const { lines, meta } = await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });

    assert.equal(calls.length, 1, 'must make exactly one HTTP request');
    assert.equal(lines.length, 1);
    assert.equal(meta.pages, 1);
    assert.equal(meta.rawLineCount, 1);
    assert.equal(meta.processedLineCount, 1);
    assert.equal(meta.ok, true);
  });

  test('one initial request for a multi-day range (not one per day)', async () => {
    const lines = [
      mkLine({ orderlineid: 1, timestamp_pay: '2026-09-20 10:00:00' }),
      mkLine({ orderlineid: 2, timestamp_pay: '2026-09-21 10:00:00' }),
    ];
    const { httpGet, calls } = mockHttp([mkPage(lines)]);

    await fetchSalesRange({ store: STORE, start: D20, end: '2026-09-22', httpGet });

    assert.equal(calls.length, 1);
  });

  test('initial URL contains correct CPH midnight timestamp for the start date', async () => {
    const { httpGet, calls } = mockHttp([mkPage([])]);
    await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });
    // 1789855200 is the known CPH midnight for 2026-09-20
    assert.ok(calls[0][0].includes('1789855200'), `URL was: ${calls[0][0]}`);
  });

  test('out-of-range lines (previous day) are filtered out', async () => {
    const lines = [
      mkLine({ orderlineid: 1, timestamp_pay: '2026-09-19 23:59:59' }),  // before
      mkLine({ orderlineid: 2, timestamp_pay: '2026-09-20 00:00:00' }),  // in range
    ];
    const { httpGet } = mockHttp([mkPage(lines)]);
    const { lines: out, meta } = await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });

    assert.equal(out.length, 1);
    assert.equal(meta.outOfRange, 1);
  });

  test('credentials are passed in headers, not in the URL', async () => {
    const { httpGet, calls } = mockHttp([mkPage([])]);
    await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });

    const [url, headers] = calls[0];
    assert.ok(!url.includes(STORE.token), 'token must not appear in URL');
    assert.equal(headers.token,   STORE.token);
    assert.equal(headers.firmaid, STORE.firmaid);
    assert.equal(headers.Accept,  'application/json');
  });
});

// ── fetchSalesRange: pagination ───────────────────────────────────────────────
describe('fetchSalesRange — pagination', () => {
  const PAGE2_URL = `${BASE_NEXT}?page=2`;
  const PAGE3_URL = `${BASE_NEXT}?page=3`;

  test('two-page traversal: both pages fetched, lines aggregated', async () => {
    const line1 = mkLine({ orderlineid: 1, timestamp_pay: '2026-09-20 10:00:00' });
    const line2 = mkLine({ orderlineid: 2, timestamp_pay: '2026-09-20 11:00:00' });
    const { httpGet, calls } = mockHttp([
      mkPage([line1], PAGE2_URL, 1),
      mkPage([line2], null,      2),
    ]);

    const { lines, meta } = await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });

    assert.equal(calls.length, 2);
    assert.equal(meta.pages, 2);
    assert.equal(lines.length, 2);
    assert.equal(meta.rawLineCount, 2);
  });

  test('three-page traversal: all three pages fetched', async () => {
    const mkL = (id) => mkLine({ orderlineid: id, timestamp_pay: '2026-09-20 10:00:00' });
    const { httpGet } = mockHttp([
      mkPage([mkL(1)], PAGE2_URL, 1),
      mkPage([mkL(2)], PAGE3_URL, 2),
      mkPage([mkL(3)], null,      3),
    ]);

    const { meta } = await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });

    assert.equal(meta.pages, 3);
    assert.equal(meta.rawLineCount, 3);
  });

  test('page-2 lines outside range are filtered, page-1 lines in range are kept', async () => {
    const inRange  = mkLine({ orderlineid: 1, timestamp_pay: '2026-09-20 14:00:00' });
    const outRange = mkLine({ orderlineid: 2, timestamp_pay: '2026-09-21 00:00:00' });
    const { httpGet } = mockHttp([
      mkPage([inRange],  PAGE2_URL, 1),
      mkPage([outRange], null,      2),
    ]);

    const { lines, meta } = await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });

    assert.equal(lines.length, 1);
    assert.equal(meta.outOfRange, 1);
    assert.equal(meta.rawLineCount, 2);
  });

  test('credentials are passed on subsequent pages too', async () => {
    const line = mkLine({ orderlineid: 1, timestamp_pay: '2026-09-20 10:00:00' });
    const { httpGet, calls } = mockHttp([
      mkPage([line], PAGE2_URL, 1),
      mkPage([],     null,      2),
    ]);

    await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });

    for (const [url, headers] of calls) {
      assert.equal(headers.token,   STORE.token);
      assert.equal(headers.firmaid, STORE.firmaid);
      assert.ok(!url.includes(STORE.token), 'token must not appear in URL');
    }
  });
});

// ── fetchSalesRange: deduplication ────────────────────────────────────────────
describe('fetchSalesRange — deduplication', () => {
  test('identical line appearing on two pages is deduplicated to one', async () => {
    const line = mkLine({ orderlineid: 1, timestamp_pay: '2026-09-20 10:00:00' });
    const PAGE2 = `${BASE_NEXT}?page=2`;
    const { httpGet } = mockHttp([
      mkPage([line], PAGE2, 1),
      mkPage([line], null,  2),
    ]);

    const { lines, meta } = await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });

    assert.equal(lines.length, 1);
    assert.equal(meta.duplicatesRemoved, 1);
  });

  test('distinct lines with same product/price but different orderlineid both kept', async () => {
    const a = mkLine({ orderlineid: 10, productid: 99001, price: 149, timestamp_pay: '2026-09-20 10:00:00' });
    const b = mkLine({ orderlineid: 11, productid: 99001, price: 149, timestamp_pay: '2026-09-20 11:00:00' });
    const PAGE2 = `${BASE_NEXT}?page=2`;
    const { httpGet } = mockHttp([
      mkPage([a], PAGE2, 1),
      mkPage([b], null,  2),
    ]);

    const { lines, meta } = await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });

    assert.equal(lines.length, 2);
    assert.equal(meta.duplicatesRemoved, 0);
    assert.equal(meta.conflicts.length, 0);
  });
});

// ── fetchSalesRange: URL validation (fail-closed) ─────────────────────────────
describe('fetchSalesRange — unsafe continuation URL fails closed', () => {
  // Each test: page 1 returns a bad next_page_url; we assert fetchSalesRange throws
  // and does NOT call httpGet a second time (page-1 data is not returned as complete).

  async function assertFailsClosed(badNextUrl, msgPattern) {
    const line = mkLine({ orderlineid: 1, timestamp_pay: '2026-09-20 10:00:00' });
    const { httpGet, calls } = mockHttp([
      mkPage([line], badNextUrl, 1),
      mkPage([],     null,       2),  // should never be called
    ]);

    await assert.rejects(
      () => fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet }),
      msgPattern,
    );
    // Must not have made a second request
    assert.equal(calls.length, 1, 'must not fetch page 2 after URL validation failure');
  }

  test('HTTP (non-HTTPS) continuation URL is rejected', async () => {
    await assertFailsClosed(
      'http://api.onlinepos.dk/api/exportSales/v20/123?page=2',
      /HTTPS/,
    );
  });

  test('cross-origin continuation URL is rejected', async () => {
    await assertFailsClosed(
      'https://evil.example.com/api/exportSales/v20/123?page=2',
      /origin/i,
    );
  });

  test('unexpected-path continuation URL is rejected', async () => {
    await assertFailsClosed(
      'https://api.onlinepos.dk/api/WRONG/path?page=2',
      /path/,
    );
  });

  test('non-string continuation URL is rejected', async () => {
    // Simulate API returning a number in next_page_url field
    const line = mkLine({ orderlineid: 1, timestamp_pay: '2026-09-20 10:00:00' });
    const { httpGet, calls } = mockHttp([
      {
        data: {
          current_page: 1, per_page: 500, from: 1, to: 1,
          next_page_url: 42,   // wrong type
          data: [line],
        },
      },
    ]);
    await assert.rejects(
      () => fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet }),
      /string/,
    );
    assert.equal(calls.length, 1);
  });
});

// ── fetchSalesRange: pagination failures ──────────────────────────────────────
describe('fetchSalesRange — pagination failures fail closed', () => {
  test('pagination loop (same URL repeated) is detected and throws', async () => {
    const PAGE2 = `${BASE_NEXT}?page=2`;
    const { httpGet } = mockHttp([
      mkPage([], PAGE2,  1),
      mkPage([], PAGE2,  2),   // returns same URL — loop
      mkPage([], null,   3),   // should never reach
    ]);

    await assert.rejects(
      () => fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet }),
      /loop/i,
    );
  });

  test('stalled page (same current_page returned twice) is detected and throws', async () => {
    const PAGE2 = `${BASE_NEXT}?page=2`;
    const PAGE3 = `${BASE_NEXT}?page=3`;
    const { httpGet } = mockHttp([
      mkPage([], PAGE2, 1),
      mkPage([], PAGE3, 1),    // current_page = 1 again — stall
      mkPage([], null,  3),
    ]);

    await assert.rejects(
      () => fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet }),
      /stall/i,
    );
  });

  test('max page guard: throws when page limit exceeded', async () => {
    // Build 51 pages that each point to the next
    const pages = [];
    for (let i = 1; i <= 51; i++) {
      const nextUrl = i < 51 ? `${BASE_NEXT}?page=${i + 1}` : null;
      pages.push(mkPage([], nextUrl, i));
    }
    const { httpGet } = mockHttp(pages);

    await assert.rejects(
      () => fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet }),
      /maximum page limit/i,
    );
  });

  test('page-2 HTTP failure: throws — page-1 data is NOT returned as complete', async () => {
    const line = mkLine({ orderlineid: 1, timestamp_pay: '2026-09-20 10:00:00' });
    const httpErr = new Error('Network timeout');
    httpErr.response = { status: 503 };
    const PAGE2 = `${BASE_NEXT}?page=2`;
    const { httpGet } = mockHttp([
      mkPage([line], PAGE2, 1),
      { throw: httpErr },
    ]);

    // Must throw rather than return the one page-1 line as "complete"
    await assert.rejects(
      () => fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet }),
      /HTTP 503/,
    );
  });

  test('page-1 HTTP failure: throws with status code in message', async () => {
    const httpErr = new Error('Unauthorized');
    httpErr.response = { status: 401 };
    const { httpGet } = mockHttp([{ throw: httpErr }]);

    await assert.rejects(
      () => fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet }),
      /HTTP 401/,
    );
  });
});

// ── fetchSalesRange: credential safety ───────────────────────────────────────
describe('fetchSalesRange — credential safety', () => {
  test('token does not appear in thrown error message', async () => {
    const httpErr = new Error('Request failed');
    httpErr.response = { status: 500 };
    const { httpGet } = mockHttp([{ throw: httpErr }]);

    let caught;
    try {
      await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'expected fetchSalesRange to throw');
    assert.ok(
      !caught.message.includes(STORE.token),
      `Token leaked in error: "${caught.message.slice(0, 80)}"`,
    );
  });

  test('token does not appear in returned meta', async () => {
    const line = mkLine({ orderlineid: 1, timestamp_pay: '2026-09-20 10:00:00' });
    const { httpGet } = mockHttp([mkPage([line])]);

    const { meta } = await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });
    const serialised = JSON.stringify(meta);
    assert.ok(
      !serialised.includes(STORE.token),
      `Token leaked in meta: "${serialised.slice(0, 120)}"`,
    );
  });

  test('firmaid does not appear in returned meta', async () => {
    const { httpGet } = mockHttp([mkPage([])]);
    const { meta } = await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });
    // meta has start/end/pages/counts — but not firmaid
    assert.ok(!Object.prototype.hasOwnProperty.call(meta, 'firmaid'));
    assert.ok(!Object.prototype.hasOwnProperty.call(meta, 'token'));
  });
});

// ── fetchSalesRange: Copenhagen DST timestamps ────────────────────────────────
describe('fetchSalesRange — CPH start timestamps across DST', () => {
  async function captureUrl(start, end = null) {
    end = end || start.slice(0, 8) + String(Number(start.slice(8)) + 1).padStart(2, '0');
    const { httpGet, calls } = mockHttp([mkPage([])]);
    try {
      await fetchSalesRange({ store: STORE, start, end, httpGet });
    } catch { /* date calc may throw for bad dates — we only need the call */ }
    return calls[0]?.[0] ?? null;
  }

  test('winter day start URL contains correct CET midnight timestamp', async () => {
    // 2026-01-15 00:00 CET = 2026-01-14 23:00 UTC
    const ts = cphMidnightUnix('2026-01-15');
    assert.equal(fmtCPH(ts), '2026-01-15 00:00:00');
    const url = await captureUrl('2026-01-15', '2026-01-16');
    assert.ok(url.includes(String(ts)), `URL ${url} missing ${ts}`);
  });

  test('summer day start URL contains correct CEST midnight timestamp', async () => {
    const ts = cphMidnightUnix('2026-07-15');
    assert.equal(fmtCPH(ts), '2026-07-15 00:00:00');
    const url = await captureUrl('2026-07-15', '2026-07-16');
    assert.ok(url.includes(String(ts)));
  });

  test('spring-forward day: URL uses CET midnight (not the wrong CEST midnight)', async () => {
    // 2026-03-29: midnight is CET (UTC+1), NOT CEST (UTC+2)
    // Wrong (noon-heuristic) answer would give UTC 22:00 = 1h earlier than correct
    const ts = cphMidnightUnix('2026-03-29');
    assert.equal(fmtCPH(ts), '2026-03-29 00:00:00');
    const url = await captureUrl('2026-03-29', '2026-03-30');
    assert.ok(url.includes(String(ts)));
  });

  test('fall-back day: URL uses CEST midnight', async () => {
    const ts = cphMidnightUnix('2026-10-25');
    assert.equal(fmtCPH(ts), '2026-10-25 00:00:00');
    const url = await captureUrl('2026-10-25', '2026-10-26');
    assert.ok(url.includes(String(ts)));
  });
});

// ── fetchSalesRange: argument validation ──────────────────────────────────────
describe('fetchSalesRange — argument validation', () => {
  const noop = async () => mkPage([]);

  test('throws when store is missing token', async () => {
    await assert.rejects(
      () => fetchSalesRange({ store: { firmaid: '18095' }, start: D20, end: D21, httpGet: noop }),
      /token/,
    );
  });

  test('throws when start >= end', async () => {
    await assert.rejects(
      () => fetchSalesRange({ store: STORE, start: D20, end: D20, httpGet: noop }),
      /before/,
    );
  });

  test('throws when httpGet is not a function', async () => {
    await assert.rejects(
      () => fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet: null }),
      /httpGet/,
    );
  });
});

// ── fetchSalesRange: metadata shape ──────────────────────────────────────────
describe('fetchSalesRange — metadata shape', () => {
  test('returned meta contains all required fields', async () => {
    const { httpGet } = mockHttp([mkPage([])]);
    const { meta } = await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });

    for (const field of [
      'ok', 'pages', 'rawLineCount', 'processedLineCount',
      'outOfRange', 'duplicatesRemoved', 'invalidCount',
      'conflicts', 'complete', 'start', 'end',
    ]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(meta, field),
        `meta missing field: ${field}`,
      );
    }
    assert.equal(meta.start, D20);
    assert.equal(meta.end,   D21);
  });
});

// ── fetchSalesRange: pagination early-exit ────────────────────────────────────
//
// Ordering contract (verified live 2026-09-22 against norrebro LY data):
//   The minimum valid CPH date on a page is monotonically non-decreasing across
//   consecutive pages.  Once min(page) >= end, all subsequent pages have zero
//   in-range lines, so we stop requesting them.  Max date and last-element date
//   are NOT safe for this check: retroactive entries mean max can exceed end while
//   a later page still starts from the range start date.
//
// Fail-closed: if any page's min date regresses below the running global minimum
//   seen so far, earlyExitSafe is set to false for the remainder of the fetch.
describe('fetchSalesRange — pagination early-exit', () => {
  // LY range: range is Sep23→Sep24, simulates the "last-year today" scenario.
  // Page 1 has in-range lines (min=Sep23 < end Sep24) → continue.
  // Page 2 has only post-end lines (min=Oct15 >= end Sep24) → early exit.
  // Page 3 should never be requested.
  test('LY one-day range: stops after the page whose min-date crosses end', async () => {
    const inRange  = mkLine({ orderlineid: 1, timestamp_pay: '2025-09-23 14:00:00' });
    const postEnd1 = mkLine({ orderlineid: 2, timestamp_pay: '2025-10-15 10:00:00' });
    const postEnd2 = mkLine({ orderlineid: 3, timestamp_pay: '2025-11-01 10:00:00' });
    const P2 = `${BASE_NEXT}?page=2`;
    const P3 = `${BASE_NEXT}?page=3`;
    const { httpGet, calls } = mockHttp([
      mkPage([inRange],  P2,   1),
      mkPage([postEnd1], P3,   2),  // min=Oct15 >= end Sep24 → exit after this page
      mkPage([postEnd2], null, 3),  // must NOT be fetched
    ]);

    const { lines, meta } = await fetchSalesRange({
      store: STORE, start: '2025-09-23', end: '2025-09-24', httpGet,
    });

    assert.equal(calls.length, 2, 'must stop after page 2, not fetch page 3');
    assert.equal(meta.pages, 2);
    assert.equal(lines.length, 1, 'only the in-range line is returned');
    assert.equal(meta.processedLineCount, 1);
    assert.equal(meta.outOfRange, 1);  // postEnd1 was fetched but filtered
  });

  test('exact exclusive-end boundary: page with min = end triggers exit', async () => {
    // end = D21 = '2026-09-21'; a page where all lines have that exact date
    const boundaryLine = mkLine({ orderlineid: 1, timestamp_pay: '2026-09-21 00:00:00' });
    const P2 = `${BASE_NEXT}?page=2`;
    const P3 = `${BASE_NEXT}?page=3`;
    const { httpGet, calls } = mockHttp([
      mkPage([boundaryLine], P2,   1),  // min='2026-09-21' >= end='2026-09-21' → exit
      mkPage([],             null, 2),  // must NOT be fetched
      mkPage([],             null, 3),  // must NOT be fetched
    ]);

    const { lines, meta } = await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });

    assert.equal(calls.length, 1, 'exit after page 1 (its min date equals end)');
    assert.equal(lines.length, 0, 'boundary line is exclusive-end, filtered out');
    assert.equal(meta.outOfRange, 1);
  });

  test('boundary in the middle of a page: keep whole page, stop requesting next', async () => {
    // Page 1 has both in-range and post-end lines (min=Sep20 < end=Sep21) → continue.
    // Page 2 has only post-end lines (min=Sep22 >= end=Sep21) → early exit.
    const inRange  = mkLine({ orderlineid: 1, timestamp_pay: '2026-09-20 12:00:00' });
    const postEnd  = mkLine({ orderlineid: 2, timestamp_pay: '2026-09-21 08:00:00' });
    const postEnd2 = mkLine({ orderlineid: 3, timestamp_pay: '2026-09-22 10:00:00' });
    const P2 = `${BASE_NEXT}?page=2`;
    const P3 = `${BASE_NEXT}?page=3`;
    const { httpGet, calls } = mockHttp([
      mkPage([inRange, postEnd], P2,   1),   // mixed: min=Sep20 < end → continue
      mkPage([postEnd2],         P3,   2),   // min=Sep22 >= end=Sep21 → exit
      mkPage([],                 null, 3),   // must NOT be fetched
    ]);

    const { lines, meta } = await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });

    assert.equal(calls.length, 2, 'exactly two pages fetched');
    assert.equal(lines.length, 1, 'only inRange line survives filter');
    // postEnd from page 1 + postEnd2 from page 2 both out of range
    assert.equal(meta.outOfRange, 2);
    assert.equal(meta.rawLineCount, 3);
  });

  test('DST spring-forward date: 2026-03-29 range uses correct CPH midnight, early exit works', async () => {
    // Spring-forward day: range 2026-03-29 → 2026-03-30
    const inRange = mkLine({ orderlineid: 1, timestamp_pay: '2026-03-29 14:00:00' });
    const postEnd = mkLine({ orderlineid: 2, timestamp_pay: '2026-03-31 10:00:00' });
    const P2 = `${BASE_NEXT}?page=2`;
    const P3 = `${BASE_NEXT}?page=3`;
    const { httpGet, calls } = mockHttp([
      mkPage([inRange], P2,   1),  // min=Mar29 < end=Mar30 → continue
      mkPage([postEnd], P3,   2),  // min=Mar31 >= end=Mar30 → exit
      mkPage([],        null, 3),  // must NOT be fetched
    ]);

    const { lines, meta } = await fetchSalesRange({
      store: STORE, start: '2026-03-29', end: '2026-03-30', httpGet,
    });

    assert.equal(calls.length, 2);
    assert.equal(lines.length, 1, 'spring-forward in-range line must be kept');
    assert.equal(meta.outOfRange, 1);
  });

  test('pagination continues when pages still have min-date before end', async () => {
    // Three in-range pages (all min < end), early exit only on page 4.
    const mkL = (id, ts) => mkLine({ orderlineid: id, timestamp_pay: ts });
    const P2 = `${BASE_NEXT}?page=2`;
    const P3 = `${BASE_NEXT}?page=3`;
    const P4 = `${BASE_NEXT}?page=4`;
    const P5 = `${BASE_NEXT}?page=5`;
    const { httpGet, calls } = mockHttp([
      mkPage([mkL(1,'2026-09-20 10:00:00'), mkL(2,'2026-09-20 11:00:00')], P2, 1),  // min=Sep20
      mkPage([mkL(3,'2026-09-20 14:00:00'), mkL(4,'2026-09-20 18:00:00')], P3, 2),  // min=Sep20
      mkPage([mkL(5,'2026-09-20 20:00:00'), mkL(6,'2026-09-20 23:00:00')], P4, 3),  // min=Sep20
      mkPage([mkL(7,'2026-09-22 08:00:00')],                               P5, 4),  // min=Sep22 >= end=Sep21 → exit
      mkPage([],                                                          null, 5),  // must NOT be fetched
    ]);

    const { lines, meta } = await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });

    assert.equal(calls.length, 4, 'pages 1-4 fetched; page 5 not requested');
    assert.equal(lines.length, 6, 'all 6 in-range lines returned');
    assert.equal(meta.pages, 4);
  });

  test('malformed timestamps do not cause premature exit', async () => {
    // Page 1: all lines have invalid timestamp_pay → no valid min-date → skip early exit check
    // Page 2: valid in-range lines
    // Page 3: valid post-end lines → early exit here
    const badLine  = mkLine({ orderlineid: 1, timestamp_pay: 'not-a-date' });
    const goodLine = mkLine({ orderlineid: 2, timestamp_pay: '2026-09-20 14:00:00' });
    const postEnd  = mkLine({ orderlineid: 3, timestamp_pay: '2026-09-22 10:00:00' });
    const P2 = `${BASE_NEXT}?page=2`;
    const P3 = `${BASE_NEXT}?page=3`;
    const P4 = `${BASE_NEXT}?page=4`;
    const { httpGet, calls } = mockHttp([
      mkPage([badLine],  P2,   1),   // no valid min-date → no early exit
      mkPage([goodLine], P3,   2),   // min=Sep20 < end=Sep21 → continue
      mkPage([postEnd],  P4,   3),   // min=Sep22 >= end=Sep21 → exit
      mkPage([],         null, 4),   // must NOT be fetched
    ]);

    const { lines, meta } = await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });

    assert.equal(calls.length, 3, 'pages 1-3 fetched; malformed timestamps do not skip pages');
    assert.equal(lines.length, 1, 'only valid in-range line returned');
    assert.equal(meta.invalidCount, 1, 'malformed timestamp counted as invalid');
  });

  test('non-monotonic data fails closed: in-range lines on later pages are not lost', async () => {
    // Page 1: Sep20 in range (min=Sep20, globalMin=Sep20)
    // Page 2: Sep18 — REGRESSION (Sep18 < globalMin=Sep20) → earlyExitSafe=false
    // Page 3: Sep22 post-end (min=Sep22 >= end=Sep21, but earlyExitSafe=false → no exit)
    // Page 4: Sep20 in-range lines — these must be included
    // Page 5: no more data
    const mkL = (id, ts) => mkLine({ orderlineid: id, timestamp_pay: ts });
    const P2 = `${BASE_NEXT}?page=2`;
    const P3 = `${BASE_NEXT}?page=3`;
    const P4 = `${BASE_NEXT}?page=4`;
    const P5 = `${BASE_NEXT}?page=5`;
    const { httpGet, calls } = mockHttp([
      mkPage([mkL(1,'2026-09-20 10:00:00')], P2,   1),  // in-range; globalMin=Sep20
      mkPage([mkL(2,'2026-09-18 10:00:00')], P3,   2),  // REGRESSION Sep18 → earlyExitSafe=false
      mkPage([mkL(3,'2026-09-22 10:00:00')], P4,   3),  // post-end, but earlyExitSafe=false → no exit
      mkPage([mkL(4,'2026-09-20 20:00:00')], P5,   4),  // in-range — would be missed without fail-closed
      mkPage([],                           null,   5),
    ]);

    const { lines, meta } = await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });

    assert.equal(calls.length, 5, 'all 5 pages fetched due to fail-closed');
    // In-range lines: Sep20 from pages 1 and 4 (Sep18 and Sep22 are out-of-range)
    assert.equal(lines.length, 2, 'in-range lines from pages 1 and 4 both returned');
    assert.equal(meta.outOfRange, 2);  // Sep18 (before start) + Sep22 (after end)
  });

  test('empty pages with valid next_page_url do not trigger early exit', async () => {
    const inRange = mkLine({ orderlineid: 1, timestamp_pay: '2026-09-20 14:00:00' });
    const postEnd = mkLine({ orderlineid: 2, timestamp_pay: '2026-09-22 10:00:00' });
    const P2 = `${BASE_NEXT}?page=2`;
    const P3 = `${BASE_NEXT}?page=3`;
    const P4 = `${BASE_NEXT}?page=4`;
    const { httpGet, calls } = mockHttp([
      mkPage([],        P2,   1),   // empty → no min-date → no early exit
      mkPage([inRange], P3,   2),   // min=Sep20 < end=Sep21 → continue
      mkPage([postEnd], P4,   3),   // min=Sep22 >= end=Sep21 → exit
      mkPage([],        null, 4),   // must NOT be fetched
    ]);

    const { lines, meta } = await fetchSalesRange({ store: STORE, start: D20, end: D21, httpGet });

    assert.equal(calls.length, 3, 'empty page 1 passed through without triggering exit');
    assert.equal(lines.length, 1);
  });
});
