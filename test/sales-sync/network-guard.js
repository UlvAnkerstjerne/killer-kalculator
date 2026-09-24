'use strict';
// Test subprocesses may use loopback servers/PostgreSQL, never public services.
// Installation/audit happen outside this preload. No credentials are inspected.
const fail = () => { throw new Error('External network disabled in sales tests'); };
const local = hostname => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
for (const name of ['node:http', 'node:https']) {
  const transport = require(name);
  for (const method of ['request', 'get']) {
    const original = transport[method];
    transport[method] = function (...args) {
      const first = args[0];
      let hostname;
      if (typeof first === 'string' || first instanceof URL) {
        try { hostname = new URL(first).hostname; } catch { fail(); }
      } else hostname = first?.hostname || first?.host || 'localhost';
      if (!local(hostname)) fail();
      return original.apply(this, args);
    };
  }
}
if (globalThis.fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = function (input, ...args) {
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); } catch { fail(); }
    if (!local(url.hostname)) fail();
    return original.call(this, input, ...args);
  };
}
