# Killer Kalculator — Metric Specification

Audit: Stage 4 Job 3 — 97 381 lines across 6 stores, 2026-08-23 → 2026-09-22
Reference date for fixture: 2026-09-20 (Nørrebro)
Timezone: Europe/Copenhagen

---

## Stores

| Store           | firmaid | Kylling | Free lemonade addon |
|-----------------|---------|---------|---------------------|
| Nørrebro        | 18095   | No      | Yes (27242080)      |
| Indre By        | 15143   | Yes     | No                  |
| Vesterbro       | 13205   | No      | No                  |
| Christianshavn  | 21331   | Yes     | No                  |
| Fisketorvet     | 18926   | Yes     | Yes (27240940)      |
| Frederiksberg   | 18924   | No      | Yes (27241304)      |

**Confirmed business decisions (2026-09-22):**

1. Both Fisketorvet Killer Kebab IDs (`27241228` and `27241196`) count as ordinary standalone rolls.
   The secondary ID (`27241196`) accounts for ~94 units/30 days alongside ~1 800 for the primary.
2. Vesterbro, Indre By and Christianshavn have no free `+ Lemonade` addon line.
   Their kombos offer only the +10 kr upgrade or standalone purchase.  This is not a bug.
3. No stores sell bowls. `BOWL_IDS` remains empty until IDs are confirmed from the OnlinePOS catalogue.
4. Every Lover / +Lover ID is a different drink product, not lemonade.
   All 12 IDs are documented in the `OTHER_LOVER_*` registry and explicitly absent from `LEM_IDS`.
5. Unknown external/Wolt product IDs remain unclassified and are excluded from all metrics.

---

## Product ID classification table — all stores

All classification is by explicit product ID. Display names are recorded for reference only —
they must never be used for classification logic.

### Kombo — Lamb (Kombo - Lamb)

| Product ID | Store           | price filter |
|------------|-----------------|-------------|
| 27242208   | Nørrebro        | ≠ 0         |
| 27241816   | Indre By        | ≠ 0         |
| 27240680   | Vesterbro       | ≠ 0         |
| 27859906   | Christianshavn  | ≠ 0         |
| 27241068   | Fisketorvet     | ≠ 0         |
| 27241432   | Frederiksberg   | ≠ 0         |

### Kombo — Falafel (Kombo - Falafel)

| Product ID | Store           | price filter |
|------------|-----------------|-------------|
| 27242204   | Nørrebro        | ≠ 0         |
| 27241812   | Indre By        | ≠ 0         |
| 27240676   | Vesterbro       | ≠ 0         |
| 27859903   | Christianshavn  | ≠ 0         |
| 27241064   | Fisketorvet     | ≠ 0         |
| 27241428   | Frederiksberg   | ≠ 0         |

### Kombo — Kylling (Kombo - Kylling)

Sold only at Indre By, Christianshavn and Fisketorvet.

| Product ID | Store           | price filter |
|------------|-----------------|-------------|
| 29838316   | Indre By        | ≠ 0         |
| 29493147   | Christianshavn  | ≠ 0         |
| 29652666   | Fisketorvet     | ≠ 0         |

### Standalone roll — Killer Kebab

| Product ID | Store                         | price filter | Notes                       |
|------------|-------------------------------|--------------|-----------------------------|
| 27242336   | Nørrebro                      | ≠ 0          |                             |
| 27241944   | Indre By                      | ≠ 0          |                             |
| 27240808   | Vesterbro                     | ≠ 0          |                             |
| 27860038   | Christianshavn                | ≠ 0          |                             |
| 27241228   | Fisketorvet (primary)         | ≠ 0          | ~1 800 units/30 days        |
| 27241196   | Fisketorvet (secondary)       | ≠ 0          | ~94 units/30 days, same SKU |
| 27241560   | Frederiksberg                 | ≠ 0          |                             |

### Standalone roll — Killer Falafel

| Product ID | Store           | price filter |
|------------|-----------------|-------------|
| 27242332   | Nørrebro        | ≠ 0         |
| 27241940   | Indre By        | ≠ 0         |
| 27240804   | Vesterbro       | ≠ 0         |
| 27860035   | Christianshavn  | ≠ 0         |
| 27241192   | Fisketorvet     | ≠ 0         |
| 27241556   | Frederiksberg   | ≠ 0         |

