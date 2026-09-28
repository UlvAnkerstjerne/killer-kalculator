# Covered history plus Today

Under the existing `KK_SALES_READ_SOURCE=onlinepos` and
`KK_SALES_READ_POLICY=covered-history` settings:

- Fully covered closed ranges use PostgreSQL.
- Today alone uses OnlinePOS without consulting PostgreSQL.
- A covered closed prefix ending in Today uses PostgreSQL up to the Copenhagen
  midnight boundary and OnlinePOS for Today. Both segments must be complete.
- Any missing closed date sends the original whole range to OnlinePOS.
- Future ranges retain the existing whole-range provider behavior.
- A database error never triggers provider fallback. A failed or incomplete
  hybrid segment makes the entire response unavailable; no partial lines or
  revenue are returned.

Dates are calendar labels. The split uses the Copenhagen date and the existing
DST-aware provider midnight conversion, not a fixed 24-hour offset of an instant.
Metadata identifies both segments, their boundaries, stored verification evidence,
observation time, provider cache age and classification limitations. Chain totals
continue to reject a failed selected store.

## Bounded year views

The existing raw-lines response retains its 100,000-line limit. The dashboard
explicitly requests `?view=dashboard`, a bounded projection supporting up to one
million source facts per store/range. One read-only repeatable-read cursor reads
500 facts at a time, validates every fact with the reviewed catalogue and time
rules, and reconciles each day's exact count and signed money against coverage.
The reader needs no additional database privileges.

The projected rows group the exact product/payment tuple, Copenhagen date/hour,
and separate signs of inclusive revenue, exclusive revenue and quantity. This
preserves paid roll/combo rules, zero-price staff meals, signed refunds, lemonade,
channels, heatmaps, graphs and top-item quantities. `sourceLineCount` retains the
original number of facts for warnings. `topItemCount` preserves the existing
frontend's `(count || 1)` top-item rule, including zero-quantity nonzero-revenue
lines. `secondOfDay` is null on these explicit hourly aggregates. The raw-lines
API is unchanged when the view parameter is absent.

Compact revenue comparisons and budgets use a separate cursor projection. They
retain daily exact money and second aggregates for the requested cutoff date;
they never derive a point-in-time comparison from the hourly dashboard projection.
At most 100,000 dashboard groups and 32 MiB of projected lines are returned.
A bound or reconciliation failure remains a visible database error.

All aggregation uses fixed-scale integers before the existing checked numeric
JSON boundary. The browser already uses floating-point sums (and Float32 heatmap
cells); a change in summation order can produce display-order noise only. Shadow
validation must compare signed exact totals and displayed metric semantics, and
record any such numeric differences explicitly before deployment.
