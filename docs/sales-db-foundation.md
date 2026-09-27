# Optional sales database foundation and historical importer (Stages 1–2)

The foundation and the standalone historical importer are disconnected from `server.js`. Nothing imports it during web
startup, changes a route, switches reads, warms a cache, or contacts a provider.
The existing production environment needs no new variables. The only production
package change is a pinned `pg` dependency; installing it does not open a connection.
There is no database adapter flag in the web application.

## Configuration and explicit operations

`readConfig()` returns `{ enabled: false }` unless `KK_SALES_DB_ENABLED=true`.
With explicit enablement, `KK_SALES_DB_URL` must be a PostgreSQL URL. This setting
only enables callers of the standalone foundation API/CLI; it does not enable
web reads. No `.env` loader or credential files are read. Do not use production
credentials for testing. The factory creates a lazy pool with at most two
connections, 5-second connection and 15-second statement timeouts. Call and await
`database.close()` in a `finally` block. The migration CLI does this on success
and failure. No process signal handlers are installed into the web server.

Errors contain fixed codes only: no driver causes, parameters, connection strings,
row contents, source keys or provider errors. An idle-client error removes the
broken connection through `pg` and increments an aggregate health counter. No
SQL error object is logged. Do not add generic logging around SQL inputs.

Run migrations explicitly with `npm run db:migrate` and the two optional variables
above. Migrations never run on web startup. The versioned files in
`migrations/sales-db` execute inside one transaction, on one connection, under a
transaction advisory lock. The `schema_migration` ledger records SHA-256 checksums;
a changed applied file, missing applied version or non-prefix ledger fails closed.
Use a new additive migration for subsequent schema changes. A failed migration
rolls back the entire batch and releases its lock, including first bootstrap.
The optional migration directory argument exists for disposable test cases only.

## Schema

Everything lives in the `sales_foundation` schema:

- `sales_store`: the six fixed internal store keys/slugs; no external account IDs.
- `identity_key_check`: singleton non-secret key version and HMAC check digest.
- `sales_sync_run`: bounded date window, conservative observation timestamp,
  typed staging/published state, safe line count and content checksum.
- `sales_stage_line`: only the same validated facts as the final table, with run
  FK and synthetic batch page/position. Stage 1 represents one supplied batch as
  page 1; this is not evidence of any provider pagination traversal.
- `sales_line`: store-scoped protected identity, normalized sale date/wall-clock
  second/time quality, reviewed product/group/payment values, exact signed
  amounts/quantity, safe fingerprint and observation/change/run provenance.
- `sales_day_state`: explicit complete coverage, exact totals/count, published
  run, digest and observation/verification timestamps for every covered day.
- `schema_migration`: version, checksum and application timestamp.

Foreign keys bind stores, runs and the registered identity-key version. The line
PK is `(store_id, source_key)`; staging adds `run_id`. Secondary indexes are limited
to active store/date/second/key reads, store/run history, and run/staging dates.
There are no arbitrary JSON columns, derived metrics, job queues or worker state.
SQL is parameterized except static reviewed DDL and fixed internal column lists.
Migration ownership is privileged: a future deployment must separately authorize
an owner/migrator, narrow worker writer and web reader. No production roles,
grants, infrastructure, networking or secret management are provisioned here.

## Precision, time and privacy boundary

Money and quantity accept **decimal strings**, never JS Numbers. The constructor
accepts ordinary decimal notation, up to 20 integer digits, 18 fractional digits
and 38 digits total; magnitude must be strictly below 10^20. Scientific notation,
non-finite values and excessive precision are rejected, not rounded. The SQL
`exact_amount` domain uses unconstrained `numeric` with explicit magnitude and
scale checks; `numeric(p,s)` is deliberately avoided because it can round on input.
Aggregate columns remain unconstrained numeric with finite/scale checks. Database
reads cast decimals to text and install no global type parser. Canonical trailing
zero removal affects representation only. Signed revenue is already a line total:
never multiply it by quantity or recompute VAT. The future importer must preserve
source numeric lexemes before JSON Number conversion; that importer is not built.

Business dates are real Copenhagen calendar dates within 2000–2099. Ranges use an
inclusive start/exclusive end. A sale time may be missing independently of its
known business date. Naive spring-gap times are rejected. Repeated autumn times
are marked `payment_ambiguous`/`fallback_ambiguous` without inventing a UTC instant.
Observation timestamps are explicit UTC instants. SQL also enforces date/time
consistency and DST quality. No source order/payment timestamp strings are stored
beyond the normalized allowed local-time field.

