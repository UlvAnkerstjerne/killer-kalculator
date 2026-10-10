'use strict';

const { storeId, STORES: STORE_SLUGS } = require('./values');

const STORES = Object.freeze([
  { slug: 'indre-by', name: 'Indre By', aliases: ['indre by'] },
  { slug: 'vesterbro', name: 'Vesterbro', aliases: ['vesterbro'] },
  { slug: 'christianshavn', name: 'Christianshavn', aliases: ['christianshavn'] },
  { slug: 'fisketorvet', name: 'Fisketorvet', aliases: ['fisketorvet'] },
  { slug: 'frederiksberg', name: 'Frederiksberg', aliases: ['frederiksberg'] },
  { slug: 'norrebro', name: 'Nørrebro', aliases: ['norrebro', 'nørrebro'] },
]);
const WEEKDAYS = Object.freeze([
  { iso: 1, name: 'Monday', aliases: ['monday', 'mondays', 'mandag', 'mandage'] },
  { iso: 2, name: 'Tuesday', aliases: ['tuesday', 'tuesdays', 'tirsdag', 'tirsdage'] },
  { iso: 3, name: 'Wednesday', aliases: ['wednesday', 'wednesdays', 'onsdag', 'onsdage'] },
  { iso: 4, name: 'Thursday', aliases: ['thursday', 'thursdays', 'torsdag', 'torsdage'] },
  { iso: 5, name: 'Friday', aliases: ['friday', 'fridays', 'fredag', 'fredage'] },
  { iso: 6, name: 'Saturday', aliases: ['saturday', 'saturdays', 'lørdag', 'lørdage', 'lordag', 'lordage'] },
  { iso: 7, name: 'Sunday', aliases: ['sunday', 'sundays', 'søndag', 'søndage', 'sondag', 'sondage'] },
]);

function normalized(value) {
  return String(value || '').toLocaleLowerCase('da-DK').replace(/[?!.,]/g, ' ').replace(/\s+/g, ' ').trim();
}
function hasPhrase(text, phrase) { return (` ${text} `).includes(` ${phrase} `); }

function parseRecordsQuestion(question) {
  if (typeof question !== 'string' || !question.trim() || question.length > 200) {
    return { ok: false, code: 'INVALID_QUESTION', message: 'Write a question of no more than 200 characters.' };
  }
  const text = normalized(question);
  const wantsBest = /\b(best|highest|top|bedste|højeste|hojeste)\b/.test(text);
  if (!wantsBest) return { ok: false, code: 'UNSUPPORTED_QUESTION', message: 'For now, ask for a best or top revenue day.' };

  const countMatch = text.match(/\btop\s+(\d{1,2})\b/);
  const limit = countMatch ? Number(countMatch[1]) : 1;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    return { ok: false, code: 'INVALID_LIMIT', message: 'Choose between top 1 and top 10.' };
  }
  const weekday = WEEKDAYS.find(day => day.aliases.some(alias => hasPhrase(text, alias))) || null;
  const chain = ['across the chain', 'across chain', 'all stores', 'all six stores', 'hele kæden', 'hele kaeden', 'alle butikker']
    .some(alias => hasPhrase(text, alias));
  const stores = STORES.filter(store => store.aliases.some(alias => hasPhrase(text, alias)));
  if (chain && stores.length) {
    return { ok: false, code: 'AMBIGUOUS_SCOPE', message: 'Choose either one store or all stores.' };
  }
  if (!chain && stores.length !== 1) {
    return { ok: false, code: 'MISSING_SCOPE', message: 'Name one store, or write “across the chain”.' };
  }
  return { ok: true, query: {
    scope: chain ? 'chain' : 'store', store: chain ? null : stores[0],
    weekday: weekday ? { iso: weekday.iso, name: weekday.name } : null,
    limit, metric: 'revenueExVat', direction: 'best',
  } };
}

const ELIGIBLE = `((d.status = 'complete' AND d.evidence IN
  ('complete-single-pass','independently-verified','verified-empty')) OR
  (d.status = 'VERIFIED_CLOSED' AND d.evidence = 'verified-closed' AND d.line_count = 0))`;

async function queryRecords(session, query, today) {
  // The dashboard role has column grants on day state, not sales_store.
  // Migration 001 constrains these IDs to values.js; readiness checks its checksum.
  const weekday = query.weekday?.iso || null;
  if (query.scope === 'store') {
    const { rows } = await session.query(`SELECT d.business_date::text AS date,
        extract(isodow FROM d.business_date)::integer AS "weekdayIso",
        d.revenue_excl::text AS "revenueExVat"
      FROM sales_foundation.sales_day_state d
      WHERE d.store_id = $1 AND d.business_date < $2 AND ${ELIGIBLE}
        AND d.line_count > 0
        AND ($3::integer IS NULL OR extract(isodow FROM d.business_date)::integer = $3)
      ORDER BY d.revenue_excl DESC, d.business_date ASC LIMIT $4`,
    [storeId(query.store.slug), today, weekday, query.limit]);
    return rows.map(row => ({ date: row.date, weekdayIso: row.weekdayIso,
      revenueExVat: Number(row.revenueExVat), stores: [{ slug: query.store.slug, name: query.store.name, revenueExVat: Number(row.revenueExVat) }] }));
  }
  const { rows } = await session.query(`WITH eligible AS (
      SELECT d.business_date, d.store_id, d.revenue_excl
      FROM sales_foundation.sales_day_state d
      WHERE d.business_date < $1 AND ${ELIGIBLE}
        AND ($2::integer IS NULL OR extract(isodow FROM d.business_date)::integer = $2)
    ), ranked AS (
      SELECT business_date, sum(revenue_excl) AS revenue_excl
      FROM eligible GROUP BY business_date HAVING count(*) = 6
      ORDER BY sum(revenue_excl) DESC, business_date ASC LIMIT $3
    )
    SELECT r.business_date::text AS date,
      extract(isodow FROM r.business_date)::integer AS "weekdayIso",
      r.revenue_excl::text AS "revenueExVat", e.store_id AS "storeId",
      e.revenue_excl::text AS "storeRevenueExVat"
    FROM ranked r JOIN eligible e USING (business_date)
    ORDER BY r.revenue_excl DESC, r.business_date ASC, e.store_id ASC`, [today, weekday, query.limit]);
  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.date)) byDate.set(row.date, { date: row.date, weekdayIso: row.weekdayIso,
      revenueExVat: Number(row.revenueExVat), stores: [] });
    const slug = STORE_SLUGS[row.storeId - 1];
    const store = STORES.find(item => item.slug === slug);
    byDate.get(row.date).stores.push({ slug, name: store.name, revenueExVat: Number(row.storeRevenueExVat) });
  }
  return [...byDate.values()].map(result => ({ ...result,
    stores: result.stores.sort((a, b) => a.slug.localeCompare(b.slug)),
  }));
}

module.exports = { STORES, WEEKDAYS, parseRecordsQuestion, queryRecords };
