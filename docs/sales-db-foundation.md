# Optional sales database foundation (Stage 1)

This foundation is disconnected from `server.js`. Nothing imports it during web
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
learned from provider payloads. No production catalog is supplied. The test-only
catalog contains the 54 inspected menu tuples and five payment labels from the
existing anonymized fixture; fixture transaction/source metadata never enters DB.
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
provider's current early-exit logic; a verified importer is still required.

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
