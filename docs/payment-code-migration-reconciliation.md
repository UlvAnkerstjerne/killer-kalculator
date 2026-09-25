# Payment-code migration reconciliation

Migration `003_payment_code_spaces.sql` preserves the exact 1,021 bytes recovered
from the original local file-write record dated 2026-09-25T10:40:14.407Z. Its
SHA-256 is:

```
7c8d9a9a17b74d7140b00b667641982013e6d67c8bb04cfceea14db33a6e4f96
```

This matches the production migration ledger entry applied at
2026-09-25T10:41:05.336Z. Do not edit this migration, including its trailing blank
line. Migrations 001 and 002 are unchanged. The checksum regression fixture
protects all three immutable files.

## Why it exists

OnlinePOS payment codes can contain an ASCII space, for example `mixed 1`.
The original generic identifier validator and database check rejected this value
even when the payment type/code pair was in a reviewed catalog. The recovered
code gives payment codes a separate bounded ASCII validator. Product/group
identifiers retain their original rules. Codes are preserved exactly: no
trimming, whitespace collapsing, coercion or case conversion. Catalog membership
still requires an exact reviewed payment type/code pair.

Migration 003 replaces the two payment-code check constraints on facts and
staging. It performs no data UPDATE, INSERT or DELETE, changes no identity or
fingerprint, and does not mark any import verified. The migration runner's
transaction and advisory lock apply unchanged. A second migration apply is a
ledger-verified no-op. Tests also upgrade a populated 001–002 schema and compare
facts, staging and coverage before and after.

The metadata-only schema comparison also requires fresh and upgraded 001–003
schemas to match, limits the 003 upgrade diff to the two payment-code checks, and
checks that repeated migration application causes no schema drift. A negative
test adds an untracked column without changing the ledger and detects the drift.
The comparison covers relations, columns, constraints, indexes, types, triggers,
routines, rules, policies and sequences in `sales_foundation`; ownership/ACLs and
objects outside that schema require a separate operational audit. These synthetic
tests do not establish the current live production schema. A fresh read-only
production comparison remains required before claiming there is no other drift.

## Recovered provenance

The earlier source worktree `/tmp/kk2-canary` was created from main
`d08c7133ad00ef6b834fca5b0dee52fe01b61dce`. Its local branch
`fix/payment-code-spaces` never advanced beyond that commit. The worktree was
subsequently removed with uncommitted edits, so no Git commit originally contained
migration 003. Recovery used the original Write/Edit records, not a reconstruction
from database schema.

Railway deployment `60c7b8d1-1742-44bb-bb52-4aa6d349aa19` used the uploaded tree
and image digest
`sha256:a0b2d0a1df763f55b1f7c9f97d9b500c9db9f8c49cfb7178eeb3caf1728e084a`.
Its Docker command was `sh canary-run.sh`; `CANARY_MODE=migrate` selected
`node scripts/migrate-sales-db.js`. Runtime logs reported one migration applied,
three total. No source commit was embedded; logs reported `Commit: unknown`.

The exact associated application edits recovered into this change are confined
to `lib/sales-db/values.js` and `lib/sales-db/facts.js`. Operational Docker/canary
scripts and a catalog generated from a provider response are deliberately not
introduced as supported repository workflows. A provider-derived catalog needs
separate review; it is not independent verification evidence.

## Why four imports exist

The earlier operator issued this deployment sequence twice:

```
railway variable set CANARY_MODE=apply && railway up --detach
```

The variable update automatically deployed the existing uploaded image, and
`railway up` created another deployment. Each selected the same command:

```
node scripts/sales-backfill.js --store norrebro --from 2026-09-20 \
  --through 2026-09-21 --catalog canary-reviewed-catalog.json --apply
```

| Published UTC | Deployment | Trigger |
|---|---|---|
| 2026-09-25 10:45:02.937 | e2f94700-b4eb-4278-8947-46455be8f02f | Variable-triggered redeploy |
| 2026-09-25 10:45:05.611 | 0adb1fc3-e7ba-48ae-8b1a-ac8fcd210bd9 | Explicit upload; an overlapping attempt first reported IMPORTER_BUSY |
| 2026-09-25 10:49:19.028 | d224e35e-1c9a-48dd-ae9d-62cb0f04f9cb | Variable-triggered redeploy |
| 2026-09-25 10:49:25.899 | 9e20b060-25cd-4048-aa0f-c10356f1a2c1 | Explicit upload |

All four were applies, not dry runs or `--verify-run` scans. The earlier dry-run
deployment was `4f9f6cfe-1b64-4db3-aabd-27b5d95bf14c`. The four published scans
therefore retain `verified=false` and `complete-single-pass` coverage. Repeated
publication does not itself establish independent verification.

## Operational boundary

Adding these files does not authorize a production migration or import. Database
support remains optional and disabled by default. The web entry point, routes,
frontend, metric calculations, caching and warming are unchanged. This change
does not create a scheduler, worker, provider call or read cutover.

Before a separately authorized independent provider verification, reconcile the
approved deployed importer version, review the catalog independently, retain the
existing identity key, and run exactly one execution with restart NEVER and
variable updates configured to skip automatic deployment. Do not use the unused
replacement key and do not manually alter existing verification flags.
