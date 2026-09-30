# Reviewed bank imports (Phase 5)

Open **Imports** after signing in as an owner or editor. Viewers can read batch status.

1. Download the bank-v1 template. Convert statements externally; this app does not
   parse original bank PDFs, connect banks, or call hosted AI.
2. Choose an existing bank account or name a new one. Only masked references are
   accepted. A new account is created in the same transaction as confirmation.
3. Choose a CSV. Parsing runs locally with PapaParse, retaining cells as strings.
   Invalid headers, malformed rows and oversized files are rejected. Review coverage,
   completeness, currency and opening/closing statement evidence separately.
4. Assign defined income/expense categories per row or to selected rows in bulk.
   Transfers, card principal and equity adjustments never receive spending categories.
5. Check the statement. This sends an authenticated, bounded review request but saves
   nothing. Review warnings, overlapping coverage and possible duplicates. Any edit
   invalidates the review and its acknowledgements.
6. Acknowledge every warning and explicitly confirm the whole batch. Cancel discards
   the browser preview. Refresh status manually after confirmation; there is no polling.

## Confirmation admission and provider verification

The verifier-owned `ops.import_admission` lease starts absent. Member, auth and worker roles cannot write it, and there is no HTTP or UI override. Phase 6 supplies the complete signed workflow and the local-administrator `npm run workflows:verify` command. The administrator must first inspect actual provider dashboards and shared-account usage, then record only safe remaining headroom below the 80% deferral threshold. Missing, expired or insufficient capacity fails closed.

The batch-insert trigger reserves a permit and conservative storage headroom atomically:
16 × request bytes + 8,192 × evidence rows, with a 400,000,000-byte database hard ceiling.
Lease renewal must account for outstanding reservations and candidate-report growth;
never simply reset consumed capacity. A failed transaction restores its reservation.
Exact retries return their existing batch before readiness/revision checks and consume
no additional permit. No paid upgrades or hosted payload staging are introduced.

## Limits and evidence

- At most 5,000 retained evidence rows: **4,998 CSV transactions + two opening/closing
  observations**, including unknown observations. Balance-only imports use two rows.
- At most **3,000,000 actual UTF-8 bytes** for the entire confirmation, including
  account metadata, review decisions and acknowledgements. The browser checks the
  serialized body; the server streams and bounds the actual request before parsing.
- Split larger history into independently reviewed files. Each confirmed file is atomic;
  no partial-save behavior or silently truncated rows.
- Review renders 50 transactions per page. Existing events and observations use
  100-record pages; recent batch status is limited to 100. At most 1,000 accounts and
  1,000 duplicate candidates are returned; narrow the input if candidate review is larger.

Original parsed CSV cells and review choices are stored in source evidence. Money stays
in decimal strings and NUMERIC. Normalized values construct postings; raw amounts are
not converted to JavaScript numbers. Statement balances never become asset postings.
An explicit `opening_balance` row creates ledger equity, must agree with known opening
statement evidence at the coverage start, and is excluded from statement-period cash
movements to avoid counting that opening twice. No ownership or earlier history is guessed.

## Duplicates, transfers and corrections

Date/description/amount fingerprints and provider references suggest matches; they do
not prove identity. Keep a legitimate repeated transaction as a separate event with an
explanation, or link evidence to an existing event. Linking requires agreement on the
account, currency, signed native/book amounts, date, event kind and category. It adds
source evidence without adding postings. Opposite sides of a transfer can link to one
existing event after review, so the transfer is not counted twice.

For new INR transfers, select the other existing bank account. A balance-only confirmed
batch can establish that account without inventing an opening asset. Card repayments
require an already configured INR card liability account; card onboarding/imports belong
to their later product phase. Cross-currency transfers are rejected until the dedicated
FX workflow can retain source carrying-value evidence. Ordinary foreign-currency income
and expenses require the bank-v1 explicit INR book value/FX evidence.

Load existing account events to obtain IDs. A replacement requires the original event
ID, a reason and coverage containing the original date. Confirmation appends an exact
negative copy of all original postings and a replacement, both linked to source evidence.
Existing categories/history never mutate. Already reversed events cannot be linked or
replaced again. The household revision lock prevents concurrent stale confirmations.

Closing observations show their latest reconciliation and IDs. A reviewed
`unresolved_reconciliation` row may reference a mismatched closing observation. Its
account, date and signed amount must match the latest evidenced difference. The new
reconciliation links to that equity event; the original mismatch and evidence remain.
A matched numeric balance does not establish missing history or turn the adjustment
into income. Unknown observations cannot be resolved by inventing a difference.

## Upgrade and verification

Run `npm run db:migrate` with the private admin connection available locally, then restart
Next.js. The additive migrations advance the schema to version 9, preserving users and earlier financial records. Application startup never runs migrations. Identity access supports schemas 1–9; financial imports require 9. The user's real database is not modified by automated tests.

`npm run check` covers lint, types, unit contracts and build. `npm run test:integration`
uses only guarded loopback `networth_test`, including full 5,000-row commits, retries,
concurrency, transfer links, replacements, reconciliation resolution and rollback. Auth
Playwright tests run the browser review/category/confirm flow and inspect stored evidence
using a synthetic verifier lease. They also verify cancellation, oversize rejection and
viewer denial. The authenticated suite also verifies import through a pinned published overview at desktop and mobile widths.

Parser reference: [PapaParse documentation](https://www.papaparse.com/docs).
