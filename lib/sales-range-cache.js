'use strict';

const DEFAULT_MAX_ENTRIES = 120;
const DEFAULT_CURRENT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_HISTORICAL_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_REFRESH_AHEAD_MS = 60 * 1000;
const DEFAULT_RECENT_ACCESS_MS = 15 * 60 * 1000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

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

function estimateSerializedBytes(result) {
  try {
    return Buffer.byteLength(JSON.stringify(result), 'utf8');
  } catch (_) {
    return Infinity;
  }
}

function createSalesRangeCache({
  fetchRange,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxBytes = DEFAULT_MAX_BYTES,
  currentTtlMs = DEFAULT_CURRENT_TTL_MS,
  historicalTtlMs = DEFAULT_HISTORICAL_TTL_MS,
  refreshAheadMs = DEFAULT_REFRESH_AHEAD_MS,
  recentAccessMs = DEFAULT_RECENT_ACCESS_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onRefreshError = () => {},
  onCacheWrite = () => {},
} = {}) {
  if (typeof fetchRange !== 'function') throw new TypeError('fetchRange must be a function');
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be positive');
  if (!Number.isFinite(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be positive');

  const entries = new Map();
  const inFlight = new Map();
  const refreshTimers = new Map();
  let totalBytes = 0;

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

  function clearEntryTimer(key) {
    if (!refreshTimers.has(key)) return;
    clearTimer(refreshTimers.get(key));
    refreshTimers.delete(key);
  }

  function removeEntry(key) {
    const entry = entries.get(key);
    if (!entry) return;
    totalBytes -= entry.estimatedBytes;
    entries.delete(key);
    clearEntryTimer(key);
  }

  function setEntry(key, entry) {
    if (!Number.isFinite(entry.estimatedBytes) || entry.estimatedBytes > maxBytes) return false;
    removeEntry(key);
    entries.delete(key);
    entries.set(key, entry);
    totalBytes += entry.estimatedBytes;
    while (entries.size > maxEntries || totalBytes > maxBytes) {
      const evictedKey = entries.keys().next().value;
      removeEntry(evictedKey);
    }
    return entries.get(key) === entry;
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
      const refreshArgs = current.refreshArgs || args;
      const refreshKey = keyFor(refreshArgs);
      const refreshEntry = entries.get(refreshKey) || null;
      const refresh = startFetch(refreshArgs, refreshKey, refreshEntry, {
        proactiveRefresh: true,
        lastAccessedAt: Math.max(current.lastAccessedAt, refreshEntry?.lastAccessedAt || 0),
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
          estimatedBytes: estimateSerializedBytes(result),
          refreshArgs: null,
        };
        const cached = setEntry(key, entry);
        if (cached) {
          if (!proactiveRefresh) scheduleProactiveRefresh(args, key, entry);
          onCacheWrite({ args, result, entry, proactiveRefresh });
        }
        const retained = entries.get(key) === entry;
        return {
          result,
          cacheStatus: !cached
            ? 'uncached-oversized'
            : retained ? (previousEntry ? 'refreshed' : 'miss') : 'uncached-evicted',
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
    prime(args, result, {
      fetchedAt = now(),
      lastAccessedAt = fetchedAt,
      refreshArgs = null,
    } = {}) {
      if (!isCompleteResult(result, args.start, args.end)) return false;
      const entry = {
        result,
        fetchedAt,
        freshUntil: fetchedAt + ttlFor(args, fetchedAt),
        lastAccessedAt,
        lastRefreshError: null,
        estimatedBytes: estimateSerializedBytes(result),
        refreshArgs,
      };
      return setEntry(keyFor(args), entry);
    },
    clear() {
      entries.clear();
      inFlight.clear();
      for (const timer of refreshTimers.values()) clearTimer(timer);
      refreshTimers.clear();
      totalBytes = 0;
    },
    stats() {
      return {
        entries: entries.size,
        inFlight: inFlight.size,
        refreshTimers: refreshTimers.size,
        maxEntries,
        estimatedBytes: totalBytes,
        maxBytes,
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
  DEFAULT_MAX_BYTES,
  estimateSerializedBytes,
};
