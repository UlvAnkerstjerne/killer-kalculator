'use strict';
const cphDateStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// Whole-range routing only. An unavailable/invalid database is never a reason
// to consult the provider. Only proven missing coverage permits that route.
async function selectSalesRead(reader, { storeSlug, start, end, today = cphDateStr() }) {
  const policy = reader?.policy || (reader ? 'database-only' : 'provider-only');
  const base = { storeId: storeSlug, start, end, readPolicy: policy };
  if (!reader || (policy === 'covered-history' && end > today && start >= today)) {
    return { ...base, source: 'onlinepos', routeReason: reader ? 'includes-open-day' : 'provider-selected',
      databaseCoverage: { checked: false, complete: false, days: [], reason: reader ? 'open-range' : 'policy-disabled' } };
  }
  // Hybrid: range spans both covered history and today. Split at today boundary.
  if (policy === 'covered-history' && end > today && start < today) {
    try {
      const dbResult = await reader.read({ storeSlug, start, end: today });
      if (dbResult.meta.complete) {
        const dbCoverage = { ...dbResult.meta.coverage, checked: true };
        dbResult.meta = { ...dbResult.meta, ...base, start, end: today, routeReason: 'stored-historical-range', databaseCoverage: dbCoverage };
        return { ...base, source: 'hybrid', dbResult, todayStart: today, todayEnd: end,
          routeReason: 'hybrid-covered-history-plus-today',
          databaseCoverage: dbCoverage };
      }
      // Historical days incomplete — check if it's a valid coverage miss
      const days = dbResult.meta.coverage?.days || [];
      const expected = Math.round((Date.parse(today) - Date.parse(start)) / 86400000);
      if (dbResult.meta.code === 'DB_COVERAGE_INCOMPLETE' && days.length === expected &&
          days.every((d,i) => d.date === new Date(Date.parse(start)+i*86400000).toISOString().slice(0,10) && ['complete','missing'].includes(d.status)) &&
          days.some(d => d.status === 'missing')) {
        return { ...base, source: 'onlinepos', routeReason: 'uncovered-range',
          databaseCoverage: { ...dbResult.meta.coverage, checked: true } };
      }
      throw new Error('INVALID_COVERAGE');
    } catch {
      const error = new Error('Stored sales unavailable; no provider fallback');
      error.salesReadMeta = { ...base, source: 'database', complete: false, code: 'DB_READ_UNAVAILABLE',
        routeReason: 'database-error', databaseCoverage: { checked: false, complete: false, days: [], reason: 'database-error' } };
      throw error;
    }
  }
  try {
    const result = await reader.read({ storeSlug, start, end });
    const coverage = { ...result.meta.coverage, checked: true };
    if (policy === 'covered-history' && !result.meta.complete) {
      // Accept only an explicit, day-by-day coverage miss, never a reader error,
      // invalid observation, schema mismatch, or unknown incomplete response.
      const days = coverage.days || [];
      const expected = Math.round((Date.parse(end) - Date.parse(start)) / 86400000);
      if (result.meta.code !== 'DB_COVERAGE_INCOMPLETE' || days.length !== expected ||
          days.some((d,i) => d.date !== new Date(Date.parse(start)+i*86400000).toISOString().slice(0,10) || !['complete','missing'].includes(d.status)) ||
          !days.some(d=>d.status === 'missing')) throw new Error('INVALID_COVERAGE');
      return { ...base, source: 'onlinepos', routeReason: 'uncovered-range', databaseCoverage: coverage };
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