`createSafeLine` rejects unknown input keys and constructs a new explicit allowlist.
`validateSafeLine` repeats validation at persistence and public serialization.
It excludes customer, debtor, card, clerk, employee, account, order, receipt,
terminal/table/pax information, raw line IDs, raw responses and credentials.
Product/group IDs are bounded identifiers. Product/group labels and payment
values must match `createReviewedCatalog` entries **exactly**, including reviewed
historical variants. The catalog is trusted reviewed configuration, never a list
learned from provider payloads. The [reviewed six-store catalogue](onlinepos-reviewed-catalogue.md)
is supplied as explicit trusted input at `catalogues/onlinepos-reviewed.json`; it
does not enable any database or importer operation. The separate test-only catalog
contains the 54 inspected menu tuples and five payment labels from the existing
anonymized fixture; fixture transaction/source metadata never enters DB.
Unreviewed names fail closed rather than silently changing top-item semantics.

`createIdentity` uses a 32-byte secret and HMAC-SHA-256 with distinct domains and
length-framed UTF-8 store slug/source identity. Numeric source IDs use canonical
non-leading-zero decimal spelling; bounded synthetic/alphanumeric IDs are allowed.
Raw IDs leave neither this helper nor the constructor. Fingerprints cover canonical
safe content only. Protected identities are pseudonymous, not anonymous, and are
excluded from public serializers and logs. They are never sent to a browser here.

The first successful publication binds the non-secret version/check marker in the
same transaction. A different key or version then rejects reads and writes. A
failed first publication leaves no marker behind. The identity key is supplied
explicitly to the pure helper; no real key is created, stored in the DB or added
to production configuration. Synthetic test keys are not suitable for deployment.
Key rotation/loss is not solved by changing an environment value: it requires a
verified re-export/re-key or controlled aliases while both keys exist. Preserve
keys for history that cannot be re-exported; a separately authorized recovery and
backup policy is required before real ingestion.

## Publication and future read seam

`publishCompletedRun` accepts only explicitly complete **closed** windows of at
most 31 days / 10,000 input lines, a UUID, exact expected unique count and a UTC
observation timestamp no later than now. These are Stage 1 safety bounds, not a
bulk importer. It checks same-ID conflicts, identity binding and prior committed
facts. Agreeing duplicate copies collapse; distinct identical-looking purchases
remain distinct. A run UUID can only repeat with the same metadata/content.
Unchanged overlapping publications update run/day verification, not every fact.
Changed/moved existing facts require future reconciliation; missing old identities
reject the run. There is no deletion inference. Older observations cannot replace
newer coverage. Facts, staging, key binding, run metadata and all days publish
atomically; staging is deleted inside the successful transaction.

Publication uses a separate transaction advisory lock to serialize this bounded
foundation operation. This does **not** implement or validate future worker
leadership, HTTP pagination completeness, rate limiting or correction discovery.
Callers cannot turn incomplete exports into certified data merely by trusting a
provider's current early-exit logic; the Stage 2 importer below supplies a separate terminal-traversal contract.

Reads run in a consistent repeatable-read snapshot. `summary` returns exact
strings and explicit coverage, with null totals for a never-synchronized/partially
covered range. A verified complete empty day returns zero. `lines` returns at most
1,000 safe rows per page, a bounded offset and `hasMore`; ranges are capped at 366
days. This internal pagination is not a drop-in replacement for existing routes.
Concurrent publications can change subsequent pages; a future API needs a
snapshot/cursor contract. No performance or historical-completeness claim is made.

Public health/readiness and all existing route response formats remain unchanged.
A future cutover must add a separately reviewed schema/readiness gate, coverage and
freshness UI, and compatibility serializer before any database read switch.

## Real PostgreSQL validation

The dedicated `Sales database foundation` workflow runs on PRs and main pushes.
It uses official `postgres:16.15-bookworm` pinned to
`sha256:efedf3595f1d6f415c08568ba171029bf54052e754cc9f030e3f2412b21f3d67`.
It waits for `pg_isready`, runs `npm ci`, syntax/whitespace checks, the complete
regression/pure foundation suite, explicit migrations, then `npm run test:db`.
Node is version 22; checkout/setup actions are pinned to commits. Permissions are
only `contents: read`; checkout does not persist credentials. There are no secrets,
deployment environments, packages/write grants, persistent mounts or uploads.
Test-session `PGOPTIONS` suppress PostgreSQL error/statement logging so deliberate
constraint failures do not put row details into service logs. The suite verifies
these settings in CI. All container data disappears with the hosted CI runner. Synthetic credentials
in this workflow are deliberately public and have no use outside that job.

