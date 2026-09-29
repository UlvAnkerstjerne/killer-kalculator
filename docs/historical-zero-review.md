# Historical zero observations and consolidated source scans

A zero day previously discarded a terminal historical scan and forced narrower
source traversals. Historical imports now default to durable review: publish
validated nonzero days, record zero observations in the same atomic bucket, and
continue through the range. The daily worker's nonempty guard is unchanged.

Migration 005 adds metadata only. It changes no fact, existing coverage value,
credential or grant. Existing migration files and checksums remain exact. Pending
zero dates and `RETRY_REQUIRED` remain uncovered; only Ulv's explicit
`VERIFIED_CLOSED` decision makes a zero date covered. Closure evidence is distinct
from independent source verification. Neither approval nor retention inserts a
sales fact or makes a provider request. Read-only column grants are unchanged.

The historical plan is derived under the publication lock from durable coverage.
It skips complete leading dates and operator-owned zero dates, consolidates
remaining years into one terminal scan per eligible store, and reconciles covered
interior dates without refreshing their facts or metadata. Known protected ranges
remain separate. The same monthly/day limits, global owner, single provider
transport, pacing, terminal checks, exact decimals, identities and catalogue gate
apply. A terminal staged snapshot can be resumed without source access after a
crash; incomplete traversals cannot be joined or resumed by page.

Focused PostgreSQL tests exercise mixed nonzero/zero publication, real column-only
reader routing, later closure, retry-required handling, idempotent observations
and decisions, immutable overlap, failed terminal totals, monthly rollback and
resume, staged-snapshot recovery, old observation retention and durable planning.
Migration tests compare fresh/upgrade schemas and unchanged physical fact and
coverage versions. Both 250/500-row staging sizes preserve exact totals and replay.

The deployed historical wrapper at the starting head already used 500-row
batches, although the library default is 250. It retains 500. An offline
PostgreSQL 16.15 benchmark used 8,000 synthetic rows, eight source pages and three
fresh runs per size: median 2,009 ms at 250 versus 1,930 ms at 500. Calculated staging
transactions fall from 32 to 16; peak RSS was 209–214 MB versus 212–217 MB. This is
local evidence, not a production throughput or 10× speedup claim.

See [the rollout procedure](onlinepos-historical-rollout.md) for the private review
commands, recovery boundaries and unchanged cumulative 96/9,600 budget. At the
safe implementation checkpoint, PostgreSQL held 550,146 facts and 1,160 covered
store-days, with no staging, pending publication or global owner. Nine previously
discovered zero dates have terminal durable summaries and require no refetch to
retain their observations. Source usage was 26 traversals and 522 requests.
