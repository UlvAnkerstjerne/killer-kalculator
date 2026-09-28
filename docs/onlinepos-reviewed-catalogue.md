# Reviewed six-store OnlinePOS catalogue

`catalogues/onlinepos-reviewed.json` is trusted catalogue admission data for the
existing explicit `--catalog` file loader. It contains 328 product tuples and nine
global payment tuples. It does not activate an importer, database read path,
worker, schedule or deployment.

## Worker trust and catalogue growth

The worker reads only the fixed repository catalogue and provenance paths via
`lib/sales-worker/catalog.js`. No argument, environment variable, provider result
or external file can supply its catalogue or provenance. Trust comes from the
reviewed deployment artifact containing both files, not from a provider response
or a count. Their checksums are integrity checks within that trusted artifact,
not signatures authenticating arbitrary external catalogues. Deployments must
remain pinned to reviewed source; replacing both files outside that process is
not an authorized catalogue update.

Provenance version 1 declares catalogue version 1: the existing exact
`products`/`payments` JSON shape. The version lives in provenance so the original
catalogue bytes do not change. The loader requires the byte checksum, canonical
UTF-8 serialization (including exact field order and trailing newline), sorted
tuple digests, global product/payment/store counts and each store's product count
and digest to agree. `reviewedStores` describes the current reviewed catalogue;
`sources` retains the original discovery provenance. All six existing store slugs
are required. Duplicate payment tuples, duplicate products and differing tuples
under one store/product ID fail closed. Existing exact tuple, safe catalogue text,
empty-label and whitespace rules still apply; text is never normalized.

This replaces the worker's unrelated literal 328-product/nine-payment count
check. Future repository-reviewed additions must update the catalogue and its
committed digests/counts together, but need no worker code edit. This loader
change itself preserves all 328 products and nine payments byte-for-byte and
grants no new admission or metric/channel classification. The manual importer,
verification and review diagnostics retain their existing explicit reviewed-file
workflow and shared tuple validator. Plan-only retains its read-only,
catalogue-independent contract; activated apply validates the committed catalogue
before opening its database session or requesting provider data.

## Approval and source correction

Ulv explicitly approved the exact observed tuples from the five retained discovery
artifacts, plus the retained Nørrebro production baseline, for catalogue admission
only. This approval does not assign product metrics, product families, payment
channels or reporting categories. Similar labels across stores confer no approval.

The repository previously contained only the reduced test catalogue at
`test/sales-db/reviewed-fixture-catalog.json` (54 products, five payments, null group
IDs/payment codes). It remains unchanged for existing fixture tests and is not the
production source. Ulv explicitly approved `work/catalog-production-baseline.json`
as the authoritative Nørrebro source: exactly 69 products, all Nørrebro, and seven
global payment tuples. Its SHA-256 matches the retained production catalogue audit:
`b9036f5e8ba08e1636d932a4766c85c4df84e2fc6a22c2fdd31923aed1338aa1`.
The complete exact contents of that baseline are now represented in the tracked
catalogue, with deterministic ordering/serialization and per-source checksums, so
the production-versus-fixture source mismatch cannot recur unnoticed.

## Retained sources and observation scope

Scope: 2026-09-20 inclusive through 2026-09-21 exclusive, Europe/Copenhagen.
Counts describe reviewed identities for this scope, not every possible future menu
item or a new claim of provider completeness. Nørrebro retains all 69 entries of
the prior reviewed baseline, not just the reduced day's test fixture.

| Store | Products | Source payment tuples | Retained artifact |
| --- | ---: | ---: | --- |
| Nørrebro | 69 | 7 | `work/catalog-production-baseline.json` |
| Vesterbro | 48 | 6 | `outputs/resumed-catalogue-discovery/vesterbro-unapproved-candidates.json` |
| Christianshavn | 54 | 6 | `outputs/pr14-catalogue-discovery/christianshavn-unapproved-candidates.json` |
| Indre By | 46 | 4 | `outputs/pr14-catalogue-discovery/indre-by-unapproved-candidates.json` |
| Fisketorvet | 61 | 7 | `outputs/pr14-catalogue-discovery/fisketorvet-unapproved-candidates.json` |
| Frederiksberg | 50 | 5 | `outputs/pr15-production/frederiksberg-unapproved-candidates.json` |