For an already available disposable local PostgreSQL 16, create only a throwaway
`kk_foundation_test` database owned by `foundation_test`, then set
`KK_TEST_DATABASE_URL=postgresql://foundation_test:disposable_test_only@localhost:5432/kk_foundation_test`
and run `npm run test:db`. This suite resets its schema between tests and refuses
other database/user names, remote hosts or URL query options. It does not read
`DATABASE_URL`, skip itself, or use a mock when PostgreSQL is absent. Never point
it at a valuable database. The CI service is the verified environment for this PR.

Tests exercise migration bootstrap/repetition/concurrency/locking/checksum errors,
constraints, exact sub-øre and signed values, store/identity isolation, publication
idempotence/conflicts/rollback, missing versus empty coverage, DST, forbidden-field
canaries, independent sessions and pool cleanup. The unchanged Nørrebro fixture
must reproduce 466 lines, 13,143.68 DKK ex VAT, 2,120.48 Wolt ex VAT, 66 Kombo,
54 paid rolls, 55% Kombo share and 20 lemonades, using the existing metric engine.
No new live payload fixture, provider call, backfill, payroll change, infrastructure,
merge or deployment is part of this foundation.


## Stage 2: manual historical importer

The importer is an unused standalone CLI. **No production database or historical
backfill exists yet.** Nothing is provisioned or enabled by this change. It adds
no web imports, provider calls at startup, read switches, frontend changes,
recurring worker, scheduler, shadow reads, cache removal or payroll work. Existing
startup still needs no database variables. `npm start` and Railway configuration
are unchanged; migrations remain a separate explicit operation.

### Lifecycle and completeness

1. Validate explicit internal store, inclusive `--from`, optional exclusive
   `--through` (defaults to the current Copenhagen date, excluding the open day),
   reviewed catalog, optional database configuration and identity key/version.
2. With `--apply`, acquire one global session advisory lock on a dedicated
   connection. It also conflicts with the Stage 1 publication lock. No transaction
   remains open during network requests. Lock connection loss aborts fetching;
   every staging/publication query uses that same connection, with no replacement
   pool connection or silent reacquisition. SIGINT/SIGTERM cancel the request,
   finish safe cleanup when connected, and release ownership. SIGKILL releases
   the database lock when PostgreSQL detects the dead session.
3. Allocate a new run UUID and start at source page one. Parse a bounded page,
   construct reviewed safe lines immediately, and stage batches of at most 500
   lines (default 250). Record page/row/review counts, never continuation URLs.
4. Follow every validated continuation until an explicit `next_page_url: null`.
   Require an object envelope, array `data`, consecutive positive `current_page`,
   and a valid optional `last_page`. Missing continuation fields, missing/non-array
   data, unsuccessful envelopes, loops, stalls, redirects, unsafe paths/origins,
   or any ceiling fail the scan. Continuations must keep the exact initial HTTPS
   origin/path and contain exactly the next canonical `page` parameter. Additional
   provider cursor/query formats require separately reviewed contract support.
5. Only after genuine termination, filter the logical closed range and build
   date/month summaries. Validate identities, store isolation, exact totals,
   signed quantities, negative-price/quantity counts, refund totals and SHA-256
   over protected source keys plus safe fingerprints in sorted key order. Repeat
   validation from durable staging before publication or publication-only resume.
6. Compare with existing facts and, when requested, a separately completed prior
   scan. Quarantine corrections, changed dates, missing identities or independent
   verification mismatches before publishing any bucket.
7. Publish validated month buckets in short transactions, shrinking to individual
   days when a month exceeds 100,000 lines. A day above 100,000 lines fails before
   any bucket publishes; changing this safety bound requires review. Each
   transaction inserts only new facts, validates persisted count/totals/hash, and
   atomically commits day coverage and its durable bucket checkpoint. Unchanged
   facts are not rewritten. No transaction waits on a provider.

**Do not reuse `fetchSalesRange` date early-exit logic for completeness.** This API
is from-date onward with no reliable end bound. A page of newer dates may be
followed by older in-range records. Neither min/max dates nor empty `data` with a
non-null continuation terminates a scan. Only the midnight conversion helper is
shared with the existing fetcher. Neither that fetcher nor its callers changes.

