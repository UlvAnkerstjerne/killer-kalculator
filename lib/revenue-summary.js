'use strict';

function secondOfDayFromLine(line) {
  const value = line?.timestamp_pay ?? line?.datetime ?? null;
  if (typeof value !== 'string') return null;
  const match = /[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return hour * 3600 + minute * 60 + second;
}

function revenueValue(line) {
  const value = Number(line?.priceexclvat);
  return Number.isFinite(value) ? value : 0;
}

function buildRevenueSummaryResult(source) {
  if (!source || !Array.isArray(source.lines) || !source.meta) {
    throw new TypeError('A sales-range result is required');
  }

  const days = new Map();
  let completeRevenue = 0;

  for (const line of source.lines) {
    const date = line?._cphDate;
    if (typeof date !== 'string') continue;
    const revenue = revenueValue(line);
    completeRevenue += revenue;

    let day = days.get(date);
    if (!day) {
      day = { revenue: 0, seconds: new Map(), missingTimeLineCount: 0 };
      days.set(date, day);
    }
    day.revenue += revenue;

    const secondOfDay = secondOfDayFromLine(line);
    if (secondOfDay === null) {
      day.missingTimeLineCount++;
    } else {
      day.seconds.set(secondOfDay, (day.seconds.get(secondOfDay) || 0) + revenue);
    }
  }

  const daily = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, day]) => ({
      date,
      revenue: day.revenue,
      seconds: [...day.seconds.entries()].sort((a, b) => a[0] - b[0]),
      missingTimeLineCount: day.missingTimeLineCount,
    }));

  return {
    // createSalesRangeCache validates this common envelope. The source lines are
    // intentionally discarded; only the compact aggregate is retained.
    lines: [],
    summary: { completeRevenue, daily },
    meta: { ...source.meta },
  };
}

function publicRevenueSummary(result, boundaryDate = null) {
  const dailyRevenue = result.summary.daily.map(day => ({
    date: day.date,
    revenue: day.revenue,
  }));
  const boundaryDay = boundaryDate
    ? result.summary.daily.find(day => day.date === boundaryDate)
    : null;

  return {
    completeRevenue: result.summary.completeRevenue,
    dailyRevenue,
    boundary: boundaryDate ? {
      date: boundaryDate,
      seconds: boundaryDay?.seconds || [],
      missingTimeLineCount: boundaryDay?.missingTimeLineCount || 0,
    } : null,
  };
}

function deriveRevenueSummarySubrange(parent, start, end) {
  if (!parent?.meta?.complete || !parent.summary || start >= end ||
      start < parent.meta.start || end > parent.meta.end) return null;
  const daily = parent.summary.daily.filter(day => day.date >= start && day.date < end);
  return {
    lines: [],
    summary: { daily, completeRevenue: daily.reduce((sum, day) => sum + day.revenue, 0) },
    meta: { ...parent.meta, start, end,
      derivedFrom: { start: parent.meta.start, end: parent.meta.end } },
  };
}

module.exports = {
  secondOfDayFromLine,
  buildRevenueSummaryResult,
  publicRevenueSummary,
  deriveRevenueSummarySubrange,
};
