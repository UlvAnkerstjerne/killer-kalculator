'use strict';
// Shared public leaderboard IDs and links. No database or business data here.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RecordsLeaderboards = factory();
})(typeof window === 'object' ? window : this, function () {
  const STORES = ['all', 'indre-by', 'vesterbro', 'christianshavn', 'fisketorvet', 'frederiksberg', 'norrebro'];
  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const BOARDS = Object.freeze([
    { id: 'days', title: 'Best days', period: 'day', description: 'Individual calendar dates' },
    { id: 'weeks', title: 'Best weeks', period: 'week', description: 'Complete Monday–Sunday weeks' },
    { id: 'months', title: 'Best months', period: 'month', description: 'Complete calendar months' },
    { id: 'lunches', title: 'Best lunches', period: 'day', daypart: 'lunch', description: 'Recorded sales before 16:00' },
    { id: 'weekends', title: 'Best weekends', period: 'weekend', description: 'Complete Saturday + Sunday pairs' },
    ...weekdays.map((name, index) => ({ id: name.toLowerCase(), title: name + 's', period: 'day',
      weekday: { iso: index + 1, name }, description: 'Individual ' + name + ' dates' })),
  ].map(board => Object.freeze({ ...board, group: board.daypart === 'lunch' ? 'lunch' : 'standard' })));
  const validStore = store => STORES.includes(store);
  const validBoard = id => BOARDS.some(board => board.id === id);
  function validDate(date) {
    return typeof date === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(date) &&
      Number.isFinite(Date.parse(date + 'T12:00:00Z')) && new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) === date;
  }
  function href(store = 'all', board = 'days', date = null) {
    const params = new URLSearchParams({ store: validStore(store) ? store : 'all', board: validBoard(board) ? board : 'days' });
    if (validDate(date)) params.set('date', date);
    return '#records?' + params.toString();
  }
  function parseHash(hash) {
    if (hash !== '#records' && !hash.startsWith('#records?')) return null;
    const params = new URLSearchParams(hash.split('?')[1] || '');
    return { store: validStore(params.get('store')) ? params.get('store') : 'all',
      board: validBoard(params.get('board')) ? params.get('board') : 'days',
      date: validDate(params.get('date')) ? params.get('date') : null };
  }
  // Session-only, bounded caching; never persist business data in localStorage.
  function createClient({ fetchBatch, session, today, now = Date.now, ttlMs = 5 * 60 * 1000 }) {
    const cache = new Map(), pending = new Map();
    let generation = 0;
    const key = (store, group) => `${session()}:${today()}:${store}:${group}`;
    function peek(store, group) {
      const value = cache.get(key(store, group));
      return value && value.until > now() ? value.data : null;
    }
    async function load(store, group) {
      if (session() === null) return null;
      if (!validStore(store) || !['standard', 'lunch'].includes(group)) throw new Error('INVALID_LEADERBOARD');
      const hit = peek(store, group); if (hit) return hit;
      const id = key(store, group), epoch = generation, token = session();
      if (pending.has(id)) return pending.get(id);
      const request = (async () => {
        const data = await fetchBatch(store, group);
        if (epoch !== generation || token !== session()) return null;
        cache.delete(id); cache.set(id, { data, until: now() + ttlMs });
        while (cache.size > 14) cache.delete(cache.keys().next().value);
        return data;
      })();
      pending.set(id, request);
      try { return await request; } finally { if (pending.get(id) === request) pending.delete(id); }
    }
    return { load, peek, clear() { generation++; cache.clear(); pending.clear(); } };
  }
  return { BOARDS, validStore, href, parseHash, createClient };
});
