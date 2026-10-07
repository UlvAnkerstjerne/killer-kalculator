# Internal store summary (Killer Kockpit read API)

`GET /api/internal/store-summary/:storeId/:start/:end`

Read-only, server-to-server. Used by the Killer Kockpit Store Manager Dashboard.

## Contract

- `storeId` — exact Kalculator slug: `indre-by`, `vesterbro`, `christianshavn`,
  `fisketorvet`, `frederiksberg`, `norrebro`. Anything else → 404.
- `start` inclusive, `end` exclusive, Europe/Copenhagen dates (same as
  `/api/sales-range`). Max 31 days; `end` may not be later than tomorrow → 400.
- Auth: `Authorization: Bearer <KOCKPIT_READ_TOKEN>`, compared in constant time.
  The browser session is not accepted. Missing/short (<32 chars) server token → 503.

```json
{ "storeId": "indre-by", "start": "2026-10-06", "end": "2026-10-07",
  "complete": true, "source": "database|provider|hybrid",
  "metrics": { "revenueExVat": 18420.5, "salaryCost": 4560, "salaryPct": 24.76,
               "rollUnits": 103, "komboUnits": 71, "komboPct": 40.8, "lemonadeUnits": 46 } }
```

Sales unavailable or incomplete → 503 with `complete: false, metrics: null`.

## Definitions (identical to the dashboard)

- Sales lines come from the shared `readSalesRange` (same database/provider/hybrid
  routing as `/api/sales-range`).
- `revenueExVat` = Σ `priceexclvat`.
- Units and `komboPct` = `lib/product-metrics.js` `computeMetrics`;
  `komboPct` is `null` when kombos + rolls = 0. `lemonadeUnits` = `lemUnits`.
- `salaryCost` = Planday cost for the store (`fetchSalariesByStore(start, end − 1 day)`,
  the dashboard's inclusive `to`). 0/missing/Planday failure → `null`.
  `salaryPct` = salaryCost / revenueExVat × 100, `null` when either is unavailable.
- Money/percent values rounded to 2 decimals; units are exact.

Planday results are shared across stores per period for 5 minutes (failures not cached).