Terminal traversal is **single-pass evidence**, not a provider snapshot guarantee
or proof of the earliest available history. `--verify-run` performs another full
page-one traversal after the referenced scan finished. Store/bounds must match.
Per-date counts, exact amounts/quantities, negative counts/refund totals and sorted
content digests must all agree; equal revenue alone is insufficient. Matching
independent passes strengthen evidence but cannot establish unknown provider
lifetime identity, pagination snapshot, correction or deletion guarantees.

### Precision and privacy

The bounded JSON grammar keeps every numeric token as its exact string lexeme.
`JSON.parse` is used only to decode quoted JSON strings, never numeric source
values. There is no new parser dependency, global parser override, floating-point
money conversion, per-line ore rounding, VAT recomputation or price-times-quantity
calculation. Exact decimal validation is the Stage 1 contract, including rejection
of scientific notation and unsupported magnitude/scale/precision. Aggregate
arithmetic uses scaled BigInt values and PostgreSQL numeric, serialized as strings.

Page limits are 16 MiB UTF-8, 10,000 rows, depth 16, one million JSON values and
64 KiB per encoded string. Duplicate/prototype keys, malformed UTF-8 and invalid
Unicode/NUL are rejected. Default scan limits are 10,000 pages and 2,000,000 rows;
row ceiling may be explicitly lowered or raised to at most 20,000,000. Hitting a
limit is failure, never a partial-success signal. The CLI HTTP transport makes
one request at a time, at most 30 starts/minute, with a 20-second total deadline,
no redirects/compression, and immediate safe failure on 429 or other errors.
There is no automatic retry that might mix different mutable scans.

The normalization allowlist is the Stage 1 fact contract: internal store,
store-scoped protected line key/version, validated business date and normalized
local time/quality, product/group IDs and reviewed labels, signed quantity and
exact inclusive/exclusive revenue, reviewed payment values and safe fingerprint.
Payment time takes precedence over fallback time; a malformed primary time is
not concealed by a valid fallback. A valid date-only value has missing-time
quality. Copenhagen spring gaps fail; naive autumn repeats remain ambiguous.

A trusted reviewed catalog file is mandatory; it is never learned from a response.
Unknown product/group/payment values are discarded, counted and quarantine the
entire scan. Their text does not enter staging, facts, reports or diagnostics.
Review must use a separately authorized source/catalog process. Raw customer,
debtor, card, employee/clerk, order, company/account, table/terminal/pax, arbitrary
JSON, headers, credentials, URLs and response/error bodies are never persisted.
Raw line IDs are discarded after the Stage 1 domain-separated, length-framed
HMAC derivation. Fingerprints cover only canonical ordered safe fields, excluding
private properties, input property order, ingestion time and derived metrics.
The importer implementation supplies no source identifiers, credentials or payload.
The separately reviewed catalogue is documented above and selected explicitly by path.

### Runs, evidence and recovery

Migration `002_backfill.sql` extends the existing run table with `run_kind`,
retains the original 31-day/10,000-row limits for foundation callers, and permits
bounded historical importer runs and larger publication buckets. It adds:

- `sales_import_scan`: finite importer lifecycle, terminal flag, page/row/review
  counters, exact totals/negative counts, safe error code, completion timestamp
  and independent-verification reference.
- `sales_import_day`: per-run/store/date counts, exact totals and sorted checksum,
  including explicit zero-line dates.
- `sales_import_bucket`: atomically published month/date checkpoints linked to
  existing `sales_sync_run` publication records.
- `sales_import_discrepancy`: protected identity and old/new affected dates and
  fingerprints for changed/missing candidates. No raw identity or payload.
- `sales_day_state.evidence` and `verification_run`: distinguish single-pass
  completion, independently verified data and independently verified empty dates.

The run states are `fetching`, `staged`, `validated`, `publication-pending`,
`published`, `quarantined`, `failed`, `interrupted`. Stage 2 coverage reports
`never-synchronized`, `staged`, `complete-single-pass`, `independently-verified`,
`conflict-quarantine`, or `verified-empty`, with latest-attempt state separate
from previously published coverage. A single empty pass is explicitly single-pass,
not independently verified empty. Older observations cannot replace newer coverage.

An incomplete, invalid, failed or interrupted **source scan** cannot change facts
or coverage. It must replay page one with a new UUID. Sanitized fragments from
separate scans never combine. Handled failed/quarantined staging is removed
immediately in 1,000-row cleanup batches; success also purges staging. After a
process crash, the next apply invocation under ownership marks abandoned scans
interrupted and clears their staging before a new fetch. Run/day/discrepancy
metadata remains for audit. There is no background retention daemon: crash leftovers
remain until that explicit CLI cleanup, bounded by the scan quota.

