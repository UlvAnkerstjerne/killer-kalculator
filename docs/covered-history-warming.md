# Covered-history cache warming

With `covered-history` enabled, the presence of the database reader previously disabled all LY and completed-period warming. A missing day still routes the entire range to OnlinePOS, so Last Month current sales and LY/budget could wait for fresh exports on first use.

Warming now uses the existing whole-range policy with a read-only coverage snapshot. Complete stored ranges skip provider warming without loading their sales rows. Missing/pending/retry coverage warms the whole provider range. Coverage errors fail visibly and never trigger provider fallback. Normal API reads still validate all stored facts and retain their existing size limits, metric warnings and source notices.

Today and This Week retain startup priority. Compact LY, Last Week, Yesterday and Last Month follow. This Month warms last, one store at a time, using non-evicting admission; capacity bypass remains explicit. The shared queue/coalescing, maximum two provider requests, 48 MiB sales cache, 32 MiB LY cache, 120-entry limits and bounded refresh rules are unchanged. No import, catalogue, schema, grants, metric or production policy change is required.

## Reproducible synthetic benchmark

Run `node scripts/benchmark-covered-history-warming.js [app-root] [delay-ms=80] [lines-per-day=80]` against a locked installation. The identical harness ran against baseline `1905d44b3efed1e988b41cc433b958e51cd823fa` and this implementation on September 29, 2026. It uses real authenticated Express routes, deterministic signed synthetic rows, a frozen Copenhagen clock, synthetic complete/missing coverage, and 80 ms delayed mock exports. It never accesses PostgreSQL, OnlinePOS or production. Cold clears both caches per preset; warm starts after one startup pass; repeats make zero exports. LY requests include the equivalent-time boundary while budgets retain the full range’s LY revenue × 1.10.

| Preset | Cold exports (both) | Warm exports before → after | Cold current+LY/budget ready ms before / after | Warm current+LY/budget ready ms before → after |
|---|---:|---:|---:|---:|
| today | 6 | 0 → 0 | 302 / 278 | 15 → 13 |
| this-week | 6 | 0 → 0 | 274 / 273 | 10 → 8 |
| this-month | 6 | 6 → 0 | 278 / 280 | 280 → 42 |
| last-month | 2 | 2 → 0 | 103 / 105 | 99 → 38 |

Figures, signed totals, equivalent-time comparisons, full LY budget basis and whole-range source decisions were identical cold/warm. All repeated requests made zero exports. These are one-run local HTTP timings, not browser paint timings or a production speedup claim. Cache benefits depend on real coverage, row sizes and expiry.

Startup mock exports increased 6 → 15; duration 263 → 1,129 ms. Readiness remained available during warming. The new pass made 54 coverage checks and zero stored-fact reads; 51 covered historical ranges skipped exports (18 LY plus 33 completed), nine uncovered/open warming entries were admitted. Sales cache after startup: 12 → 20 entries, 357,366 → 4,534,409 estimated serialized bytes (limit 50,331,648). LY: 0 → 1 entry, 0 → 3,360 bytes (limit 33,554,432). Both priority ranges remained cached for all six stores; maximum measured provider concurrency was two. Process RSS is distinct from cache accounting: roughly 226 → 251 MiB high-water in the synthetic runs; this is not a heap-limit or production-memory claim.

## Validation

Focused tests cover coverage-only reads, approved zero closures, pending/retry exclusions, oversized stored ranges, coverage changes, database-error privacy/no fallback, open ranges, sequential This Month admission under pressure, exact API routing/figures and existing coalescing. The PostgreSQL suite exercises the new coverage method through the exact column-only reader role and confirms that no sales-line query occurs. The existing complete regression/PostgreSQL workflow is the final exact-head gate.
