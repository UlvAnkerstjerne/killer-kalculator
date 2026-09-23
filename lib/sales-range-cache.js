'use strict';

const DEFAULT_MAX_ENTRIES = 120;
const DEFAULT_CURRENT_TTL_MS = 30 * 1000;
const DEFAULT_HISTORICAL_TTL_MS = 6 * 60 * 60 * 1000;

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
  now = Date.now,
  onRefreshError = () => {},
} = {}) {
  if (typeof fetchRange !== 'function') throw new TypeError('fetchRange must be a function');
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be positive');

  const entries = new Map();
  const inFlight = new Map();

  const keyFor = ({ storeId, start, end }) => `${storeId}:${start}:${end}`;
  const containsToday = ({ start, end }, nowMs = now()) => {
    const today = cphToday(nowMs);
    return start <= today && today < end;
  };
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
      entries.delete(entries.keys().next().value);
    }
  }

  function startFetch(args, key, previousEntry = null) {
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
          return { result, cacheStatus: 'bypass', stale: false };
        }
        const fetchedAt = now();
        const entry = {
          result,
          fetchedAt,
          freshUntil: fetchedAt + ttlFor(args, fetchedAt),
          lastRefreshError: null,
        };
        setEntry(key, entry);
        return { result, cacheStatus: previousEntry ? 'refreshed' : 'miss', stale: false };
      } catch (err) {
        if (previousEntry && entries.get(key) === previousEntry) {
          previousEntry.lastRefreshError = err.message || 'refresh failed';
          touch(key, previousEntry);
        }
        throw err;
      } finally {
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, promise);
    return promise;
  }

  async function get(args, { allowStale = true } = {}) {
    const key = keyFor(args);
    const entry = entries.get(key);
    const nowMs = now();

    if (!entry) return startFetch(args, key);
    touch(key, entry);

    if (nowMs < entry.freshUntil) {
      return { result: entry.result, cacheStatus: 'fresh', stale: false };
    }

    if (containsToday(args, nowMs) && allowStale) {
      const refresh = startFetch(args, key, entry);
      refresh.catch(err => onRefreshError(err, args));
      return {
        result: entry.result,
        cacheStatus: 'stale',
        stale: true,
        lastRefreshError: entry.lastRefreshError,
      };
    }

    return startFetch(args, key, entry);
  }

  return {
    get,
    clear() {
      entries.clear();
      inFlight.clear();
    },
    stats() {
      return { entries: entries.size, inFlight: inFlight.size, maxEntries };
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
};
