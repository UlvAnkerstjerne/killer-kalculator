'use strict';
const { createHash } = require('node:crypto');
const { cphMidnightUnix } = require('../pos-fetcher');
const { parseLossless, MAX_PAGE_BYTES } = require('./parse');
const { normalizeLine, readLineTime } = require('./normalize');
const { date } = require('../sales-db/values');
const { fail, checkSignal, safeError, ImportError } = require('./errors');
const ORIGIN = 'https://api.onlinepos.dk';
const PREFIX = '/api/exportSales/v20/';

function continuation(raw, initial, expectedPage) {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\s\\%]/.test(raw)) fail('UNSAFE_CONTINUATION');
  let url;
  try { url = new URL(raw); } catch { fail('UNSAFE_CONTINUATION'); }
  const keys = [...url.searchParams.keys()];
  if (url.origin !== ORIGIN || url.username || url.password || url.hash ||
      url.pathname !== new URL(initial).pathname || keys.length !== 1 || keys[0] !== 'page' ||
      url.searchParams.get('page') !== String(expectedPage)) fail('UNSAFE_CONTINUATION');
  return url.href;
}
async function traverse({ start, end, storeSlug, companyId, context, request, sink, signal,
  maxPages = 10000, maxRows = 2000000, batchSize = 250, maxBytes = MAX_PAGE_BYTES },
{ inspectAllDates = false } = {}) {
  try { date(start); date(end); if (start >= end) fail('INVALID_OPTIONS'); }
  catch { fail('INVALID_OPTIONS'); }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10000 ||
      !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 20000000 ||
      !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PAGE_BYTES) fail('INVALID_OPTIONS');
  let initial;
  try { initial = `${ORIGIN}${PREFIX}${cphMidnightUnix(start)}`; } catch { fail('INVALID_OPTIONS'); }
  let next = initial, pages = 0, rows = 0, reviewCount = 0, sanitizedRows = 0;
  let declaredTotal, declaredLast, declaredPageSize;
  const seen = new Set();
  while (next !== null) {
    checkSignal(signal);
    if (pages >= maxPages) fail('PAGE_LIMIT');
    const key = createHash('sha256').update(next).digest('hex');
    if (seen.has(key)) fail('PAGINATION_LOOP'); seen.add(key);
    let body;
    try { body = await request(next, { signal, maxBytes }); }
    catch (error) { checkSignal(signal); if (error instanceof ImportError) throw safeError(error); fail('UPSTREAM_FAILED'); }
    const envelope = parseLossless(body, { maxBytes }); body = null;
    if (!envelope || Array.isArray(envelope) || !Array.isArray(envelope.data) ||
        envelope.data.length > 10000 || envelope.current_page !== String(pages + 1) ||
        !Object.hasOwn(envelope, 'next_page_url') ||
        (Object.hasOwn(envelope, 'success') && envelope.success !== true)) fail('INVALID_PAGE');
    const rawNext = envelope.next_page_url;
    if (Object.hasOwn(envelope, 'last_page') && (!/^[1-9]\d{0,4}$/.test(envelope.last_page) ||
        Number(envelope.last_page) < pages + 1 ||
        (rawNext === null) !== (Number(envelope.last_page) === pages + 1))) fail('INVALID_PAGE');
    if (Object.hasOwn(envelope, 'last_page')) {
      if (declaredLast !== undefined && declaredLast !== envelope.last_page) fail('INVALID_PAGE');
      declaredLast = envelope.last_page;
    }
    if (Object.hasOwn(envelope, 'total')) {
      if (typeof envelope.total !== 'string' || !/^(0|[1-9]\d{0,7})$/.test(envelope.total) ||
          (declaredTotal !== undefined && declaredTotal !== envelope.total)) fail('INVALID_PAGE');
      declaredTotal = envelope.total;
    }
    if (Object.hasOwn(envelope, 'per_page')) {
      if (typeof envelope.per_page !== 'string' || !/^[1-9]\d{0,4}$/.test(envelope.per_page) ||
          Number(envelope.per_page) > 10000 || envelope.data.length > Number(envelope.per_page) ||
          (declaredPageSize !== undefined && declaredPageSize !== envelope.per_page)) fail('INVALID_PAGE');
      declaredPageSize = envelope.per_page;
    }
    if (declaredTotal !== undefined && declaredLast !== undefined && declaredPageSize !== undefined &&
        Number(declaredLast) !== Math.max(1, Math.ceil(Number(declaredTotal) / Number(declaredPageSize)))) fail('INVALID_PAGE');
    if (rawNext !== null) {
      if (typeof rawNext === 'string' && seen.has(createHash('sha256').update(rawNext).digest('hex'))) fail('PAGINATION_LOOP');
      next = continuation(rawNext, initial, pages + 2);
    } else next = null; // Only explicit JSON null is a terminal page.
    pages++;
    let batch = [];
    for (let position = 0; position < envelope.data.length; position++) {
      checkSignal(signal); if (++rows > maxRows) fail('ROW_LIMIT');
      const raw = envelope.data[position]; envelope.data[position] = null;
      // Store and calendar/DST validity are mandatory even for ignored rows.
      // The diagnostic alone inspects all dates; ordinary traversal never reads
      // identity, catalogue or monetary fact fields outside [start, end).
      if (!inspectAllDates) {
        const { businessDate } = readLineTime(raw, companyId);
        if (businessDate < start || businessDate >= end) continue;
      }
      let line;
      try { line = normalizeLine(raw, { storeSlug, companyId, context }); }
      catch (error) {
        if (error.code !== 'CATALOG_REVIEW') throw error;
        reviewCount++; continue; // No unreviewed text is retained, even in staging.
      }
      batch.push({ line, page: pages, position });
      sanitizedRows++;
      if (batch.length === batchSize) { await sink.batch(batch); batch = []; }
    }
    if (batch.length) await sink.batch(batch);
    await sink.progress({ pages, rows, reviewCount, sanitizedRows });
  }
  if (declaredTotal !== undefined && Number(declaredTotal) !== rows) fail('INVALID_PAGE');
  // A diagnostic may observe terminal proof without treating CATALOG_REVIEW as
  // successful validation. No callback can bypass the importer failure below.
  if (sink.terminal) await sink.terminal({ terminal: true, pages, rows, reviewCount });
  if (reviewCount) fail('CATALOG_REVIEW');
  return { terminal: true, pages, rows, reviewCount };
}
module.exports = { traverse, continuation, ORIGIN, PREFIX };
