'use strict';
const cphDateStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// Split only at the Copenhagen date boundary, and only when the complete closed
// prefix is stored. An unavailable/invalid database never permits fallback.
async function selectSalesRead(reader, { storeSlug, start, end, today = cphDateStr(), projection = null, boundary = null }) {
  const policy = reader?.policy || (reader ? 'database-only' : 'provider-only');
  const base = { storeId: storeSlug, start, end, readPolicy: policy };
  const tomorrow = new Date(Date.parse(today) + 86400000).toISOString().slice(0,10);
  const hybrid = policy === 'covered-history' && start < today && end === tomorrow;
  if (!reader || (policy === 'covered-history' && end > today && !hybrid)) {
    return { ...base, source: 'onlinepos', routeReason: reader ? 'includes-open-day' : 'provider-selected',
      databaseCoverage: { checked: false, complete: false, days: [], reason: reader ? 'open-range' : 'policy-disabled' } };
  }
  try {
    const storedEnd = hybrid ? today : end;
    const result = await reader.read({ storeSlug, start, end: storedEnd, ...(projection ? {projection,boundary} : {}) });
    const coverage = { ...result.meta.coverage, checked: true };
    if (policy === 'covered-history' && !result.meta.complete) {
      // Accept only an explicit, day-by-day coverage miss, never a reader error,
      // invalid observation, schema mismatch, or unknown incomplete response.
      const days = coverage.days || [];
      const expected = Math.round((Date.parse(storedEnd) - Date.parse(start)) / 86400000);
      if (result.meta.code !== 'DB_COVERAGE_INCOMPLETE' || days.length !== expected ||
          days.some((d,i) => d.date !== new Date(Date.parse(start)+i*86400000).toISOString().slice(0,10) || !['complete','missing'].includes(d.status)) ||
          !days.some(d=>d.status === 'missing')) throw new Error('INVALID_COVERAGE');
      return { ...base, source: 'onlinepos', routeReason: 'uncovered-range', databaseCoverage: coverage };
    }
    if (hybrid) {
      const dates = coverage.days || [];
      const expected = Math.round((Date.parse(today) - Date.parse(start)) / 86400000);
      if (!coverage.complete || dates.length !== expected || dates.some((d,i) => d.status !== 'complete' ||
          d.date !== new Date(Date.parse(start)+i*86400000).toISOString().slice(0,10))) throw new Error('INVALID_COVERAGE');
      return { ...base, source: 'hybrid', routeReason: 'stored-history-plus-today', databaseCoverage: coverage,
        result, providerRange: { start: today, end } };
    }
    result.meta = { ...result.meta, ...base, routeReason: 'stored-historical-range', databaseCoverage: coverage };
    return { ...base, source: 'database', result };
  } catch {
    const error = new Error('Stored sales unavailable; no provider fallback');
    error.salesReadMeta = { ...base, source: 'database', complete: false, code: 'DB_READ_UNAVAILABLE',
      routeReason: 'database-error', databaseCoverage: { checked: false, complete: false, days: [], reason: 'database-error' } };
    throw error;
  }
}
function providerReadMeta(selection, complete) {
  return { ...selection, complete, coverage: { kind: 'provider-range', complete, start: selection.start, end: selection.end } };
}
module.exports = { selectSalesRead, providerReadMeta };
