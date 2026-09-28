# Dashboard database read preparation

The dashboard still defaults to OnlinePOS. This change prepares an explicitly selected, read-only database path for the existing sales-range and revenue-summary APIs. It does not deploy or enable the switch, run migrations, start importers, or change stored facts.

## Read contract

Set `KK_SALES_READ_SOURCE=database` only after review and provisioning `KK_SALES_READ_DB_URL` for a dedicated read-only login. Omitted or `onlinepos` keeps the existing path and does not load `pg`. Any other value fails configuration. Database errors never cause an invisible provider fallback.

The authenticated `/api/sales-readiness` route checks the exact four migration checksums and rejects superuser, role-management, database-creation, bypass-RLS or write-capable credentials. Each data read uses a single repeatable-read, read-only transaction; coverage, rows and signed totals must agree. No identity key or protected source identity is selected or exposed. PostgreSQL's [snapshot isolation](https://www.postgresql.org/docs/16/transaction-iso.html) supplies the consistent read; the [read-only transaction](https://www.postgresql.org/docs/16/sql-set-transaction.html) is an additional guard.

Existing public line keys and numeric metric values remain: product/group IDs, labels, signed count and VAT-inclusive/exclusive line totals, payment type/code, date, hour and second of day. IDs are lossless strings; existing consumers already accept strings or numbers. Revenue stays excluding VAT and is never multiplied by quantity. Signed refunds, zero-price product rules, store-aware channels, top items, Copenhagen dates and same-time LY boundaries retain their definitions.

Additional metadata reports source, every requested day's coverage/evidence/observation time, oldest/newest observations, and product-classification limitations. A closed stored day is a historical snapshot, not a live observation. Single-pass imports are not described as independently verified. Missing, invalid or open days produce HTTP 503, no partial lines and a null revenue summary. A completed empty day is zero. Unknown products remain included in revenue and top items; product count limitations are separate from storage completeness. The UI displays this information, including cached responses and missing-data errors, with text-only rendering.

Reads are bounded to 366 days, 100,000 lines and 32 MiB of serialized raw projection, with the existing two-connection pool and query timeouts. Unrepresentable numeric values and oversized ranges fail closed. Startup provider warming is disabled in database mode. Today is explicitly unsupported by the completed-day store and lemonade Today returns an unavailable total, not zero. Scheduled lemonade snapshots do not save incomplete data.

## Product review

`catalogues/onlinepos-metric-review.json` records all 41 exact PR #35 additions and their source group/label evidence. Forty are explicit non-counted modifiers, sides, add-ons or other drinks. No addition supplies evidence for a new standalone roll, combo or lemonade ID, so the canonical count sets remain unchanged. The Børnebab entries are source-grouped as Messages and their observed lines have zero price; treating them as additional paid rolls would double count an unsupported interpretation.

Indre By product `27241752` has an exact empty label in the Drinks group. It remains unresolved. Its one stored occurrence is September 24, quantity 1. The private report retains its financial impact. That revenue is included; whether the item should add one lemonade requires business/source identification. It cannot be classified from its price or a neighbouring product ID.

The metric review is bound to the exact reviewed catalogue digest. A subsequent catalogue change marks all product counts potentially incomplete until the metric review is updated; it does not hide revenue. The separate explicit unresolved-ID list also includes existing empty-label and external-placeholder products. These predate this switch and affect all 47 stored store-days (794 lines in the audited snapshot). External placeholders can make rolls, combos, combo percentage, protein breakdown and lemonade incomplete; empty drink labels can make lemonade incomplete. Total revenue, existing payment-based channels and financial ratios do not require product classification. Blank names appear as Unknown in the existing top-items display. Lover stays outside lemonade; Huuray and Splitbetaling stay unattributed. No product or payment tuple changes here.

## Reviewable production comparison

On September 28, the deployed `e18a1b4475a6155fcd4c4fc8b4f3033aa1e773c7` dashboard fetcher, sanitizer, metric engine and actual frontend channel/top-item/hourly functions were compared against the proposed adapter for:

| Store/date | Stored and fresh-source lines | Result |
| --- | ---: | --- |
| Nørrebro September 20 | 466 | Exact revenue, quantity and product metric parity |
| Fisketorvet September 23 | 663 | Exact revenue, quantity and product metric parity |
| Indre By September 24 | 812 | Exact revenue, quantity and product metric parity, including the empty drink label |

Three fresh requests reached genuine terminal pages using the existing strict traversal and total checks before replay through the deployed dashboard fetcher. This is a production-code comparison, not a browser-session scrape or a change to independent-verification metadata. No raw response was persisted. The largest numeric difference was 0.000244140625 DKK in the existing Float32 hourly array, due to addition order. Channel/top-item double-precision differences were below 0.00000000001 DKK; no displayed currency difference is material. Equal-revenue top-item ordering is not treated as a metric difference.

The adapter also read all 47 stored days through its actual SQL/serializer in a private read-only audit. All stored facts and physical row versions remained unchanged. Privileged production owner credentials were explicitly rejected by the web readiness gate. Local evidence contains per-product/day impact and detailed comparison values.

## Remaining storage and read-switch blockers

Storage remains 37/38 requested publications, 41/42 store-days September 21–27, and 25,958 facts including six verified September 20 canaries. Christianshavn September 27 is still missing. The validated protected envelope has one product-label `SENSITIVE_PATTERN` refusal and zero recoverable candidate tuples. The existing review path deliberately does not reveal that label; no gate was weakened or source retry made. An authorized operator must identify and resolve the exact business-neutral tuple through protected review, or correct the source, before another one-day import.

Cumulative request use is 82/90: 79 carried forward plus three explicit comparisons. No publication or independent-verification records were changed. All six workers and both canaries remain stopped and unscheduled. Temporary audit service, SSH key and local key material were removed.

This database contains September 20–27 only. A full dashboard switch would currently make Today, most month/year ranges, last-year comparisons and their budget bases unavailable. Workers are stopped, so there is no ongoing freshness guarantee. Do not enable a full read switch until those missing ranges/current-day behavior are addressed or a separately reviewed historical-only routing policy is agreed. Unresolved product counts must remain labelled until source evidence supports classification.

## Exact activation and rollback

1. Review and merge this preparation PR, deploy its exact merge SHA with `KK_SALES_READ_SOURCE` still omitted/`onlinepos`, and run smoke checks.
2. Provision a dedicated login with no superuser, write, owner, role-management, database-creation or bypass-RLS privileges. Grant schema USAGE, SELECT on migration version/checksum, the safe fact columns used in `lib/sales-db/dashboard.js`, and the coverage columns used there. The login needs no import/staging/identity-table access. Store its private connection string as `KK_SALES_READ_DB_URL`; no production reader credential is created by this PR.
3. Resolve/accept the documented coverage and metric gaps, establish the update/current-day policy, and approve the displayed comparison. In a private/staging deployment, require authenticated `/api/sales-readiness` to return ready and repeat representative API/UI checks with the read-only login.
4. Only with production cutover approval, set `KK_SALES_READ_SOURCE=database` and deploy. Confirm readiness, source metadata, missing-data behavior and health.
5. Roll back by setting `KK_SALES_READ_SOURCE=onlinepos` and deploying. No database mutation or data rollback is needed.
