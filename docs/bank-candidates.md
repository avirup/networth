# Persisted bank calculation candidates

Migration `0008_bank_candidates` adds fixed-date candidate progress and compact numeric
account/category contributions. Migration `0010` publishes completed generations through release manifests; schema 10 adds live reporting over those immutable manifests. Candidate rows remain private calculation state.

## Durable worker flow

The internal `db/calculations/bank-worker.ts` functions implement:

1. Begin one candidate for a prepared run. Pin its as-of date, `bank-movements-v1` rule and
   generation UUID. Retrying returns the same generation; changing the date is rejected.
2. Claim one page using the same budget and capacity reservations as planning. Bank step
   indices follow the planning range, so bank tokens cannot execute planning steps. Initial
   attempt plus three retries, the shared 100-attempt window, expiry and storage bounds
   still apply. Claims commit before any financial computation.
3. Read at most 100 complete events through `ops.bank_page_input`. A live matching token is
   required. The SQL function reads only the candidate household, captured revision, date
   and cursor. More than two legs or an unsupported economic kind fails closed.
4. Compute contributions with decimal.js outside the database transaction. The worker has
   no direct source-table or candidate-table privileges.
5. Commit through `ops.commit_bank_page`. It locks the run, validates the token/context/rule,
   re-reads the bounded source page and independently reconciles every contribution with
   Postgres NUMERIC sums. Tampered amounts, counts, category/account grains, context or
   incomplete result sets are rejected before any candidate writes.
6. Add account/date and account/month/category contributions, advance the cursor/page and
   release the claim in one transaction. Rollback retains the earlier attempt charge but
   leaves facts and progress unchanged. A lost-response retry at an old checkpoint returns
   current progress without adding contributions or charging another attempt.

The worker never supplies an authoritative next cursor. SQL derives it from captured
source rows. Final-page completion changes the candidate to `calculated`; the later balance and publication stages still decide whether any amount is reportable.

## Storage and access

- `ops.bank_candidate`: run, household, generation, fixed as-of date and rule, page/cursor,
  event count, and building/calculated state.
- `reporting.bank_account_movement`: one run/generation × account × native currency ×
  ledger kind × effective date. Stores NUMERIC native/book/cash/opening/unresolved deltas.
- `reporting.bank_category_movement`: one run/generation × account × month × income/expense
  kind × category. Stores NUMERIC amount and posting count. Null categories form one
  uncategorized group, including across pages.

All relationships are household-scoped and all tables have FORCE RLS. Members can read
candidate progress metadata only. Neither members nor workers can directly select or
mutate candidate financial rows. The worker calls the bounded security-definer functions;
they do not accept arbitrary SQL or arbitrary source identifiers. No authoritative history
is changed or removed. Source and category/account identities remain revision-stable.

Account/category contributions are accumulated compactly; raw page payloads are not stored.
Account movements remain unallocated ledger changes. They are not statement balances,
market values, external scope cash flows, returns or an additional net-worth asset.

## Resume and publication

The existing recently reauthenticated owner resume endpoint now also permits a paused,
unfinished bank candidate. It requires fresh capacity and preserves lifetime attempts.
It schedules a durable resume event. Import status exposes bank calculation state, page and as-of date
for covered imports, without exposing partial financial rows.

Inngest now schedules all bounded stages. The local administrator issues short capacity leases only after reviewing provider meters. Completed candidates are never exposed directly; [release publication](report-publication.md) selects complete account generations. Ownership, dated FX, cards, investments and performance remain later modules.

## Verification

Postgres tests cover fixed-date generation identity, direct-access denial, stale/wrong-stage
tokens, tampered results, duplicate completion, old-page replay, rollback after writes,
quota pause/resume and concurrent attempts. A synthetic history exceeding 4,998 events is
processed through bounded pages; final account and category contributions are compared in
both directions with independent full-ledger SQL at the captured revision and as-of date.
