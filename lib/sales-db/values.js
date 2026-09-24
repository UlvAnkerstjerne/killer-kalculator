'use strict';
const { fail } = require('./errors');
const STORES = Object.freeze(['indre-by', 'vesterbro', 'christianshavn', 'fisketorvet', 'frederiksberg', 'norrebro']);
function storeId(slug) {
  const index = STORES.indexOf(slug);
  if (index === -1) fail();
  return index + 1;
}
function exactKeys(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).some(key => !keys.includes(key)) ||
      keys.some(key => !Object.hasOwn(value, key))) fail();
}
function decimal(value) {
  // Strings only: a future lossless importer must preserve the source lexeme.
  if (typeof value !== 'string' || value.length > 60 || !/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)) fail();
  const unsigned = value.replace(/^-/, '');
  const [integer, fraction = ''] = unsigned.split('.');
  if (integer.length > 20 || fraction.length > 18 || integer.length + fraction.length > 38) fail();
  const tail = fraction.replace(/0+$/, '');
  const result = integer + (tail ? '.' + tail : '');
  return value.startsWith('-') && result !== '0' ? '-' + result : result;
}
function date(value) {
  if (typeof value !== 'string' || !/^20\d\d-\d{2}-\d{2}$/.test(value)) fail();
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail();
  return value;
}
function range(start, end, maxDays = 366) {
  date(start); date(end);
  const days = (Date.parse(end) - Date.parse(start)) / 86400000;
  if (days < 1 || days > maxDays) fail();
  return Array.from({ length: days }, (_, i) => new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10));
}
const cph = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function cphLocal(ms) {
  const p = Object.fromEntries(cph.formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
function saleTime(businessDate, local, source) {
  date(businessDate);
  if (local === null && source === 'missing') return { saleLocal: null, secondOfDay: null, timeQuality: 'missing' };
  if (!['payment', 'fallback'].includes(source) || typeof local !== 'string' ||
      !/^20\d\d-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(local) || local.slice(0, 10) !== businessDate) fail();
  const naive = Date.parse(local.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(naive)) fail();
  const matches = [1, 2].filter(offset => cphLocal(naive - offset * 3600000) === local);
  if (!matches.length) fail(); // Includes nonexistent spring-forward times.
  const [h, m, s] = local.slice(11).split(':').map(Number);
  return { saleLocal: local, secondOfDay: h * 3600 + m * 60 + s,
    timeQuality: source + (matches.length === 2 ? '_ambiguous' : '') };
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^20\d\d-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail();
  return value;
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) fail();
  return value;
}
module.exports = { STORES, storeId, exactKeys, decimal, date, range, saleTime, cphLocal, timestamp, identifier };
