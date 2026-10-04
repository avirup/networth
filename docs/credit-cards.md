# Credit cards and liabilities

Phase 9 is implemented. The Imports workspace accepts card-v1 separately from bank-v1,
performs local parsing and server review, and saves nothing before explicit confirmation.
Confirmed evidence, balanced postings, reconciliation, facility terms, due metadata,
outbox intent and affected ranges commit atomically.

## Card transaction file

Use [card-v1.csv](../public/templates/card-v1.csv) and the
[synthetic example](../public/templates/card-v1-example.csv). Statement metadata is
illustrated by [the example manifest](../public/templates/card-v1-example-manifest.json).

The exact CSV header is:

```csv
schema_version,row_id,transaction_ref,transaction_date,description,direction,amount,currency,event_type,category,related_row_id
```

Each file represents one card account and one reviewed coverage period. The first
contract supports INR-billed statements. A foreign merchant purchase can use its
evidenced INR billed amount; a foreign-currency card account is not supported by this
contract. Amounts are positive plain decimal strings settled to paise. Never infer
an INR billed amount from an unsupported exchange rate.

| Event type | Direction | Accounting | Category |
| --- | --- | --- | --- |
| card_purchase | debit | Expense debit, liability credit | Expense category or blank |
| card_refund | credit | Liability debit, expense credit | Original expense category or explicitly unknown |
| card_interest | debit | Expense debit, liability credit | Expense category such as fees |
| card_fee | debit | Expense debit, liability credit | Expense category such as fees |
| card_repayment | credit | Liability debit, bank asset credit | Must be blank |

A card debit increases debt. This differs from bank cash direction. Refunds reduce
expenses; they are not income. Repayments are not another expense. The card and bank
representations of the same repayment produce the same ledger legs and must be linked
to one economic event during import review. The pure posting function does not resolve
duplicates or authorize records.

Rows have unique row IDs, dates inside the reviewed coverage period, descriptions and
optional statement references. A related row ID is an evidence hint within the file;
it does not automatically deduplicate or book another transaction. Earlier imported
events will require explicit reviewed links in the confirmation workflow. Blank expense
categories mean Uncategorized; no category is inferred from merchant text.

Maximum input is 3,000,000 bytes and 4,998 transaction rows, reserving two source rows for
opening and closing observations. Unsupported transaction types, malformed CSV headers,
invalid dates, scientific notation and excess decimal scale are rejected.

## Statement evidence and reconciliation

The manifest records coverage dates and completeness, opening and statement outstanding,
payment due date and minimum due. Missing figures remain null. An unknown opening must
include a reason. Due dates cannot precede the statement date; minimum due cannot be
negative or exceed a known positive statement outstanding.

Outstanding uses positive numbers for debt and negative numbers for an overpayment.
Statement reconciliation computes opening outstanding plus card debits minus card
credits. It compares that value with statement outstanding only with a known opening,
known closing and complete coverage. Partial history stays unknown, and mismatches
remain mismatches; no balancing expense is invented.

A reviewed opening can produce a liability/equity event with unknown prior history.
Opening metadata is reconciliation evidence, not another movement to add after the
opening event. A zero opening needs no posting. Statement outstanding is not a second
liability component, and minimum due is not additional debt.

The synthetic example computes:

```text
5,000 opening + 1,200 purchase - 200 refund + 50 interest + 25 fee - 1,000 repayment
= 5,075 statement outstanding
```

This is statement-date evidence. Current outstanding requires complete, captured
transactions through the report date; the statement figure cannot silently substitute
for a newer current balance. An overdue label must likewise account for repayments
after the statement date rather than treating the original minimum as still unpaid.

## Facilities and household valuation

Facility terms and card/facility links use half-open effective intervals:
validFrom is included; validTo is excluded. Overlaps are rejected. Historical reports
select historical limits, never a future limit. The database stores append-only effective
date snapshots. A later effective date ends the preceding interval; a higher captured
source revision can supersede evidence for the same effective date. The evidence reader
filters both the report date and source revision, preserving earlier release inputs.
A null limit explicitly records an unknown limit; a null facility link explicitly
unlinks a card. Neither falls back to older evidence.

Facility terms, account links and due metadata must reference evidence created in the
same card import transaction. Scoped keys, forced RLS and insert guards reject foreign
household relationships, ambiguous terms within a batch and invalid dates/amounts.
These records cannot be updated or deleted. Backups include the new tables and restore
their source provenance. The bounded internal evidence reader does not itself publish
reports or establish that a statement balance is current.

A shared limit belongs to the facility and is counted once. Every linked card must have
a same-date position, including an explicit unknown where evidence is missing. Each
household account contributes once regardless of how many household members own it.
Owner-specific reporting is deferred to the shared ownership calculation; these
household totals do not apply ownership fractions a second time.

Facility drawn amount sums positive card debts. Credit balances are shown separately;
they do not silently offset another card's drawn balance or increase the nominal limit.
Available credit is max(limit minus drawn, zero). Utilization can exceed 100%; over-limit
amount is reported separately. This is an application calculation, not an issuer's
authorization promise: holds, issuer-specific pooled credits and unposted transactions
are not inferred.

Missing or zero limits produce unavailable utilization. An unknown linked balance makes
facility drawn, utilization and available credit unknown. Unlinked cards remain included
in household debt/credit totals but cannot have facility utilization assigned.

Household known net-worth contribution is known card credit balances minus known debt.
Unknown account counts accompany partial totals. Credit limits and unused credit never
become assets.

## Implementation and verification

- lib/imports/card-v1.ts: bounded CSV parsing and row/statement validation.
- lib/imports/card-review.ts: explicit opening consent, repayment account selection,
  correction/link validation and review warnings.
- db/imports/card-service.ts: authorized review and atomic confirmation.
- db/cards/evidence.ts: household-scoped historical evidence reads.
- db/migrations/0013_card_evidence.sql and 0014_card_import_reports.sql: evidence tables,
  RLS, transaction guards and same-release reporting.
- lib/finance/card-posting.ts: balanced card events, reviewed openings and reconciliation.
- lib/finance/card-facility.ts: dated shared limits and non-overlapping household totals.
- tests/unit/card-contract.test.ts: known-answer fixtures for transactions, repayment
  symmetry, reconciliation, decimal precision, historical/shared/unknown limits and
  overpayments.

Database integration tests cover immutable evidence, invalid limits and due metadata,
household isolation, atomic card accounting, historical revisions, same-release liability
reports and encrypted backup/restore. Unit tests cover review decisions, posting rules,
reconciliation, shared limits, over-limit, zero-limit and unknown cases. The Liabilities
screen distinguishes current outstanding, statement outstanding, minimum due, available
credit and utilization; dashboard net worth subtracts known card debt once.
