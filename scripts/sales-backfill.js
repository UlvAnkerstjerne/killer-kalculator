#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const { createReviewedCatalog } = require('../lib/sales-db/facts');
const { validateOptions } = require('../lib/sales-sync/options');
const { exportCatalogReview } = require('../lib/sales-sync/catalog-review');
const { createHttpRequest } = require('../lib/sales-sync/http');
const { fail, safeError } = require('../lib/sales-sync/errors');

function parseArgs(args) {
  const valueFlags = new Set(['--store', '--from', '--through', '--catalog', '--verify-run', '--resume-publication', '--max-pages', '--max-rows', '--batch-size']);
  const flags = new Set(['--apply', '--dry-run', '--validate', '--diagnose-catalog', '--export-catalog-review', '--diagnose-catalog-text', '--diagnose-catalog-review', '--diagnose-catalog-encoded', '--auto-admit', '--help']);
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (Object.hasOwn(values, arg) || (!valueFlags.has(arg) && !flags.has(arg))) fail('INVALID_OPTIONS');
    if (flags.has(arg)) values[arg] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail('INVALID_OPTIONS');
      values[arg] = value;
    }
  }
  if (values['--apply'] && (values['--dry-run'] || values['--validate'])) fail('INVALID_OPTIONS');
  if (values['--diagnose-catalog'] && ['--apply', '--dry-run', '--validate', '--verify-run', '--resume-publication']
    .some(flag => values[flag] !== undefined)) fail('INVALID_OPTIONS');
  if (values['--export-catalog-review'] && ['--apply', '--dry-run', '--validate', '--verify-run', '--resume-publication', '--diagnose-catalog']
    .some(flag => values[flag] !== undefined)) fail('INVALID_OPTIONS');
  if (values['--diagnose-catalog-text'] && !values['--export-catalog-review']) fail('INVALID_OPTIONS');
  if (values['--diagnose-catalog-review'] && ['--apply', '--dry-run', '--validate', '--verify-run', '--resume-publication', '--diagnose-catalog', '--export-catalog-review', '--diagnose-catalog-text', '--help']
    .some(flag => values[flag] !== undefined)) fail('INVALID_OPTIONS');
  if (values['--diagnose-catalog-encoded'] && ['--apply', '--dry-run', '--validate', '--verify-run', '--resume-publication', '--diagnose-catalog', '--export-catalog-review', '--diagnose-catalog-text', '--diagnose-catalog-review', '--help'].some(flag => values[flag] !== undefined)) fail('INVALID_OPTIONS');
  const options = { storeSlug: values['--store'], start: values['--from'], end: values['--through'],
    verificationOf: values['--verify-run'], resumePublication: values['--resume-publication'] };
  const limits = {};
  for (const [flag, key, max] of [['--max-pages', 'maxPages', 10000], ['--max-rows', 'maxRows', 20000000], ['--batch-size', 'batchSize', 500]]) {
    if (values[flag] === undefined) continue;
    if (!/^[1-9]\d{0,7}$/.test(values[flag]) || Number(values[flag]) > max) fail('INVALID_OPTIONS');
    limits[key] = Number(values[flag]);
  }
  if (values['--auto-admit'] && !values['--apply']) fail('INVALID_OPTIONS');
  return { options, limits, apply: values['--apply'] === true, diagnose: values['--diagnose-catalog'] === true,
    exportReview: values['--export-catalog-review'] === true, diagnoseText: values['--diagnose-catalog-text'] === true,
    encodedReview: values['--diagnose-catalog-encoded'] === true, safeReview: values['--diagnose-catalog-review'] === true,
    autoAdmit: values['--auto-admit'] === true, catalogPath: values['--catalog'], help: values['--help'] === true };
}
async function readReviewedCatalog(filePath) {
  try {
    const file = await fs.open(filePath, 'r');
    try {
      const stat = await file.stat(); if (!stat.isFile() || stat.size > 1024 * 1024) fail('INVALID_CATALOG');
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1024 * 1024) fail('INVALID_CATALOG');
      const reviewed = JSON.parse(buffer.toString('utf8', 0, bytesRead));
      if (!Array.isArray(reviewed.products) || reviewed.products.length > 10000 || !Array.isArray(reviewed.payments) || reviewed.payments.length > 100) fail('INVALID_CATALOG');
      createReviewedCatalog(reviewed);
      return reviewed;
    } finally { await file.close(); }
  } catch { fail('INVALID_CATALOG'); }
}
async function main(args = process.argv.slice(2), env = process.env, output = line => process.stdout.write(line + '\n'), dependencies = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const parsed = parseArgs(args);
    if (parsed.help) {
      output('Usage: node scripts/sales-backfill.js --store <internal-store> --from <YYYY-MM-DD> --catalog <reviewed-file> [--through <exclusive-date>] [--dry-run | --apply | --diagnose-catalog | --export-catalog-review [--diagnose-catalog-text] | --diagnose-catalog-review | --diagnose-catalog-encoded] [--verify-run <run-uuid> | --resume-publication <run-uuid>]');
      return 0;
    }
    validateOptions(parsed.options);
    if (parsed.exportReview || parsed.safeReview || parsed.encodedReview) {
      const reviewed = await readReviewedCatalog(parsed.catalogPath);
      const companyId = env.KK_BACKFILL_COMPANY_ID;
      const request = dependencies.request || createHttpRequest({ token: env.KK_BACKFILL_TOKEN, companyId });
      const review = parsed.encodedReview ? require('../lib/sales-sync/catalog-encoded').diagnoseEncodedCatalog : parsed.safeReview ? require('../lib/sales-sync/catalog-diagnostic').diagnoseCatalogReview : parsed.diagnoseText ? require('../lib/sales-sync/catalog-text-diagnostic').diagnoseCatalogText : exportCatalogReview;
      const result = await review({ reviewed, request, options: { ...parsed.options, companyId },
        limits: parsed.limits, signal: controller.signal });
      output(JSON.stringify(result)); return result.status === 'incomplete' || ['structural-review', 'operational-failure'].includes(result.outcome) ? 1 : 0;
    }
    const { readConfig } = require('../lib/sales-db/config');
    const config = readConfig(env);
    if (!config.enabled) fail('DB_DISABLED');
    if (!/^[a-fA-F0-9]{64}$/.test(env.KK_SALES_IDENTITY_KEY_HEX || '') ||
        !/^[1-9]\d{0,4}$/.test(env.KK_SALES_IDENTITY_KEY_VERSION || '') || Number(env.KK_SALES_IDENTITY_KEY_VERSION) > 32767) fail('INVALID_IDENTITY');
    const { createIdentity } = require('../lib/sales-db/identity');
    const identity = createIdentity({ key: Buffer.from(env.KK_SALES_IDENTITY_KEY_HEX, 'hex'), version: Number(env.KK_SALES_IDENTITY_KEY_VERSION) });
    const catalog = createReviewedCatalog(await readReviewedCatalog(parsed.catalogPath));
    const companyId = env.KK_BACKFILL_COMPANY_ID;
    const request = dependencies.request || (parsed.options.resumePublication
      ? async () => fail('INVALID_RUN') : createHttpRequest({ token: env.KK_BACKFILL_TOKEN, companyId }));
    if (parsed.diagnose) {
      const { diagnoseCatalog } = require('../lib/sales-sync/diagnostic');
      const result = await diagnoseCatalog({ context: { identity, catalog }, request,
        options: { ...parsed.options, companyId }, limits: parsed.limits, signal: controller.signal });
      output(JSON.stringify(result)); return 0;
    }
    const { importHistory } = require('../lib/sales-sync/importer');
    let autoAdmit;
    if (parsed.autoAdmit) {
      const { inspectText } = require('../lib/sales-sync/catalog-text');
      const { storeId: resolveStoreId } = require('../lib/sales-db/values');
      autoAdmit = (raw, storeSlug, context) => {
        let pl = raw.productname;
        const issue = inspectText(pl, 'label');
        if (issue && issue.reason === 'SENSITIVE_PATTERN') {
          const id = String(raw.productid), chunks = [];
          for (let i = 0; i < id.length; i += 3) chunks.push(id.slice(i, i + 3));
          pl = `[P:${chunks.join('/')}]`;
        } else if (issue) return null; // Other text issues: reject
        const sid = resolveStoreId(storeSlug);
        context.catalog.admit({
          storeId: sid, productId: String(raw.productid), productLabel: pl,
          groupId: raw.productgroupid != null ? String(raw.productgroupid) : null,
          groupLabel: raw.productgroup != null ? String(raw.productgroup) : null,
          paymentType: String(raw.paymenttype),
          paymentCode: raw.paymenttypecode != null ? String(raw.paymenttypecode) : null,
        });
        return { ...raw, productname: pl };
      };
    }
    await importHistory({ config, context: { identity, catalog }, request,
      options: { ...parsed.options, companyId }, limits: parsed.limits, apply: parsed.apply,
      signal: controller.signal, report: value => output(JSON.stringify(value)), autoAdmit });
    if (parsed.autoAdmit) {
      const admitted = catalog.admitted();
      if (admitted.products.length || admitted.payments.length) {
        output(JSON.stringify({ status: 'admitted', products: admitted.products.length, payments: admitted.payments.length }));
      }
    }
    return 0;
  } catch (error) {
    const code = safeError(error).code;
    output(JSON.stringify({ status: 'incomplete', code, ...(code === 'CATALOG_TEXT_REVIEW' ? { redacted: true } : {}) })); return 1;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { main, parseArgs };
