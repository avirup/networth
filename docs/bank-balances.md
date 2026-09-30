# Bank balance rules

`lib/finance/bank-balance.ts` implements the pure `bank-balance-v1` rule for one
bank/cash account, native currency, captured revision and inclusive date window.
A restricted worker persists private checkpoints; schema 9 release manifests publish only reconciled reportable values and retain incomplete values with reasons.

The rule accepts at most 1,000 daily movement grains, coverage declarations and
closing observations in each collection. The caller must assemble **all** evidence
for the window from the authorized household and captured revision. Passing a
partial page as a complete window is invalid. Longer histories must be split at
verified checkpoint boundaries; truncation is never a fallback.

There are two supported starting points:

- A reviewed opening ledger balance at the window's start. Its amount must match
  the first day's opening contribution. It is already in ledger movements and is
  counted once. Earlier history stays unknown.
- A previously reconciled native closing checkpoint immediately before the window.
  Its balance is rolled forward with the window's movements. A backdated change
  invalidating that checkpoint requires rebuilding from an earlier valid point.

A statement observation alone cannot establish either starting point. Missing
opening evidence leaves the calculated balance unknown. Zero is a valid evidenced
balance, never a default for missing history. Opening changes later in a window
require a rebuild rather than adding another opening to an existing balance.

Complete coverage declarations must cover every calendar day. Adjacent and
overlapping declarations form a union; partial and balance-only declarations do
not fill gaps. Coverage evidence does not add money or duplicate ledger events.
The caller must resolve linked/corrected source evidence before declaring coverage
complete; an import's completeness label alone cannot prove this.

Only closing evidence on the requested date participates in reconciliation.
Older observations are not silently carried forward, future observations are
rejected, and conflicting known balances remain incomplete. Observations are
compared with the calculated balance, never added to it. Differences are reported
only with a known opening and complete coverage.

`calculatedBalance` is a diagnostic roll-forward, not necessarily a usable book
balance. `reconciledBalance` is available only with complete coverage, matching
closing evidence and no unresolved evidence. Reasons accompany every incomplete
result. Unknown earlier history remains independent of current reconciliation;
matching today's balance does not establish earlier cash flows or returns.

Unresolved event counts must come from captured source events, including reversals.
Daily net deltas can conceal cancelling unresolved adjustments, particularly on a
day that also contains an opening. The worker must verify this count and opening
provenance; this domain function does not authorize evidence IDs. Movement totals
must be deduplicated and their native buckets must reconcile exactly.

The result retains scope, rule version and evidence IDs. It is an unallocated
native account balance, not an INR valuation, available balance, card outstanding,
position or net-worth fact. Foreign transaction book values cannot substitute for
dated FX. Ownership, valuation policy and non-overlapping position construction
remain separate steps.

## Captured source evaluation

`db/calculations/bank-balance-input.ts` connects these rules to confirmed Postgres
evidence through an authenticated membership transaction. This internal read-only
diagnostic accepts a prepared run, planned bank/cash account and economic date.
It uses the run's fixed source revision for postings, observations and reversal
lookups. Later backdated corrections cannot alter an earlier captured evaluation.

The initial backfill path reads at most 5,000 account asset postings, 1,000 batches
and 1,000 closing observations, with one extra row to detect overflow. It fails
closed when any limit, daily-grain limit or 3 MB response limit is exceeded.
It does not truncate inputs or repeatedly page through full history. Longer
histories require future checkpoint boundary reuse.

Postings are read independently of source links so linked statements cannot
multiply movements. They aggregate by date with decimal.js. Unresolved events
are counted before netting. An opening requires exactly one active reviewed
opening event at the earliest evidence date, agreement with its net ledger
contribution, and no later nonzero opening contribution. Ambiguous or unanchored
opening contributions leave the balance unknown instead of assuming zero.

Complete coverage requires a matched import-time closing reconciliation and no
linked event reversed within the captured revision/date. Correction uploads are
downgraded to partial coverage. A subsequent complete statement may link an active
replacement, but the correction upload itself cannot establish complete coverage.
Closing observations remain independent evidence, including conflicting ones.

This path has no HTTP route, writes no financial results, reads no private candidate
facts and grants no new worker privileges. It is not used for dashboard requests or
automatic workflows. The source selection is tested against real Postgres before
implementing the restricted worker equivalent.

The reserved worker path below persists initial checkpoints. Release manifests reuse unchanged account generations; valuation and ownership remain separate later modules.

## Reserved worker checkpoints

Migration `0009_bank_balance_checkpoints` adds
`ops.bank_balance_candidate` and private `reporting.bank_balance_checkpoint` rows.
The worker operates only after bank contributions finish. It inherits that candidate's
fixed date and generation, then advances through planned bank/cash accounts by UUID.
Each explicit call handles one account; unsupported longer histories fail closed.
This initial stage saves one checkpoint per account at the requested date, not a
complete series of change/month-end checkpoints or an incremental baseline.

`claimBalanceAttempt` reserves an attempt and 819,200 bytes from the shared durable
budget before reading or computing. Step numbers follow both planning and bank work;
old-stage tokens cannot execute the new stage. The 30-second lease, four attempts per
step and 100-attempt window remain in force. Owner resume resets only the bounded
window/retry counters and preserves cumulative usage. No automatic retry loop or
Inngest financial scheduling is added.

`readBalanceWorkerInput` exposes only the next account under a live, scoped token and
fresh verification. It applies the same captured evidence rules and bounds as the
member diagnostic. `evaluateBalanceSource` invokes the pure decimal modules.
`commitBalance` rereads the token-bound source and independently evaluates it with
Postgres NUMERIC and date-range coverage checks. It checks the complete result,
including evidence IDs, reasons and scope, before inserting a checkpoint and advancing
the cursor atomically. Worker-supplied financial values or metadata cannot override
source evidence. Failed commits roll back rows and progress; reserved usage persists.
Old-page retries return current progress without writing or charging again.

RLS and scoped foreign keys isolate households and generations. Worker/member roles
cannot select or mutate checkpoint facts directly, and the SQL verification helper
is private. Members can see stage/page metadata through import status. Stored monetary
columns are NUMERIC; decimal strings and evidence reasons also remain in the verified
result document. Completing this stage does not publish a report or establish ownership,
FX valuation, performance or card balances. Schema 9 reports may include a checkpoint in known INR bank net worth only when `reconciledBalance` is available.

Remaining product work includes longer-history checkpoint boundaries, valuation, ownership, cards and investments. Automatic scheduling is enabled only while a manually reviewed administrator capacity lease remains valid.

Verification includes real Postgres cases for direct-access denial, generation matching,
wrong-stage/expired tokens, source-result tampering, atomic rollback, duplicate-safe
retries, concurrent attempts, capacity pause/resume and completing more than one budget
window. The captured reviewed-opening fixture persists exactly 115 INR even after a
later backdated correction; unknown balances remain null with evidence reasons.
