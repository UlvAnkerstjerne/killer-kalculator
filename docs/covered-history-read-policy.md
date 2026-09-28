# Historical sales read rollout

Keep `KK_SALES_READ_SOURCE=onlinepos`. Set the independent `KK_SALES_READ_POLICY=covered-history` only with the dedicated column-only login in `KK_SALES_READ_DB_URL`. Missing/`provider-only` policy keeps all reads on OnlinePOS. Invalid configuration fails startup. The older full database mode is not part of this rollout.

Every sales-range or revenue-summary request chooses one source for its entire store/range:

| Request | Source |
| --- | --- |
| Every requested day historical and completely stored | Database, one repeatable-read read-only snapshot |
| Today, future, or any span containing an open day | OnlinePOS for the whole range; database not consulted |
| Historical range with a documented missing day | OnlinePOS for the whole range; no partial database rows used |
| Database failure, invalid coverage, schema/privilege mismatch, totals mismatch or oversized stored result | Explicit unavailable response; no provider fallback |

`meta.source`, `readPolicy`, `routeReason`, `coverage`, and `databaseCoverage` distinguish the response's completeness from stored coverage. A provider result may be complete while stored coverage is incomplete. Open-range metadata explicitly says storage was not checked. Stored metadata retains every day's evidence, observation time and independent-verification status. Provider metadata retains cache age and traversal completeness. Classification warnings are separate from financial completeness and remain visible in Source & coverage, including browser-cache and coalesced responses. Each store may have a different whole-range source; chain totals require all stores and disclose both sources. Graphs stop if any selected store's sales fail; lemonade's chain total is unavailable if any store fails.

Revenue remains the signed VAT-exclusive line total, never quantity-multiplied. Canonical product IDs, refund and zero-price rules, payment/channel definitions, Copenhagen dates, point-in-time LY comparison and full-equivalent-LY × 1.10 budget are unchanged. Unclassified products remain in revenue. No catalogue or protected-text gate changes.

## Benefits with September 20–27 coverage

Store dashboard and graph requests wholly within complete stored dates use the database. Yesterday and Last Week benefit where fully covered. Chain requests use complete stored results for covered stores; Christianshavn's missing September 27 sends that store's whole affected range to OnlinePOS. Custom ranges wholly inside stored coverage benefit too. Today, This Week/Month/Year containing Today, older/uncovered periods, LY comparisons and budget bases still use OnlinePOS. Lemonade Today stays on OnlinePOS; saved lemonade history and Planday are unchanged.

Current-range warming remains OnlinePOS. Historical/LY speculative warming is disabled in coverage mode; requested uncovered history still uses existing provider caches. No worker is enabled and no import is required for activation. Coverage remains fixed until separately reviewed imports.

## Activation and rollback

1. Merge/deploy PR #36 with OnlinePOS selected; verify deployed merge SHA, health/static/auth smoke checks.
2. Review this policy and test the exact column grants in `operations/dashboard-reader-grants.sql`. Provision the dedicated login only with credential authorization. It must have no memberships, ownership, writes or protected-column access.
3. Deploy the policy code with OnlinePOS still selected. Privately configure the reader URL and `KK_SALES_READ_POLICY=covered-history`; never set the source to `database` for this rollout. Verify readiness, covered dates, explicit missing coverage, Today routing and deployed merge SHA. No migrations or fact writes run at startup.
4. Rollback: set `KK_SALES_READ_POLICY=provider-only` and keep the source OnlinePOS, then redeploy. No data rollback needed. Treat this as an explicit operator change, never an automatic response to errors.

A full database switch still requires Today/current-day support, wider history and LY/budget coverage, reviewed missing days and product classification, an operating freshness/update policy, and explicit approval. See the private operator runbook for Christianshavn; protected values do not belong in this repository.
