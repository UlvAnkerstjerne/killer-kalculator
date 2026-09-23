'use strict';

function deriveSalesSubrange(parent, start, end) {
  if (!parent || !Array.isArray(parent.lines) || !parent.meta?.complete) return null;
  if (typeof start !== 'string' || typeof end !== 'string' || start >= end) return null;
  if (start < parent.meta.start || end > parent.meta.end) return null;

  const lines = parent.lines.filter(line => (
    typeof line?._cphDate === 'string' && line._cphDate >= start && line._cphDate < end
  ));

  return {
    lines,
    meta: {
      ok: true,
      complete: true,
      pages: parent.meta.pages,
      rawLineCount: lines.length,
      processedLineCount: lines.length,
      outOfRange: 0,
      duplicatesRemoved: 0,
      invalidCount: 0,
      conflicts: [],
      start,
      end,
      derivedFrom: { start: parent.meta.start, end: parent.meta.end },
    },
  };
}

module.exports = { deriveSalesSubrange };
