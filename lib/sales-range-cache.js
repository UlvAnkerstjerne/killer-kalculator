'use strict';

const DEFAULT_MAX_ENTRIES = 120;
const DEFAULT_CURRENT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_HISTORICAL_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_REFRESH_AHEAD_MS = 60 * 1000;
const DEFAULT_RECENT_ACCESS_MS = 15 * 60 * 1000;

function cphToday(nowMs) {
  return new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Copenhagen' })
    .format(new Date(nowMs));
}

function isValidResult(result, start, end) {
  return Boolean(
    result &&
    Array.isArray(result.lines) &&
    result.meta &&
    typeof result.meta.complete === 'boolean' &&
    result.meta.start === start &&
    result.meta.end === end &&
    Number.isInteger(result.meta.pages) && result.meta.pages >= 1 &&
    Number.isInteger(result.meta.rawLineCount) && result.meta.rawLineCount >= 0 &&
    Number.isInteger(result.meta.processedLineCount) && result.meta.processedLineCount >= 0 &&
    Array.isArray(result.meta.conflicts)
  );
}

function isCompleteResult(result, start, end) {
  return isValidResult(result, start, end) && result.meta.complete === true;
}

function createSalesRangeCache({
  fetchRange,
  maxEntries = DEFAULT_MAX_ENTRIES,
  currentTtlMs = DEFAULT_CURRENT_TTL_MS,
  historicalTtlMs = DEFAULT_HISTORICAL_TTL_MS,
  refreshAheadMs = DEFAULT_REFRESH_AHEAD_MS,
  recentAccessMs = DEFAULT_RECENT_ACCESS_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onRefreshError = () => {},
} = {}) {
  if (typeof fetchRange !== 'function') throw new TypeError('fetchRange must be a function');
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be positive');

  const entries = new Map();
  const inFlight = new Map();
  const refreshTimers = new Map();

  const keyFor = ({ storeId, start, end }) => `${storeId}:${start}:${end}`;
  const isOpenRange = ({ end }, nowMs = now()) => end > cphToday(nowMs);
  const ttlFor = (args, nowMs) => {
    const today = cphToday(nowMs);
    return args.end <= today ? historicalTtlMs : currentTtlMs;
  };

  function touch(key, entry) {
    entries.delete(key);
    entries.set(key, entry);
  }

  function setEntry(key, entry) {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxEntries) {
      const evictedKey = entries.keys().next().value;
      entries.delete(evictedKey);
      if (refreshTimers.has(evictedKey)) {
        clearTimer(refreshTimers.get(evictedKey));
        refreshTimers.delete(evictedKey);
      }
    }
  }

  function scheduleProactiveRefresh(args, key, entry) {
    if (!isOpenRange(args) || refreshAheadMs <= 0) return;
    if (refreshTimers.has(key)) clearTimer(refreshTimers.get(key));

    const delay = Math.max(0, entry.freshUntil - now() - refreshAheadMs);
    const timer = setTimer(() => {
      refreshTimers.delete(key);
      const current = entries.get(key);
      const nowMs = now();
      if (current !== entry || nowMs - current.lastAccessedAt > recentAccessMs) return;

      // One refresh-ahead attempt per user access/startup warm. A successful
      // proactive refresh does not schedule itself again, avoiding polling.
      const refresh = startFetch(args, key, current, {
        proactiveRefresh: true,
        lastAccessedAt: current.lastAccessedAt,
      });
      refresh.catch(err => onRefreshError(err, args));
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    refreshTimers.set(key, timer);
  }

  function startFetch(args, key, previousEntry = null, {
    proactiveRefresh = false,
    lastAccessedAt = now(),
  } = {}) {
    if (inFlight.has(key)) return inFlight.get(key);

    const promise = (async () => {
      try {
        const result = await fetchRange(args);
        if (!isValidResult(result, args.start, args.end)) {
          throw new Error('Invalid sales range result');
        }
        // Preserve the endpoint's established fail-closed contract: incomplete
        // results pass through with meta.complete=false, but are never cached.
        if (!isCompleteResult(result, args.start, args.end)) {
          return { result, cacheStatus: 'bypass', stale: false, fetchedAt: null, freshUntil: null };
        }
        const fetchedAt = now();
        const entry = {
          result,
          fetchedAt,
          freshUntil: fetchedAt + ttlFor(args, fetchedAt),
          lastAccessedAt,
          lastRefreshError: null,
        };
        setEntry(key, entry);
        if (!proactiveRefresh) scheduleProactiveRefresh(args, key, entry);
        return {
          result,
          cacheStatus: previousEntry ? 'refreshed' : 'miss',
          stale: false,
          fetchedAt: entry.fetchedAt,
          freshUntil: entry.freshUntil,
        };
      } catch (err) {
        if (previousEntry && entries.get(key) === previousEntry) {
          previousEntry.lastRefreshError = err.message || 'refresh failed';
          touch(key, previousEntry);
        }
        throw err;
      } finally {
        if (inFlight.get(key) === promise) inFlight.delete(key);
      }
    })();

    inFlight.set(key, promise);
    return promise;
  }

  async function get(args) {
    const key = keyFor(args);
    const entry = entries.get(key);
    const nowMs = now();

    if (!entry) return startFetch(args, key, null, { lastAccessedAt: nowMs });
    touch(key, entry);
    entry.lastAccessedAt = nowMs;

    if (nowMs < entry.freshUntil) {
      scheduleProactiveRefresh(args, key, entry);
      return {
        result: entry.result,
        cacheStatus: 'fresh',
        stale: false,
        fetchedAt: entry.fetchedAt,
        freshUntil: entry.freshUntil,
      };
    }

    // Never serve a current/open result beyond its TTL. Coalescing still makes
    // an expired request share a proactive or user-triggered refresh.
    return startFetch(args, key, entry, { lastAccessedAt: entry.lastAccessedAt });
  }

  return {
    get,
    clear() {
      entries.clear();
      inFlight.clear();
      for (const timer of refreshTimers.values()) clearTimer(timer);
      refreshTimers.clear();
    },
    stats() {
      return {
        entries: entries.size,
        inFlight: inFlight.size,
        refreshTimers: refreshTimers.size,
        maxEntries,
      };
    },
    inspect(args) {
      const entry = entries.get(keyFor(args));
      return entry ? { ...entry } : null;
    },
  };
}

module.exports = {
  createSalesRangeCache,
  isValidResult,
  isCompleteResult,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_CURRENT_TTL_MS,
  DEFAULT_HISTORICAL_TTL_MS,
  DEFAULT_REFRESH_AHEAD_MS,
  DEFAULT_RECENT_ACCESS_MS,
};
