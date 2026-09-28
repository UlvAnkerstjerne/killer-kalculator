# Bounded catalogue diagnostics

`--diagnose-catalog-review` is a separate, explicit review-only mode of
`scripts/sales-backfill.js`. It requires the usual store, inclusive start,
exclusive end and reviewed catalogue arguments. It cannot combine with another
mode. Existing export, structural-only, import and verification modes are unchanged.

A single provider traversal produces one `kk-catalog-diagnostic-v1` JSON object on
stdout. Stderr is unused. The traversal performs Copenhagen filtering before the
six-field catalogue projection, follows pagination to explicit terminal null,
and validates declared totals. There is no chronological early exit, database
configuration, identity generation, automatic retry or publication.

Outcomes:

- `candidates`: exit 0, exact unreviewed product/payment tuples only; no admission.
- `completed`: exit 0, no unreviewed tuples.
- `structural-review`: exit 1, bounded fixed field/reason/length/control-code-point
  diagnostics only; all candidate values are omitted when any text is refused.
- `operational-failure`: exit 1, fixed code and observed counters; no candidates.

The envelope records request count, parsed pages/rows, inspected in-range rows,
completed traversal, validated terminal, total presence (`unknown`, `absent`,
`present`, `mixed`) and total match. `terminal: true` means full traversal validation
completed. Partial received-row counts during failure do not imply validation.
Preflight argument/catalogue/credential failures can retain the existing fixed
CLI error instead; controllers must fail closed without a versioned envelope.

The maximum JSON envelope is 16 KiB. At most 12 combined product/payment
candidates or 12 structural signatures are retained. Candidate overflow fails
closed. Structural counts include omitted signatures. Safe-output inspection is
stricter than ordinary catalogue admission, without changing the latter.
Exact empty product labels are preserved for review; this does not approve a new
empty-label tuple. Classification labels describe review equivalence only and
never change product metrics or payment/channel attribution.

`diagnostic-process.js` captures both subprocess streams with independent bounded
buffers, a timeout and no retry. It validates the one canonical versioned object
before interpreting a nonzero exit. It rejects conflicting objects, duplicate
keys, trailing text, forbidden fields, unsafe text and arbitrary stderr. Only
fixed process/failure metadata and a fully validated envelope can be retained.
Timeout/signal evidence can preserve a complete safe envelope, while the overall
result remains an operational failure. Arbitrary output is never retained.

`runAndRetain` writes the validated process envelope through an exclusive mode-0600
temporary file, fsync and same-directory atomic rename before cleanup. A caller
must independently enforce exact scope, deployed source, credential isolation,
provider budget and runtime guards. A candidate result is not a trusted catalogue.

The previous task controller discarded a nonzero result before persisting it.
The deployed exporter also lacked a combined candidate/structural contract: normal
export returned only a fixed `CATALOG_TEXT_REVIEW` error, while structural mode
never returned candidate values. This opt-in contract addresses both problems
without reconstructing or asserting the cause of that historical failure.
