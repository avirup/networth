# Calculation planning — Phase 6 foundation

Migration `0006_calculation_planning` introduces a durable initial candidate and its
account rebuild ranges. Migration `0007_planning_execution` adds durable execution
reservations. Migrations `0008_bank_candidates` and `0009_bank_balance_checkpoints` add private
contribution/balance persistence and advance installation schema to 8 without changing financial history.
Identity access remains compatible with versions 1–8.

The internal worker primitives in `db/workflows/planning.ts`:

1. `beginCalculationPlan(intent)` requires an exact, received outbox intent. It locks the
   same household revision row used by imports, captures the current revision and records
   the retained planning rule identifier `bank-plan-v1`. Concurrent starts return the same
   candidate. Repeated calls never advance its input revision, even for a newer import.
2. `advanceCalculationPlan({ runId, householdId, page })` first commits a durable attempt reservation, then locks the candidate and processes
   at most 100 rebuild requests in revision/UUID order. A supporting index bounds the read.
   It combines requests by account using the earliest affected date, including across pages.
   It commits account ranges and the next checkpoint in the same transaction.
3. Retrying an already committed page returns current progress without processing another
   page. An in-flight claim returns a conflict; a future page number or mismatched household
   is rejected. A failed work transaction leaves account ranges and checkpoint unchanged,
   while preserving the previously committed attempt charge.
4. Exhausting captured requests changes the state to `prepared`. This means that account
   ranges are ready for calculation; it does not mean that balances or reports exist.

Later imports, including earlier economic dates, have higher revisions and remain outside
this candidate. Rebuild requests are append-only, and the new database guard requires each
request's revision to match its batch. Migration checks existing rows and fails for manual
administrator review if an inconsistent revision exists; it does not rewrite evidence.

New planning work requires fresh trusted import and execution admission leases, one
execution credit and a conservative 819,200-byte page reservation. Projected physical
database storage must remain below the existing ceiling. Idempotent reads of an existing candidate/checkpoint remain
available during a pause. Worker access uses only the two restricted SQL functions, with
no direct identity, ledger or planning-table access. Household members can read their own
planning rows through RLS; they cannot mutate them or invoke the worker functions.

## Current boundary

These are tested internal preparation primitives, **not yet invoked by the Inngest receipt
handler or an HTTP endpoint**. Planning pages now have durable attempt admission and bounded windows. Automatic execution
still needs full Inngest run/replay/step accounting and provider usage verification; a
planning attempt count is not a complete provider usage counter.

This implements the initial candidate only, starting from revision zero. The next release
lifecycle work must allow retained audit runs, select the published baseline, reuse unchanged
partitions and retain newer requests for a subsequent candidate. Do not delete source
requests or overwrite a candidate to incorporate a later revision.

An internal [bank input reader and calculation rule](bank-calculations.md) now produce
revision-scoped ledger contributions through authenticated member transactions. The future
financial worker still needs a restricted input path, persisted candidate facts and retained
versions for report-affecting dimensions. Unknown ownership, opening history and FX remain unknown.
Calculation/rule versions must be recorded separately from this planning rule version.

No balances, summaries, complete releases, request pins or cleanup are implemented here.
Real import admission remains paused until workflow/provider verification and the complete
calculation/publication pipeline exist. No extra service or dependency was introduced.

## Verification

Postgres tests use scoped synthetic imports with more than 100 rebuild requests and compare
the completed plan with an independent grouped query at its captured revision. They cover
concurrent starts/pages, invalid receipts/checkpoints, late backdated imports, revision
guards, expired capacity, atomic rollback, resumption and household/worker permissions.

See [planning execution controls](planning-execution.md) for leases, retry limits, shared
capacity reservations, owner resume and verification coverage.
