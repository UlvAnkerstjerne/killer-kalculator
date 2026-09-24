'use strict';
// Synthetic bounded-memory experiment against the guarded disposable database.
// This is not a throughput benchmark and cannot contact a provider.
const { importHistory } = require('../lib/sales-sync/importer');
const { context, options, initial, raw, body } = require('../test/sales-sync/helpers');
async function simulate(config, totalRows = 100000) {
  if (!Number.isInteger(totalRows) || totalRows < 1000 || totalRows > 100000) throw new Error('Invalid synthetic simulation size');
  let peakHeap = process.memoryUsage().heapUsed, peakRss = process.memoryUsage().rss;
  let earlyPeak = peakHeap, latePeak = peakHeap, rowsBuiltAtOnce = 0, pages = 0;
  const measure = () => {
    const usage = process.memoryUsage(); peakHeap = Math.max(peakHeap, usage.heapUsed); peakRss = Math.max(peakRss, usage.rss);
    if (pages < totalRows / 2000) earlyPeak = Math.max(earlyPeak, usage.heapUsed); else latePeak = Math.max(latePeak, usage.heapUsed);
  };
  const timer = setInterval(measure, 10);
  try {
    const result = await importHistory({ config, context, options, apply: true, report: measure,
      request: async url => {
        const page = Number(new URL(url).searchParams.get('page') || '1'), offset = (page - 1) * 1000;
        const size = Math.min(1000, totalRows - offset); pages++;
        const rows = Array.from({ length: size }, (_, i) => raw({ orderlineid: 'synthetic-large-' + (offset + i),
          timestamp_pay: `2025-01-${String(1 + (i % 20)).padStart(2, '0')} 12:00:00` }));
        rowsBuiltAtOnce = Math.max(rowsBuiltAtOnce, rows.length); measure();
        return body(rows, page, offset + size < totalRows ? initial + '?page=' + (page + 1) : null);
      } });
    measure();
    return { rows: result.lineCount, pages, rowsBuiltAtOnce, stagingBatchLimit: 250,
      peakHeapBytes: peakHeap, peakRssBytes: peakRss, earlyPeakHeapBytes: earlyPeak, latePeakHeapBytes: latePeak };
  } finally { clearInterval(timer); }
}
module.exports = { simulate };