### Standalone roll — Killer Kylling

Sold only at Indre By, Christianshavn and Fisketorvet.

| Product ID | Store           | price filter |
|------------|-----------------|-------------|
| 29838301   | Indre By        | ≠ 0         |
| 29493150   | Christianshavn  | ≠ 0         |
| 29652669   | Fisketorvet     | ≠ 0         |

### Lemonade — free included addon (+ Lemonade)

Only three stores emit a free-addon line. The others confirmed not to carry this product.

| Product ID | Store           | price filter |
|------------|-----------------|-------------|
| 27242080   | Nørrebro        | none        |
| 27240940   | Fisketorvet     | none        |
| 27241304   | Frederiksberg   | none        |

### Lemonade — paid upgrade (+ Killer Lemonade, +10 kr)

| Product ID | Store           | price filter |
|------------|-----------------|-------------|
| 27242148   | Nørrebro        | none        |
| 27241756   | Indre By        | none        |
| 27240620   | Vesterbro       | none        |
| 27859873   | Christianshavn  | none        |
| 27241008   | Fisketorvet     | none        |
| 27241372   | Frederiksberg   | none        |

### Lemonade — standalone (Killer Lemonade, 35 kr)

| Product ID | Store           | price filter |
|------------|-----------------|-------------|
| 27242164   | Nørrebro        | none        |
| 27241772   | Indre By        | none        |
| 27240636   | Vesterbro       | none        |
| 27859885   | Christianshavn  | none        |
| 27241024   | Fisketorvet     | none        |
| 27241388   | Frederiksberg   | none        |

**Price filter semantics for kombos and rolls:**
- `price = 0` → staff meal or fully-comped order → **excluded**
- `price ≠ 0` → paid sale (`price > 0`) or refund (`price < 0`) → **included**
- Refunds have `price < 0` and `count < 0`; signed count subtracts from the total

**Lemonade: no price filter.** All three lemonade variants are counted regardless of price.
Refunds (count < 0) subtract from the total automatically.

---

## Confirmed other-drink products — NOT lemonade

Decision confirmed 2026-09-22: Lover is a different drink product. All store-specific IDs are
registered in `OTHER_LOVER_*` and explicitly absent from every counted Set.

| Product ID | Display name         | Store           |
|------------|---------------------|-----------------|
| 29838736   | Lover               | Nørrebro        |
| 29838730   | Lover               | Indre By        |
| 29838742   | Lover               | Vesterbro       |
| 29838682   | Lover               | Christianshavn  |
| 29838706   | Lover               | Fisketorvet     |
| 29838724   | Lover               | Frederiksberg   |
| 29843293   | + Lover (+10 kr)    | Nørrebro        |
| 29843290   | + Lover (+10 kr)    | Indre By        |
| 29843296   | + Lover (+10 kr)    | Vesterbro       |
| 29838694   | + Lover ( 10 kr )   | Christianshavn  |
| 29843302   | + Lover (+10 kr)    | Fisketorvet     |
| 29843299   | + Lover (+10 kr)    | Frederiksberg   |

---

## Unclassified external lines (excluded)

| Product ID | Observed name / context                            |
|------------|----------------------------------------------------|
| 29569042   | Unknown external product — Nørrebro, Wolt, 4 DKK  |
| 29553679   | Unknown external product — Christianshavn          |
| 29557357   | Unknown external product — Fisketorvet             |
| 29557363   | Unknown external product — Indre By                |
| 30528491   | Unknown external product — Indre By                |

---

## Data source

Endpoint: `GET /exportSales/v20/{unixtime}` (OnlinePOS)

The endpoint is a rolling FROM-date query; it returns all lines with
`timestamp_pay >= given_timestamp` up to the current time.  To isolate a
single calendar day, filter to lines where `timestamp_pay` converted to
Europe/Copenhagen falls on the target date.

Nørrebro 2026-09-20 produces exactly **466 lines** and reconciles with the
independent revenue endpoint (`getByUnixTimeSales`) total of **16 429.60 DKK**.

---

## Price field semantics