A failure **after terminal validation during publication** leaves the failed
bucket unchanged and the scan `publication-pending`. Earlier atomically committed
buckets remain valid checkpoints; this is not reported as successful completion.
`--resume-publication` revalidates the immutable staged snapshot and publishes only
remaining buckets without contacting the provider. A pending publication blocks
starting another source scan for that store, bounding retained staging. Staging is
kept until all buckets finish. Database statement/transaction safeguards bound
operations; very large buckets can safely fail rather than certify incomplete data.

No stored fact is deleted, deactivated or overwritten based on an absent or
changed source identity. A moved date records both dates. Candidate corrections
and discrepancy resolution remain quarantined for a later separately reviewed
reconciliation policy; Stage 2 does not implement tombstones or the Stage 3 worker.

### Explicit operations (placeholders only)

Supply optional configuration through the execution environment, not a committed
file: `KK_SALES_DB_ENABLED=true`, `KK_SALES_DB_URL=<disposable-connection-url>`,
`KK_SALES_IDENTITY_KEY_HEX=<stable-32-byte-key-as-64-hex-digits>`,
`KK_SALES_IDENTITY_KEY_VERSION=<positive-version>`,
`KK_BACKFILL_TOKEN=<separately-authorized-token>`, and
`KK_BACKFILL_COMPANY_ID=<separately-authorized-company-id>`.
No production values are configured by this implementation.

```sh
# Explicit schema operation; never performed by the importer or web startup.
npm run db:migrate

# Default is validation only; also accepts --validate or --dry-run.
npm run sales:backfill -- --store '<internal-store>' --from '<YYYY-MM-DD>' \
  --through '<exclusive-YYYY-MM-DD>' --catalog '<reviewed-catalog-path>' --dry-run

# Separately authorized database writes require --apply.
npm run sales:backfill -- --store '<internal-store>' --from '<YYYY-MM-DD>' \
  --through '<exclusive-YYYY-MM-DD>' --catalog '<reviewed-catalog-path>' --apply

# A new independent traversal against a previously published scan.
npm run sales:backfill -- --store '<internal-store>' --from '<YYYY-MM-DD>' \
  --through '<exclusive-YYYY-MM-DD>' --catalog '<reviewed-catalog-path>' \
  --verify-run '<published-run-uuid>' --apply

# Only a terminal, validated publication checkpoint can resume without fetching.
npm run sales:backfill -- --store '<internal-store>' --from '<YYYY-MM-DD>' \
  --through '<exclusive-YYYY-MM-DD>' --catalog '<reviewed-catalog-path>' \
  --resume-publication '<pending-run-uuid>' --apply
```

Validation mode performs no database connection/write and retains at most 20,000
unique safe projections / an 8 MiB accounted payload budget; exceeding it fails.
Full-history validation uses `--apply` and bounded durable staging. Both modes
require explicit enabled configuration and a valid identity/catalog. There is no
implicit reuse of the web process's tokens or store/company configuration.
Progress contains safe run UUIDs, internal store/date bounds, counts and exact
aggregate totals only. No protected identity, fingerprint or free text is logged.
Exit is nonzero on invalid/incomplete scans; only fully completed publication
emits `published`. `validated-only` never claims publication or independent proof.

### Read-only catalogue diagnostic

`--diagnose-catalog` is an explicit diagnostic mode, mutually exclusive with
`--apply`, `--dry-run`, `--validate`, `--verify-run` and `--resume-publication`:

```sh
node scripts/sales-backfill.js --store '<internal-store>' --from '<YYYY-MM-DD>' \
  --through '<exclusive-YYYY-MM-DD>' --catalog '<reviewed-catalog-path>' --diagnose-catalog
```

It uses the existing bounded, lossless production traversal and normalizer,
including genuine terminal pagination, declared totals, Copenhagen timestamp
validation, protected identity derivation and exact decimals. It performs no
database connection, writes, staging, publication, verification or quarantine.
Raw rows and temporary normalized batches remain in memory only. It does not
retry failed requests or exit early when a later date appears.

