'use strict';

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
  if (!wantsBest) return { ok: false, code: 'UNSUPPORTED_QUESTION', message: 'Ask for a best or top revenue day, week, month or lunch.' };

  const countMatch = text.match(/\btop\s+(\d+)\b/);
  const limit = countMatch ? Number(countMatch[1]) : 1;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    return { ok: false, code: 'INVALID_LIMIT', message: 'Choose between top 1 and top 10.' };
  }
  const weekdays = WEEKDAYS.filter(day => day.aliases.some(alias => hasPhrase(text, alias)));
  const periods = [
    ['day', ['day', 'days', 'dag', 'dage']],
    ['week', ['week', 'weeks', 'uge', 'uger']],
    ['month', ['month', 'months', 'måned', 'måneder', 'maaned', 'maaneder']],
  ].filter(([, aliases]) => aliases.some(alias => hasPhrase(text, alias)));
  const period = periods[0]?.[0] || 'day';
  const daypart = ['lunch', 'lunches', 'frokost'].some(alias => hasPhrase(text, alias)) ? 'lunch' : 'full-day';
  if (periods.length > 1 || weekdays.length > 1 || (period !== 'day' && (weekdays.length || daypart === 'lunch'))) {
    return { ok: false, code: 'AMBIGUOUS_PERIOD', message: 'Choose a whole week or month, or a daily record with an optional weekday and lunch filter.' };
  }
  if (['year', 'years', 'yearly', 'annual', 'år', 'dinner', 'breakfast'].some(word => hasPhrase(text, word))) {
    return { ok: false, code: 'UNSUPPORTED_PERIOD', message: 'Choose days, weeks, months or lunch.' };
  }
  const weekday = weekdays[0] || null;
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
    limit, period, daypart, metric: 'revenueExVat', direction: 'best',
  } };
}

function queryRecords(session, query, today, now = Date.now()) {
  // Keep parser-only web startup independent of database/aggregation modules.
  return require('./records-query').queryRecords(session, query, today, now);
}

module.exports = { STORES, WEEKDAYS, parseRecordsQuestion, queryRecords };
