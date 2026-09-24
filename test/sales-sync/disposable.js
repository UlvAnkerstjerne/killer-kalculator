'use strict';
function disposableConfig(env = process.env) {
  let target;
  try { target = new URL(env.KK_TEST_DATABASE_URL); } catch { throw new Error('Disposable PostgreSQL test URL required'); }
  if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/kk_foundation_test' ||
      target.username !== 'foundation_test' || target.search || target.hash || !['postgres:', 'postgresql:'].includes(target.protocol)) {
    throw new Error('Refusing non-disposable PostgreSQL target');
  }
  return { enabled: true, connectionString: target.href };
}
module.exports = { disposableConfig };
