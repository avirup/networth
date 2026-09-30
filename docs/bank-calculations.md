# Bank calculation contributions — Phase 6

`lib/finance/bank-calculation.ts` implements the retained `bank-movements-v1` rule.
It is a pure, bounded calculation over confirmed posting evidence. Database reads and
workflow orchestration remain separate. There is no new dependency or migration.

## Financial outputs

A page contains at most 100 complete, two-leg bank events. The calculator validates
household/revision/date context, posting identities, exact balance, ledger shape, currency,
INR settlement precision, direction and adjustment quality before returning results.
Unsupported FX-conversion events or extra posting components fail the entire page; they
are not silently omitted or treated as ordinary income.

Account contributions have the grain account × native currency × ledger kind × date:

- `nativeDelta` and `bookDeltaInr` are debit-positive ledger changes.
- `cashDelta` contains asset-side movements, including transfers and card repayments.
  These are account movements, not external cash flows for a household/portfolio scope.
- `openingDelta` and `unresolvedDelta` separate reviewed equity adjustments from cash
  activity. Their postings still contribute to ledger changes once.
- Liability postings change principal and have zero bank-cash contribution. Positive
  debit movement on a card liability reduces its credit balance; it is not income.
- `incompleteEvidence` records the presence of a non-complete event quality marker.
  A false value does not prove that opening history or statement coverage is complete.

Monthly category contributions have the grain account × month × income/expense kind ×
category. Income reverses the credit-negative ledger sign; expense retains the debit sign.
Expense refunds reduce expense, income reversals reduce income, and exact correction
reversals use their posted signs once. Reclassification cancels the old category and adds
the replacement category. Null category remains explicitly uncategorized.

`postingCount` counts recognized posting evidence, including refunds and reversal legs.
An original plus reversal counts as two even when its amount nets to zero; it is not a
count of distinct surviving economic transactions. Account movement counts likewise count
posting legs. Zero-net groups are retained to preserve those audit counts.

All authoritative arithmetic uses decimal.js and decimal strings. Aggregation precision
allows totals to exceed an individual posting's magnitude bound without JavaScript number
coercion. Results have stable identifier ordering and 12 decimal places. Page contributions
are additive, but a future writer must commit each page exactly once with its checkpoint.

## Fixed-revision input reader

`db/calculations/bank-input.ts` is an internal, read-only diagnostic path called inside
`identity().scoped(...)`. It requires the current schema, verified household membership,
and a prepared candidate. It is not an HTTP reporting API or an Inngest worker entry point.

The reader fixes the candidate's source revision and requested as-of date. It reads confirmed
events through their import batch revision and resolves reversal kinds from original events.
It selects events touching planned accounts, then loads all their posting legs without
joining observations or ownership rows into the fact grain. Only immutable accounting
identities and category IDs are used; mutable display labels are excluded.

Pages use an effective-date/UUID keyset cursor, select at most 100 events plus one lookahead,
and retain complete posting pairs. Posting and response-size bounds fail closed. Every query
is household-scoped and subject to RLS. New imports, including backdated events, cannot enter
a candidate whose captured revision is earlier. Statement-only batches create no movements.

## What this does not establish

These are unallocated ledger contributions. They are **not account balances, closing
valuations, ownership-adjusted totals or net worth**. Statement observations remain evidence,
not an extra asset. Opening/coverage completeness, valuation policy and ownership still
need explicit evaluation. Foreign-currency book amounts remain their evidenced transaction
values, never a substitute for dated FX valuation. No cost basis or historical return is inferred.

[Candidate contribution persistence](bank-candidates.md) and a restricted token-bound worker input path are implemented. Inngest now advances these pages into balance checkpoints and complete [report releases](report-publication.md). The restricted worker still has no direct financial-table access. Pure [bank balance rules](bank-balances.md)
now evaluate evidenced openings, coverage and reconciliation using an internal authenticated
Postgres evidence reader and reserved worker checkpoint persistence. Release manifests reuse unchanged account generations. Longer-history checkpoint boundaries and non-bank valuation remain later work.

## Verification

Known-answer unit fixtures cover salaries, spending, refunds, income reversals, own-account
transfers, card repayment, reviewed opening/unresolved equity, corrections and category
changes, native versus INR book values, very large exact sums, null categories, months,
page additivity, invalid inputs and unsupported event kinds.

Postgres tests read complete bounded pages from a synthetic large import, resolve reversal
provenance, enforce prepared/household boundaries, and compare a captured page before and
after a later backdated import. Empty observation-only periods remain empty contributions.
