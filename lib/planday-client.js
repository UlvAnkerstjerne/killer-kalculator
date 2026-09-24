'use strict';

class PlandayError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function createPlandayClient({ http, appId, refreshToken, now = Date.now,
  minIntervalMs = 100, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let token, refreshing;
  let nextRequestAt = 0;
  async function reserveRequest() {
    const start = Math.max(Date.now(), nextRequestAt);
    nextRequestAt = start + minIntervalMs;
    if (start > Date.now()) await wait(start - Date.now());
  }
  async function accessToken() {
    if (token && now() < token.expiresAt - 60000) return token.value;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        if (!appId || !refreshToken) throw new Error();
        const r = await http.post('https://id.planday.com/connect/token', new URLSearchParams({
          grant_type: 'refresh_token', refresh_token: refreshToken, client_id: appId,
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
        if (typeof r.data?.access_token !== 'string' || !r.data.access_token || !(r.data.expires_in > 60)) throw new Error();
        token = { value: r.data.access_token, expiresAt: now() + r.data.expires_in * 1000 };
        return token.value;
      } catch { throw new PlandayError('UPSTREAM_UNAVAILABLE'); }
      finally { refreshing = null; }
    })();
    return refreshing;
  }
  async function get(path, params = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const value = await accessToken();
      await reserveRequest();
      try {
        const r = await http.get('https://openapi.planday.com' + path, {
          headers: { Authorization: 'Bearer ' + value, 'X-ClientId': appId, Accept: 'application/json' },
          params, timeout: 20000,
        });
        return r.data;
      } catch (err) {
        if (attempt === 0 && err.response?.status === 429) {
          const reset = Number(err.response.headers?.['x-ratelimit-reset'] || err.response.headers?.['retry-after']);
          // Respect the provider's counter reset. Do not retry a malformed or
          // unbounded delay, or serialize the upstream error into a response.
          if (Number.isFinite(reset) && reset > 0 && reset <= 60) {
            nextRequestAt = Math.max(nextRequestAt, Date.now() + reset * 1000 + 50);
            continue;
          }
        }
        if (attempt === 0 && err.response?.status === 401) {
          if (token?.value === value) token = null;
          continue;
        }
        // Never retain the axios error: config, headers and response can contain PII.
        throw new PlandayError('UPSTREAM_UNAVAILABLE');
      }
    }
  }
  async function all(path, params = {}, pageSize = 100) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new PlandayError('INVALID_SCHEMA');
    const records = []; let offset = 0, expectedTotal;
    for (let page = 0; page < 100; page++) {
      const body = await get(path, { ...params, limit: pageSize, offset });
      if (!Array.isArray(body?.data)) throw new PlandayError('INVALID_SCHEMA');
      const total = body.paging?.total;
      if (!Number.isSafeInteger(total) || total < 0 || total > 10000 ||
          body.paging.offset !== offset || (expectedTotal !== undefined && total !== expectedTotal)) {
        throw new PlandayError('PAGINATION_INCOMPLETE');
      }
      expectedTotal = total;
      records.push(...body.data); offset += body.data.length;
      if (offset === total) return records;
      if (offset > total || !body.data.length) throw new PlandayError('PAGINATION_INCOMPLETE');
    }
    throw new PlandayError('PAGINATION_INCOMPLETE');
  }
  return { get, all };
}
module.exports = { createPlandayClient, PlandayError };
