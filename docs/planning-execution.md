# Durable planning execution controls

Phase 6 planning pages now reserve usage before work. Migration
`0007_planning_execution` adds an installation-wide verifier-owned execution lease and
household-scoped calculation budgets. Existing candidates receive a budget atomically;
new candidates get one in their creation transaction. Migrations `0008`–`0010` extend this shared budget through bank movements, balances and publication; current schema is 9.

## Attempt lifecycle

`advanceCalculationPlan` commits a claim before entering the work transaction. Each claim
reserves one execution credit and 819,200 bytes (100 requests × 8,192 bytes) of conservative
planning growth. It increments both the current-window and lifetime counters and acquires
a random token with a 30-second lease. All worker SQL uses the existing short transaction
and statement timeout boundary. No transaction remains open between worker calls.

The fenced completion function verifies the token and lease, checks fresh verification,
then commits account ranges, the next page and lease release together. An expired or
superseded sender cannot complete work. A crashed worker leaves its attempt charged;
expiry permits another counted claim. Normal failures release the claim but never refund
usage. If release itself fails, expiry provides recovery. Database rollback cannot erase
the earlier charge. Replaying a completed page reads its checkpoint without another charge.

A page gets one initial attempt and at most three retries per work window. A calculation
window has at most 100 planning attempts. Exhaustion pauses work; the successful 100th
attempt also pauses immediately if more pages remain. Cumulative counters use Postgres
BIGINT and are exposed as decimal strings. Capacity expiry/depletion pauses new claims.

The same verifier-owned capacity row is decremented atomically across households. Workers
and household members cannot replenish it or edit counters. The old direct unreserved
planning SQL function is no longer executable by the worker role. It is used only inside
the fenced completion function. No authoritative financial history is changed or deleted.

## Resume and status

A recently reauthenticated owner may POST `{"runId":"<UUID>"}` to
`/api/workflows/resume` using the normal authenticated same-origin boundary. The database
also checks household ownership, paused/planning state, fresh import/execution verification,
at least one execution credit and storage headroom. Resume opens a new bounded window,
clears page retry exhaustion and preserves lifetime usage. Every subsequent claim still
reserves its own available credit and storage; resume is not a quota bypass.

The response is `{"state":"ready","scheduled":false}`. It does **not** send an Inngest
event or execute a page yet. Import status exposes the covered candidate's run ID, plan
state, execution state, pause reason, window attempts and lifetime attempts. Imports after
the candidate's captured revision do not claim coverage by that older candidate.

## Remaining boundary

These counters cover reserved planning and financial page attempts, including failed work and expired claims. Provider callback/run/replay overhead and other projects sharing an account must be subtracted during the manual provider review. `npm run workflows:verify` records only the remaining safe page budget in a short administrator lease; it never infers or purchases provider capacity.

Inngest advances complete bank calculations automatically while that lease remains valid. Publication, request pins and safe cleanup are described in [report publication](report-publication.md).

## Verification

Postgres integration tests exercise pre-work charges surviving rollback/crash, live and
expired claims, stale-token fencing, three retries, window boundaries, preserved lifetime
usage on resume, missing/expired/depleted verification, exact storage bounds, worker
privilege denial and concurrent households competing for one shared credit. Browser
coverage includes password reconfirmation, same-origin enforcement, invalid input, scheduling-failure rollback and viewer denial.

An internal [bank calculation layer](bank-calculations.md) now reads revision-scoped inputs
through authenticated member transactions and produces pure ledger contributions. It is
now also available through a restricted token-bound worker path with atomic candidate
persistence. Complete candidates publish only through [report release manifests](report-publication.md).
