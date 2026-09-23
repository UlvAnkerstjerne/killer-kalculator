'use strict';

// One queue for current sales, compact LY, startup warming and user requests.
// A slot covers the entire paginated export; identical ranges share its promise.
function createSharedSalesFetcher(fetchRange, concurrency = 2) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) {
    throw new RangeError('OnlinePOS concurrency must be one or two');
  }
  let active = 0;
  const queue = [];
  const inFlight = new Map();
  function drain() {
    while (active < concurrency && queue.length) {
      active++;
      const job = queue.shift();
      void (async () => {
        try { job.resolve(await fetchRange(job.args)); }
        catch (error) { job.reject(error); }
        finally { inFlight.delete(job.key); active--; drain(); }
      })();
    }
  }
  return args => {
    const key = `${args.storeId}:${args.start}:${args.end}`;
    if (inFlight.has(key)) return inFlight.get(key);
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    inFlight.set(key, promise);
    queue.push({ key, args, resolve, reject });
    drain();
    return promise;
  };
}

module.exports = { createSharedSalesFetcher };
