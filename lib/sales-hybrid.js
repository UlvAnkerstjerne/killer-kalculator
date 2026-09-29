'use strict';
const { metricCoverage } = require('./sales-metric-coverage');

function unavailable(selection, code = 'HYBRID_READ_UNAVAILABLE') {
  const { result, providerRange, ...safe } = selection;
  return { ...safe, complete: false, code,
    coverage: { kind: 'hybrid-range', complete: false, start: safe.start, end: safe.end },
    segments: [{ source: 'database', start: safe.start, end: providerRange.start },
      { source: 'onlinepos', ...providerRange }] };
}
function composeMeta(selection, cached) {
  const stored = selection.result.meta, live = cached.result.meta, p = selection.providerRange;
  if (!stored.complete || !live.complete || stored.start !== selection.start || stored.end !== p.start ||
      live.start !== p.start || live.end !== selection.end || live.invalidCount || live.conflicts?.length) {
    const error = new Error('Hybrid sales unavailable'); error.hybridReadMeta = unavailable(selection); throw error;
  }
  const { result, providerRange, ...safe } = selection;
  const liveSegment = { source: 'onlinepos', ...p, complete: true,
    coverage: { kind: 'provider-range', complete: true, ...p }, cacheStatus: cached.cacheStatus,
    stale: cached.stale, cacheAgeMs: cached.fetchedAt === null ? 0 : Math.max(0,Date.now()-cached.fetchedAt) };
  return { ...safe, complete: true, pages: live.pages, rawLineCount: stored.rawLineCount + live.rawLineCount,
    processedLineCount: stored.processedLineCount + live.processedLineCount, outOfRange: live.outOfRange || 0,
    duplicatesRemoved: live.duplicatesRemoved || 0, invalidCount: 0, conflictCount: 0,
    cacheStatus: 'hybrid-snapshot', stale: liveSegment.stale, cacheAgeMs: liveSegment.cacheAgeMs,
    coverage: { kind: 'hybrid-range', complete: true, start: safe.start, end: safe.end },
    segments: [{ source: 'database', start: safe.start, end: p.start, complete: true,
      coverage: stored.coverage, freshness: stored.freshness }, liveSegment] };
}
function composeLines(selection, cached, liveLines) {
  const meta = composeMeta(selection,cached), p = selection.providerRange;
  const stored = selection.result.lines;
  if (stored.some(l=>typeof l.date !== 'string' || l.date < selection.start || l.date >= p.start) ||
      liveLines.some(l=>typeof l.date !== 'string' || l.date < p.start || l.date >= p.end)) {
    const error = new Error('Hybrid boundary mismatch'); error.hybridReadMeta = unavailable(selection); throw error;
  }
  const lines = [...stored,...liveLines];
  return { lines, meta: { ...meta, metrics: metricCoverage(lines,selection.storeId) } };
}
function composeRevenue(selection,cached,storedSummary) {
  const meta = composeMeta(selection,cached), p = selection.providerRange;
  const oldDays=storedSummary.summary.daily, liveDays=cached.result.summary.daily;
  if (oldDays.some(d=>d.date < selection.start || d.date >= p.start) || liveDays.some(d=>d.date < p.start || d.date >= p.end)) {
    const error = new Error('Hybrid boundary mismatch'); error.hybridReadMeta = unavailable(selection); throw error;
  }
  return { lines: [], summary: { daily: [...oldDays,...liveDays],
    completeRevenue: storedSummary.summary.completeRevenue + cached.result.summary.completeRevenue }, meta };
}
module.exports = { composeLines, composeRevenue, unavailable };