The source names above identify retained review artifacts, not runtime paths or
dependencies. Applications need only the repository catalogue and existing loader.
Payments use the existing global type/code schema; their union has nine tuples.
The original review envelopes retain `approvalRequired: true`. Approval comes from
Ulv's explicit admission decision, not from exporter classifications.

All six inputs were validated offline as complete UTF-8 JSON without duplicate
object fields, unexpected fields, unsafe text, duplicate/conflicting identities or
truncation. The Nørrebro source has only `products` and `payments` and matches the
prior audited bytes/counts. Each other source has the exact `kk-catalog-review-v1`
schema, expected store/range/timezone, approvalRequired=true and terminal=true.
Their product and payment occurrence sums each equal inRangeRows, and inRangeRows
plus excludedRows equals rows. No values were reconstructed from reports.

Only the five product identity fields and two payment identity fields were admitted.
Occurrence counts and exporter classifications are excluded from runtime data.
Product/group/payment spelling, spaces, capitalization, punctuation and the exact
empty string are preserved. No transaction IDs, protected identities, raw provider
rows, customer/card/clerk data or credentials are present.

## Narrow business decisions

- The exact Frederiksberg tuple is approved: store `frederiksberg`, product
  `27241352`, product label `""`, group `2911684`, group label `"Drinks "`.
  Different store/ID/group/label values remain unreviewed. Whitespace-only labels
  remain invalid even if proposed as reviewed entries.
- Every observed `Unknown external product` tuple is admitted as an identity and
  remains outside product metrics. No placeholder meaning is inferred.
- `Lover` and its observed add-ons are admitted as identities. Lover is a separate
  premium drink and remains outside lemonade metrics.
- The seven existing global payment tuples are retained. `Huuray` / `mixed 11`
  and `Splitbetaling` / `mixed` are explicitly admitted and remain operationally
  unattributed. Neither receives a cash/card/credit or delivery channel mapping.
- All product metric ID sets and channel mappings remain unchanged. Existing
  unknown/modified-tuple errors still quarantine a simulated import rather than
  publish it; prior facts and coverage remain intact.

## Integrity and validation

`onlinepos-catalogue-provenance.json` records the base commit, source byte hashes,
counts, per-source tuple hashes and complete catalogue hash. Product tuple hashing
uses compact JSON arrays in this order: storeSlug, productId, productLabel, groupId,
groupLabel. Payment tuple order is paymentType, paymentCode. Sort each tuple by its
JSON string using ordinal comparison, serialize the array of tuples as compact JSON
without a newline, then SHA-256 its UTF-8 bytes. The catalogue file uses those same
sort orders, the documented field order, two-space JSON indentation and one final LF.
Hashes cover catalogue content only; none are protected transaction identities.

Focused regression tests cover all approved tuples, exact spaces, source checksums,
the existing explicit file loader, empty-label restrictions, unchanged Nørrebro
behavior, privacy allowlists and actual metric/channel logic. Disposable PostgreSQL
tests cover catalogue quarantine while preserving prior facts and coverage. The
existing complete regression and PostgreSQL 16.15 suites remain required. Migrations
001–004 remain byte-for-byte unchanged; there is no new migration.

This admission task uses zero provider traversals and no production access.
Discovery remains **7**; Stage 3A remains **0/10**. No import, publication,
verification, merge, deployment, classification change or read cutover is authorized
by this catalogue. Persistence/verification calls in tests use only synthetic
transactions and disposable local PostgreSQL.
