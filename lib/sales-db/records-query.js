'use strict';

const { STORES } = require('./records');
const { storeId, date: validateDate, cphLocal } = require('./values');
const { units, amount } = require('../sales-sync/checksums');

// UTC arithmetic here operates on calendar labels, never on elapsed Copenhagen
// hours. A DST week still has seven dates; local transaction times stay local.
function offset(date, days) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function weekday(date) { return new Date(date + 'T12:00:00Z').getUTCDay() || 7; }
function periodStart(date, period) {
  return period === 'month' ? date.slice(0, 7) + '-01' : period === 'week' ? offset(date, 1 - weekday(date)) : date;
}
function periodNext(start, period) {
  if (period !== 'month') return offset(start, period === 'week' ? 7 : 1);
  const d = new Date(start + 'T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}
function coverageIssue(day, now) {
  if (!day) return 'missingCoverage';
  const evidence = (day.status === 'complete' && ['complete-single-pass', 'independently-verified', 'verified-empty'].includes(day.evidence)) ||
    (day.status === 'VERIFIED_CLOSED' && day.evidence === 'verified-closed' && day.lineCount === 0);
  if (!evidence) return 'unverifiedCoverage';
  const observed = new Date(day.observedAt).getTime();
  if (!Number.isFinite(observed) || observed > now || cphLocal(observed).slice(0, 10) <= day.date) return 'invalidObservation';
  return null;
}
function publicAmount(value) {
  const result = Number(amount(value));
  if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) throw new Error('DB_NUMERIC_UNREPRESENTABLE');
  return result;
}
const key = (id, date) => `${id}:${date}`;

function buildRanking(states, lunchRows, query, today, now = Date.now()) {
  const period = query.period || 'day', lunch = query.daypart === 'lunch';
  const stores = query.scope === 'chain' ? STORES : STORES.filter(s => s.slug === query.store.slug);
  const ids = new Set(stores.map(s => storeId(s.slug)));
  const history = states.filter(s => ids.has(s.storeId) && s.date < today).sort((a, b) => a.date.localeCompare(b.date));
  const days = new Map(history.map(s => [key(s.storeId, s.date), s]));
  const facts = new Map(lunchRows.map(s => [key(s.storeId, s.date), s]));
  const cutoff = periodStart(today, period);
  const first = history.length ? periodStart(history[0].date, period) : null;
  const storeCoverage = stores.map(store => {
    const own = history.filter(s => s.storeId === storeId(store.slug));
    return { slug: store.slug, name: store.name, historyFrom: own[0]?.date || null,
      historyThrough: own.at(-1)?.date || null, eligibleDays: 0, eligibleFrom: null, eligibleThrough: null };
  });
  const coverage = {
    timeZone: 'Europe/Copenhagen', period, daypart: lunch ? 'lunch' : 'full-day',
    historyFrom: history[0]?.date || null, historyThrough: history.at(-1)?.date || null,
    consideredFrom: first && first < cutoff ? first : null, consideredThrough: first && first < cutoff ? offset(cutoff, -1) : null,
    cutoffExclusive: cutoff, eligibleFrom: null, eligibleThrough: null,
    consideredPeriods: 0, eligiblePeriods: 0, excludedPeriods: 0,
    exclusions: {}, excludedExamples: [], excludedExamplesOmitted: 0, stores: storeCoverage,
    timing: lunch ? { cutoffExclusive: '16:00', policy: 'payment-only', uncertainLines: 0,
      missingLines: 0, fallbackLines: 0, ambiguousLines: 0 } : null,
  };
  const candidates = [];
  for (let start = first; start && start < cutoff; start = periodNext(start, period)) {
    if (query.weekday && weekday(start) !== query.weekday.iso) continue;
    const end = periodNext(start, period), issues = new Map(), breakdown = [];
    coverage.consideredPeriods++;
    const issue = (code, slug) => {
      if (!issues.has(code)) issues.set(code, { code, storeDays: 0, stores: new Set() });
      const value = issues.get(code); value.storeDays++; value.stores.add(slug);
    };
    for (const [index, store] of stores.entries()) {
      let revenue = 0n;
      for (let date = start; date < end; date = offset(date, 1)) {
        const day = days.get(key(storeId(store.slug), date));
        const invalid = coverageIssue(day, now);
        if (invalid) { issue(invalid, store.slug); continue; }
        let value = units(day.revenueExVat);
        if (lunch) {
          const fact = facts.get(key(day.storeId, date));
          const uncertain = Number(fact?.uncertainCount || 0);
          coverage.timing.uncertainLines += uncertain;
          coverage.timing.missingLines += Number(fact?.missingCount || 0);
          coverage.timing.fallbackLines += Number(fact?.fallbackCount || 0);
          coverage.timing.ambiguousLines += Number(fact?.ambiguousCount || 0);
          const mismatch = Number(fact?.lineCount || 0) !== day.lineCount ||
            units(fact?.revenueExVat || '0') !== value || units(fact?.revenueIncl || '0') !== units(day.revenueIncl);
          if (mismatch) issue('factsMismatch', store.slug);
          if (uncertain) issue('timestampUncertainty', store.slug);
          if (mismatch || uncertain) continue;
          // An absent fact aggregate is zero only after the published zero count
          // AND both published totals have reconciled above (including closures).
          value = units(fact?.lunchRevenue || '0');
        }
        const available = storeCoverage[index];
        available.eligibleDays++; available.eligibleFrom ||= date; available.eligibleThrough = date;
        // Preserve the original single-store daily ranking's nonempty-day rule.
        if (!lunch && period === 'day' && query.scope === 'store' && day.lineCount === 0) issue('noSales', store.slug);
        revenue += value;
      }
      breakdown.push({ slug: store.slug, name: store.name, revenue });
    }
    if (issues.size) {
      coverage.excludedPeriods++;
      const reasons = [...issues.values()].map(v => ({ ...v, stores: [...v.stores].sort() }));
      for (const reason of reasons) {
        coverage.exclusions[reason.code] ||= { periods: 0, storeDays: 0 };
        coverage.exclusions[reason.code].periods++;
        coverage.exclusions[reason.code].storeDays += reason.storeDays;
      }
      if (coverage.excludedExamples.length < 12) coverage.excludedExamples.push({ periodStart: start, periodEnd: offset(end, -1), reasons });
      else coverage.excludedExamplesOmitted++;
      continue;
    }
    coverage.eligiblePeriods++;
    coverage.eligibleFrom ||= start; coverage.eligibleThrough = offset(end, -1);
    candidates.push({ date: start, periodStart: start, periodEnd: offset(end, -1), weekdayIso: weekday(start),
      revenue: breakdown.reduce((sum, s) => sum + s.revenue, 0n), stores: breakdown });
  }
  candidates.sort((a, b) => a.revenue === b.revenue ? a.date.localeCompare(b.date) : a.revenue > b.revenue ? -1 : 1);
  const results = candidates.slice(0, query.limit).map(({ revenue, stores: breakdown, ...result }) => ({ ...result,
    revenueExVat: publicAmount(revenue), stores: breakdown.map(({ revenue: value, ...store }) => ({ ...store,
      revenueExVat: publicAmount(value) })).sort((a, b) => a.slug.localeCompare(b.slug)),
  }));
  return { results, coverage };
}

async function queryRecords(session, query, today, now = Date.now()) {
  validateDate(today);
  const ids = query.scope === 'chain' ? STORES.map(s => storeId(s.slug)) : [storeId(query.store.slug)];
  // These are the existing dashboard's column grants. Never join sales_store.
  const { rows: states } = await session.query(`SELECT store_id AS "storeId", business_date::text AS date,
    status, evidence, line_count AS "lineCount", source_observed_at AS "observedAt",
    revenue_incl::text AS "revenueIncl", revenue_excl::text AS "revenueExVat"
    FROM sales_foundation.sales_day_state WHERE store_id = ANY($1::smallint[]) AND business_date < $2
    ORDER BY business_date, store_id`, [ids, today]);
  let lunchRows = [];
  if (query.daypart === 'lunch' && states.length) {
    // Summarize transaction lines in PostgreSQL; no raw history/identities reach
    // Node or the browser. Compare count and exact totals with published coverage.
    const { rows } = await session.query(`SELECT l.store_id AS "storeId", l.business_date::text AS date,
      count(*)::integer AS "lineCount", sum(l.revenue_incl)::text AS "revenueIncl",
      sum(l.revenue_excl)::text AS "revenueExVat",
      count(*) FILTER (WHERE l.time_quality <> 'payment' OR l.sale_local IS NULL OR l.second_of_day IS NULL)::integer AS "uncertainCount",
      count(*) FILTER (WHERE l.time_quality = 'missing')::integer AS "missingCount",
      count(*) FILTER (WHERE l.time_quality IN ('fallback','fallback_ambiguous'))::integer AS "fallbackCount",
      count(*) FILTER (WHERE l.time_quality IN ('payment_ambiguous','fallback_ambiguous'))::integer AS "ambiguousCount",
      coalesce(sum(l.revenue_excl) FILTER (WHERE l.time_quality = 'payment' AND l.second_of_day < 57600),0)::text AS "lunchRevenue"
      FROM sales_foundation.sales_line l
      WHERE l.store_id = ANY($1::smallint[]) AND l.business_date >= $2 AND l.business_date < $3
        AND l.reconciliation_state = 'active'
        AND ($4::integer IS NULL OR extract(isodow FROM l.business_date)::integer = $4)
      GROUP BY l.store_id, l.business_date`, [ids, states[0].date, today, query.weekday?.iso || null]);
    lunchRows = rows;
  }
  return buildRanking(states, lunchRows, query, today, now);
}

module.exports = { queryRecords, buildRanking, periodStart, periodNext, coverageIssue };