Only after terminal validation, the output contains pages, provider-row count,
affected-row count (`reviewCount`, counted once per provider row), and
fixed category counts for `before`, `inside` or `after` the requested interval.
The start is inclusive and the end exclusive. Categories are `product` (the
whole product/group tuple), `payment-type` (an unknown payment label), and
`payment-type-code` (an unreviewed code paired with a known payment label).
One row can contribute to multiple field categories. A code paired with an
unknown label is reported as `payment-type`; no equivalent mapping is inferred.
No candidate value, identity, protected digest, exact candidate date, private
field or per-candidate amount is emitted. Malformed rows fail closed, and an
incomplete scan emits no successful diagnostic report. The normal date-only
source contract remains valid with explicitly missing time; absent or invalid
primary/fallback dates are rejected, including Copenhagen spring DST gaps.

`catalog-diagnostic` and `verified: false` mean only that the diagnostic finished.
They do not approve a mapping, establish provider/database agreement or permit
publication. The existing import path still validates the catalogue before
range filtering, so an out-of-range unknown still fails ordinary validation.
The diagnostic supplies evidence for a separately reviewed correction; it does
not move that filter or change the trusted catalogue. Operational identity-key,
database, deployed-version and scope preflight remains required before a live
diagnostic; this read-only mode does not establish those prerequisites itself.

### Stage 2 verification

The existing pinned PostgreSQL 16.15 workflow retains `contents: read` only,
synthetic credentials, no repository secrets, no deployment environments and no
uploads. It adds an explicit zero-vulnerability audit and the real importer suite.
Test subprocesses block public HTTP/fetch access while allowing loopback services.
The test launcher scans buffered diagnostics for private canaries before emitting
only test names/counts and safe aggregate memory results; row/driver assertion
bodies are not uploaded. PostgreSQL error-statement logging remains suppressed.
All CI service data disappears with the runner.

The existing 859 regression tests and 30 real foundation tests remain; migration
ledger expectations now include the second file. Importer tests cover malformed
and reordered pagination, precision, corrections/absence, atomic publication,
page-one crash replay, actual independent sessions, SIGKILL/connection-loss
ownership, privacy, CLI write refusal, DST, independent checksums, and the unchanged
466-line reference fixture. A synthetic 100,000-row/100-page PostgreSQL traversal
records bounded page/batch size and observed heap/RSS. These are synthetic memory
measurements, not production throughput, historical inventory or live provider
contract validation. No production database/backfill or cutover is authorized here.

### Unapproved catalogue review export

`--export-catalog-review` is a separate, explicitly authorized discovery operation.
It cannot be combined with apply, dry-run, validation, verification, resume or
aggregate diagnostic modes. It requires only the intended store's provider token
and company mapping, plus an existing reviewed catalogue as a comparison baseline.
It does not read database/identity configuration, connect to PostgreSQL, construct
protected identities, stage, quarantine, publish or verify anything.

```sh
node scripts/sales-backfill.js --store '<internal-store>' \
  --from '<inclusive-date>' --through '<exclusive-date>' \
  --catalog '<unchanged-reviewed-catalog-path>' --export-catalog-review
```

The existing bounded parser and traversal reach the genuine terminal page and
validate declared totals across all rows, without chronological early exit. Store
and Copenhagen time validity are checked before inclusive-start/exclusive-end
filtering. Only in-range rows contribute catalogue candidates. Source IDs,
monetary fields and arbitrary private properties are never read by the collector.
Raw responses remain in memory; the command does not write files.

Output is one `catalog-review-candidates` envelope with `approvalRequired: true`,
traversal/range counters, and separate `productCandidates` and `paymentCandidates`.
Each exact tuple has an occurrence count and is deterministically sorted. The
envelope intentionally lacks `products`/`payments` and cannot load as a trusted
catalogue. At most 10,000 distinct product tuples and 100 payment tuples are retained.
No partial envelope is emitted on error.

`already-reviewed` means exact membership in the supplied baseline; it does not
approve new data. `mechanical-cross-store-equivalent` requires an existing tuple
from another store with identical product label, group ID and group label; only
store and product IDs may differ. `novel` means neither test matched. Payment
membership is global in the existing trusted schema and requires the exact label
and code, including case, spaces and nulls. Different payment codes remain novel.
These are comparison facts, not business-classification or approval decisions.

Every candidate string has schema/length/control-character validation. Conservative
checks reject email/contact details, phone-like label text, card-like digit runs,
credential/hash patterns and explicit personal-data markers. Suspicious or malformed
text yields only `incomplete`, `CATALOG_TEXT_REVIEW`, `redacted: true`; no candidate
values are echoed. Pattern checks cannot recognize every personal name or business
ambiguity, so every candidate still requires human review. Never automatically
load the envelope into the trusted catalogue, infer business metrics from similar
names, or expand the catalogue just to make an importer pass. The existing
`--diagnose-catalog` aggregate-only privacy contract is unchanged.

