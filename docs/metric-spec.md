# Killer Kalculator — Metric Specification

Store: Nørrebro
Reference date: 2026-09-20
Timezone: Europe/Copenhagen

---

## Product ID classification table

All classification is by explicit product ID. Display names are recorded for
reference only — they must never be used for classification logic.

| Product ID | Display name (2026-09-20)      | Category         | Price filter | Notes |
|------------|-------------------------------|-----------------|-------------|-------|
| 27242208   | Kombo - Lamb                  | kombo           | ≠ 0         | Header line represents the roll; no separate roll component |
| 27242204   | Kombo - Falafel               | kombo           | ≠ 0         | Same as above |
| 27242336   | Killer Kebab                  | standalone roll | ≠ 0         | Includes rolls in mixed orders |
| 27242332   | Killer Falafel                | standalone roll | ≠ 0         | Includes rolls in mixed orders |
| 27242080   | + Lemonade                    | lemonade-addon  | none        | Kombo addon; price varies (0, 10, 35 seen in fixture) |
| 27242148   | + Killer Lemonade (+10 kr)    | lemonade-upgrade| none        | Kombo upgrade; count=2 line observed |
| 27242164   | Killer Lemonade (35 kr)       | lemonade-standalone | none    | Standalone purchase |

**Price filter semantics for kombos and rolls:**
- `price = 0` → staff meal or fully-comped order → **excluded**
- `price ≠ 0` → paid sale (`price > 0`) or refund (`price < 0`) → **included**
- Refunds have `price < 0` and `count < 0`; signed count subtracts from the total

**Bowl products:** No bowl product IDs have been identified in the Nørrebro reference
dataset. `BOWL_IDS` in `lib/product-metrics.js` is currently empty. IDs must be added
explicitly when confirmed from OnlinePOS catalogue or other store data.

### Observed product IDs not yet classified

These IDs appear in the Nørrebro 2026-09-20 fixture but are not counted in any metric:

| Product ID | Display name                 | Prices seen | Notes |
|------------|------------------------------|------------|-------|
| 27242028   | + Dip                        | 0          | Modifier |
| 27242032   | Harissa Chili Dip            | 10, 12     | Side |
| 27242036   | Killer Ketchup               | 10         | Side |
| 27242040   | Harissa Mayo                 | 10         | Side |
| 27242044   | Truffle Mayo                 | 10, 12     | Side |
| 27242048   | + Truffle Mayo               | 0          | Modifier |
| 27242052   | + Harissa mayo               | 0          | Modifier |
| 27242056   | + Ketchup                    | 0          | Modifier |
| 27242060   | + Harissa OTS                | 0          | Modifier |
| 27242068   | + Harissa                    | 0          | Modifier |
| 27242072   | + Harissa, a little          | 0          | Modifier |
| 27242076   | + Killer Fries               | 0          | Modifier |
| 27242084   | + Pale Ale                   | 45         | Beverage |
| 27242096   | + Faxe Kondi (+0kr)          | 0, 25      | Beverage |
| 27242100   | + Pepsi Max (+0kr)           | 0, 25      | Beverage |
| 27242108   | + Water, still (+0kr)        | 0          | Beverage modifier |
| 27242112   | Faxe Kondi (25kr)            | 0, 25      | Beverage |
| 27242120   | Water, still (25kr)          | 0, 25      | Beverage |
| 27242124   | Water, sparkling (25kr)      | 0          | Beverage |
| 27242136   | Extra Hummus (10 kr)         | 10         | Side |
| 27242144   | Pepsi Max (25 kr)            | 0, 25      | Beverage |
| 27242152   | + Killer Pale Ale (+20kr)    | 20         | Beverage modifier |
| 27242156   | + SOFT DRINK (+0kr)          | 0          | Beverage modifier |
| 27242168   | Killer Pale Ale (45 kr)      | 45         | Beverage |
| 27242176   | SOFT DRINK (25kr)            | 0          | Beverage |
| 27242232   | EAT NOW                      | 0          | Instruction/modifier |
| 27242260   | Hummus in flatbread          | 0          | Instruction/modifier (not a bowl) |
| 27242272   | No Onion                     | 0          | Customisation modifier |
| 27242276   | No yogurt                    | 0          | Customisation modifier |
| 27242284   | No Mayo                      | 0          | Customisation modifier |
| 27242292   | No Parsley                   | 0          | Customisation modifier |
| 27242308   | Split in Half                | 0          | Instruction/modifier |
| 27242316   | No Dukkah                    | 0          | Customisation modifier |
| 27242328   | TO GO                        | 0          | Instruction/modifier |
| 27242340   | 1 x Falafel Ball             | 0, 15      | Side |
| 27242344   | 3 x Falafel Balls/Mayo       | 39         | Side |
| 27242356   | Hummus TO-GO (35 kr)         | 20         | Side (pricing note: listed 35 kr but charged 20 in fixture) |
| 27242364   | Killer Fries (35 kr)         | 35         | Side |
| 27339842   | Legally required bag fee     | 4          | Fee |
| 28715716   | + BEER (+20kr)               | 0          | Beverage modifier |
| 28715731   | + Blå Thor (+20kr)           | 20         | Beverage modifier |
| 28715758   | Pilsner (45kr)               | 45         | Beverage |
| 28715788   | Heineken 0,0% (45kr)         | 45         | Beverage |
| 28717057   | BEER (45kr)                  | 0          | Beverage |
| 29569042   | Unknown external product     | 4          | Unidentified — appears once in TXN_068 (Wolt) |
| 29838736   | Lover                        | 35         | Unidentified — possibly a new drink/dessert |
| 29843293   | + Lover (+10 kr)             | 10         | Kombo addon for "Lover" — possibly lemonade variant; needs confirmation |

### Unresolved IDs requiring classification decision

| Product ID | Display name    | Concern |
|------------|-----------------|---------|
| 29838736   | Lover           | May be a new kombo-eligible lemonade or dessert item; confirm with ops |
| 29843293   | + Lover (+10 kr)| If "Lover" is a lemonade variant, this should be added to LEM_IDS |
| 29569042   | Unknown external product | Single occurrence on Wolt at 4 DKK; likely a fee or third-party line |

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

Product IDs:
- `27242208` — Kombo - Lamb
- `27242204` — Kombo - Falafel

`kombo_units = sum(count) for lines where productid ∈ {kombo PIDs} AND price > 0`

The kombo header line IS the roll — there are no separate zero-priced roll
component lines inside a kombo transaction.
Staff meals (price = 0) are excluded by the `price > 0` filter.
Refunds (count < 0, price < 0) are excluded by the `price > 0` filter.

---

## Standalone roll units

Product IDs:
- `27242336` — Killer Kebab
- `27242332` — Killer Falafel

`roll_units = sum(count) for lines where productid ∈ {roll PIDs} AND price > 0`

This includes rolls sold alongside kombos in mixed orders; they are legitimate
paid units and must not be excluded by transaction context.
Staff meals (price = 0) and refunds (price < 0) are excluded by `price > 0`.

---

## Kombo %

`kombo_pct = kombo_units / (kombo_units + roll_units) × 100`

Bowls are excluded from the denominator (no bowl sales in the reference data).
Rounded to 4 decimal places for display.

---

## Lemonade units

Product IDs:
- `27242080` — + Lemonade (kombo addon, 0 kr)
- `27242148` — + Killer Lemonade (kombo upgrade, +10 kr)
- `27242164` — Killer Lemonade standalone (35 kr)

`lemonade_units = sum(count) for lines where productid ∈ {lemonade PIDs}`

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

## Reference values — Nørrebro 2026-09-20

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
