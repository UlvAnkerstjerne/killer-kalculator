# Killer Kalculator — Metric Specification

Store: Nørrebro
Reference date: 2026-09-20
Timezone: Europe/Copenhagen

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