### Structural catalogue-text diagnostics (explicit opt-in)

For a separately authorized traversal, add `--diagnose-catalog-text` to the
existing review command:

```sh
node scripts/sales-backfill.js --store '<internal-store>' \
  --from '<inclusive-date>' --through '<exclusive-date>' \
  --catalog '<unchanged-reviewed-catalog-path>' \
  --export-catalog-review --diagnose-catalog-text
```

The flag requires `--export-catalog-review`. All existing exclusions for apply,
validation, resume, verification and aggregate diagnostics still apply. It uses
the same parser, strict store/time checks, range filter, pagination, terminal
proof and declared-total checks. It never retries. After a catalogue-field
rejection it continues that same traversal to collect bounded structural issues;
any other traversal failure discards the summary and returns the existing fixed
error. It does not load a database client, database configuration, import owner,
repository, publisher or identity module. Shared pure schema/time validators are
still used. No writes or protected identities are created.

This mode never emits candidate values, including on success. Its non-loadable
format is `kk-catalog-text-diagnostic-v1`, with `redacted: true` and
`approvalRequired: true`. If any field is rejected, it reports `status:
incomplete`, `code: CATALOG_TEXT_REVIEW`, and exits **1**. If none is rejected it
reports `status: catalog-text-diagnostic` and exits 0; this is not catalogue
approval or verification. The ordinary command retains its fixed error envelope
and exact non-empty candidate output. Migration 004's field-aware empty-label
exception and whitespace rejection are described below; structural diagnostics
retain their original text boundary.

Each retained diagnostic has only these properties:

- `candidateKind`: `product` or `payment`.
- `fieldRole`: `product-id`, `product-label`, `product-group-id`,
  `product-group-label`, `payment-type` or `payment-type-code`.
- `reason`: one of the fixed enums below.
- `utf16Length`, `characterLength`, `utf8ByteLength`, `lengthsCapped`.
- `offendingCharacters`: at most four `{position, codePoint}` pairs, and
  `charactersTruncated`.
- `occurrences`: number of rejected fields with this identical structural shape.

Reasons are `UNSUPPORTED_TYPE`, `EMPTY_TEXT`, `LENGTH_LIMIT`,
`FORBIDDEN_LINE_BREAK`, `ANSI_ESCAPE`, `CONTROL_CHARACTER`, `BIDI_FORMATTING`,
`FORMAT_CONTROL`, `SENSITIVE_PATTERN`, `INVALID_IDENTIFIER`,
`INVALID_PAYMENT_CODE`, `INVALID_UNICODE`, `UTF8_BYTE_LIMIT`, and
`UNSAFE_OUTPUT_SEQUENCE`. `SENSITIVE_PATTERN` deliberately does not distinguish
particular secrets, identities or personal details.

`LENGTH_LIMIT` retains the original limit of 160 UTF-16 code units for labels and
64 for IDs/codes. Character count means Unicode code points, not grapheme clusters.
Positions are zero-based UTF-16 offsets. Only control/format characters and lone
surrogates can appear as `U+XXXX` code points; ordinary source characters are never
encoded into the diagnostic. For unpaired surrogates `utf8ByteLength` is null,
because there is no valid UTF-8 representation. Non-string values have null
lengths and are never coerced, enumerated or stringified. Measurement is capped at
65,536 UTF-16 units, without splitting a surrogate pair; `lengthsCapped` indicates
lower-bound measurements. Rejected source text is never trimmed, replaced,
normalized or accepted. The pre-existing NFKC privacy-pattern check remains a
comparison only and never supplies output text.

Explicit diagnostics additionally refuse labels above 320 UTF-8 bytes, malformed
Unicode, Markdown/table/HTML delimiters, Unicode line separators, formula-like
prefixes and quoted transaction/customer-shaped fields. These additional refusals
are confined to this structural mode; they do not silently redefine ordinary
export. Benign `+ Dip`-style prefixes, Danish characters and supported trailing
spaces remain valid. A formula-like `+SUM(...)` is refused. There are no label
previews or identifier values: a provider's catalogue-field name and permissive
identifier syntax cannot establish that its contents contain no personal data or
secret. This deliberately limits the human reviewer to structural clues.

