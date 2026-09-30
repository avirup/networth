# Complete bank report publication

Phase 6 publishes bank results only after planning, movement contributions and balance
checkpoints all finish for one captured source revision and economic date. Migration
`0010_report_releases` raises the installation schema to 9.

`ops.report_release_account` is the complete account manifest for a release. A changed
account points to the new candidate generation; an unchanged account keeps its earlier
generation. Publication checks the current source revision under a lock, builds and validates
the complete manifest, changes the former current release to `previous`, and switches
`ops.current_report_release` in the same transaction. A stale run becomes `superseded` and
cannot replace newer evidence. Confirmed ledger history is never changed or deleted.

Authenticated overview requests call `ops.pin_current_report` and then
`reporting.bank_overview` in the same membership-scoped transaction. The DTO contains one
release ID, source revision and as-of date; exact money values remain decimal strings.
Known net worth includes only reconciled INR bank/cash checkpoints. Foreign currency and
incomplete accounts increase the explicit unknown count instead of using transaction-time
book values as dated FX. Monthly income/expense category totals exclude transfers and card
repayments by their ledger classification.

Pins last 15 minutes. The daily recovery route removes expired pins, previous releases older
than 24 hours when unpinned, and unreferenced derived runs after their retention window.
It retains the current pointer and every generation referenced by a manifest. A pinned prior
release never blocks publishing a newer one; it is retained until safe cleanup.

The Inngest handlers receive identifiers only. They execute bounded, token-fenced planning,
movement and balance steps, publish a release, and stop cleanly when a run is superseded or
its 100-attempt window pauses. Owner resume preserves lifetime usage and emits a new durable
resume event. If scheduling fails, the route restores the prior paused state.

Before enabling confirmations, inspect the actual database and provider dashboards, include
usage from other projects, stay below the documented 80% deferral threshold, and reserve
provider overhead for event receipt, function runs, publication and retries. Record only the
remaining budget available to calculation pages:

```bash
npm run workflows:prepare
npm run workflows:verify -- 10 500 150000000 60 "Checked Neon, Vercel and Inngest dashboards"
```

The positional values are remaining imports, remaining calculation attempts, remaining
storage bytes, lease minutes, and an audit reason. The command is local-administrator only,
requires the signed workflow configuration and restricted worker connection, validates schema
9 and the 400 MB database ceiling, and atomically renews import/execution leases. It does not
query providers, buy capacity or infer headroom. Re-run it only after another manual provider
review; expiry or exhausted counters pauses work while preserving the last published release.

Verification covers stale publication, exact report strings, complete and incremental
manifests, unchanged generation reuse, request pins, cleanup, household authorization and a
Playwright import-to-published-report flow at desktop and mobile widths.