`price` is the **line total** (unit price × count), not a unit price.
Correct revenue formula: `sum(price)`.
`sum(price × count)` is wrong and double-counts multi-quantity lines.

`priceexclvat` is the same total excluding 25 % Danish VAT.
`sum(priceexclvat) = sum(price) / 1.25` exactly for this dataset.

`discount` is an absolute DKK adjustment:
- Positive value → reduction (e.g. Wolt kombo: 149 − 13.80 = 135.20)
- Negative value → surcharge (e.g. Wolt roll: 95 − (−14) = 109)
- Zero-price staff meals carry `discount = list_price` (full removal)

---

## Revenue

> All displayed monetary values are **excluding VAT**.

`revenue = sum(priceexclvat)` for all lines whose `timestamp_pay` falls on
the selected Europe/Copenhagen calendar date.

Refund lines (count < 0) have a signed negative `priceexclvat`; they
subtract automatically from the sum.

---

## Kombo units

`kombo_units = sum(count) for lines where productid ∈ KOMBO_IDS AND price ≠ 0`

KOMBO_IDS is the union of KOMBO_LAMB_IDS (6 stores), KOMBO_FALAFEL_IDS (6 stores),
and KOMBO_KYLLING_IDS (3 stores) = 15 IDs total.

The kombo header line IS the roll — there are no separate zero-priced roll
component lines inside a kombo transaction.
Staff meals (price = 0) are excluded.
Refunds (count < 0, price < 0) are included; signed count subtracts.

---

## Standalone roll units

`roll_units = sum(count) for lines where productid ∈ ROLL_IDS AND price ≠ 0`

ROLL_IDS is the union of ROLL_KEBAB_IDS (7 IDs — Fisketorvet has two),
ROLL_FALAFEL_IDS (6 stores), and ROLL_KYLLING_IDS (3 stores) = 16 IDs total.

This includes rolls sold alongside kombos in mixed orders; they are legitimate
paid units and must not be excluded by transaction context.
Staff meals (price = 0) and refunds (price < 0) semantics as above.

---

## Kombo %

`kombo_pct = kombo_units / (kombo_units + roll_units) × 100`

Bowls are excluded from the denominator (no bowl sales found in cross-store audit).
Returns null when denominator = 0.
Rounded to 4 decimal places for display.

---

## Lemonade units

`lemonade_units = sum(count) for lines where productid ∈ LEM_IDS`

LEM_IDS is the union of LEM_ADDON_IDS (3 stores), LEM_UPGRADE_IDS (6 stores),
and LEM_STANDALONE_IDS (6 stores) = 15 IDs total.

No price filter: all three variants are counted regardless of price.
Refunds (count < 0) subtract from the total.

---

## Wolt %

`wolt_pct = wolt_excl_revenue / total_excl_revenue × 100`

where:
- `wolt_excl_revenue  = sum(priceexclvat) for lines where paymenttype = 'Wolt'`
- `total_excl_revenue = sum(priceexclvat) for all lines`

Both sums use the same date filter as the revenue metric.
Wolt % is calculated before platform fees are deducted.
Rounded to 4 decimal places for display.

---

## Reference values — Nørrebro 2026-09-20 (fixture)

| Metric                          | Value            |
|---------------------------------|-----------------|
| Lines in fixture                | 466              |
| Unique transactions             | 80               |
| Revenue incl. VAT               | 16 429.60 DKK    |
| Revenue excl. VAT               | 13 143.68 DKK    |
| Wolt revenue incl. VAT          | 2 650.60 DKK     |
| Wolt revenue excl. VAT          | 2 120.48 DKK     |
| Wolt %                          | 16.1331 %        |
| Kombo - Lamb units              | 49               |
| Kombo - Falafel units           | 17               |
| Total kombo units               | 66               |
| Killer Kebab paid units         | 39               |
| Killer Falafel paid units       | 15               |
| Total paid roll units           | 54               |
| Kombo %                         | 55.0000 %        |
| + Lemonade addon units          | 12               |
| + Killer Lemonade upgrade units | 3                |
| Killer Lemonade standalone      | 5                |
| Total lemonade units            | 20               |
| count = 2 lines                 | 22               |
| count = 3 lines                 | 4                |
| count < 0 lines (refunds)       | 0                |