At most 12 distinct structural signatures are retained, sorted deterministically.
The lexicographically smallest signatures are kept regardless of row order;
`diagnosticsTruncated` and `omittedFields` disclose omissions. Kept signatures have
exact occurrence counts. The envelope also includes fixed scope/traversal fields,
`inRangeRows`, `excludedRows`, `rejectedRows`, `rejectedFields` and
`diagnosticLimit`. Serialized output is capped at 16 KiB. There are no row numbers,
raw object keys, product/group identifier values, label fragments, hashes, payload
snapshots or partially accepted candidates.

The strict lossless parser still rejects NUL and unpaired Unicode anywhere in a
provider page before catalogue-field attribution. Such input returns only
`INVALID_JSON`; it cannot safely be assigned a field role without changing that
parser boundary. No malformed page is reparsed by a second scanner. Structural
Unicode/control inspection is tested independently, but this mode makes no claim
that pre-parser failures can be localized. It cannot reconstruct a value from an
old failed run. The rejected Frederiksberg value was never retained and remains
unknown; any future provider traversal needs separate explicit authorization.

## Explicitly reviewed empty product labels (migration 004)

`004_empty_product_labels.sql` replaces only the product-label check on
`sales_line` and `sales_stage_line`. Migrations 001–003 remain byte-unchanged.
Both columns stay `text NOT NULL`. Exact `''` is allowed; non-empty labels must
have 1–160 PostgreSQL characters, contain no `[[:cntrl:]]` characters, and include
at least one character outside Unicode White_Space plus U+FEFF (BOM). An explicit
Unicode character set in a `btrim` predicate makes whitespace-only rejection
independent of locale whitespace classes. This never trims or rewrites data;
`Killer Kebab `, `+ Harissa, a little `, internal spaces and Danish letters survive
exactly. Application label length remains the existing 160 UTF-16-unit bound.

The migration locks both tables and requires exactly one validated, local,
single-column check of the expected PostgreSQL 16 canonical old shape on each.
Missing, extra, altered, unvalidated or multi-column product-label checks, or a
nullable product-label column, cause a fixed error. Constraint names are read
from verified catalog metadata and retained. The existing migration runner owns
the atomic transaction, advisory lock and checksum ledger; a repeat applies zero.
Fresh 001–004 and upgraded 001–003 schemas must be structurally identical.
Validation scans existing rows without copying or rewriting them. If existing
whitespace-only data violates the new check, the entire migration rolls back;
this migration never repairs, deletes or changes such data. It requires explicit
migration authorization separately from application deployment.

Only the product-label field receives the exact-empty exception in candidate
export and reviewed catalogue validation. Other labels remain nonempty and now
reject whitespace-only text. Group fields remain nullable; identifiers and
payment types remain nonempty. Payment codes retain their existing space/null
contract. All existing sensitive-pattern, Unicode, control and length checks
remain at their respective boundaries. Structural-only text diagnostics still
report `EMPTY_TEXT` for `""`; `UNSAFE_OUTPUT_SEQUENCE` remains diagnostic-only.

The ordinary exporter retains `kk-catalog-review-v1`: `productLabel: ""` is
unambiguous, and `approvalRequired: true` already requires human review. No extra
property or format version is needed. Candidates retain the exact store/product/
group tuple and affected-row count; an empty label cannot be mechanically
equivalent to a non-empty label. The envelope cannot load as trusted catalogue
input. Unsafe other fields fail the entire export with no partial candidates.
No candidate is automatically approved, including cross-store equivalents.

Only a deliberately supplied exact reviewed tuple admits an empty label. Approval
does not cross stores, product IDs, group IDs/labels or label variants. Normal
staging and publication keep `""`; an unreviewed replacement quarantines without
changing prior facts or coverage. Fingerprints include the label, content digests
include fingerprints, and independent verification compares exact stored columns
in addition to summaries. Empty and non-empty variants therefore differ even
when counts and monetary totals match. Replays remain idempotent.

The existing API allowlist preserves empty text. The existing UI may display
`Unknown` without mutating API or stored values. Product metrics continue using
registered IDs only, with no label inference or empty-label exclusion. No UI,
metric IDs, payment/channel rules, worker or web read activation changed. All new
catalogue fixtures are synthetic; no real Frederiksberg identifiers are supplied.

Disposable PostgreSQL 16 tests cover fresh/upgrade schema equality, unchanged
rows (including fingerprints, row locations/versions and table identity), ledger
idempotency, old checksums, both-table acceptance/rejection matrices, schema drift,
atomic rollback, staging/publication, exact verification, and prior-fact retention.
These tests use no provider or production database access.
