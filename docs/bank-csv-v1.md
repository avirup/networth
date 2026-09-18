# Bank CSV v1 and financial foundation

Phase 4 establishes financial storage, posting/reconciliation functions and a versioned
bank contract. It does **not** enable uploading or confirmation in the interface.
Phase 5 adds parsing, review, account/category assignment and atomic confirmation.
Card, securities, SGB and deposit templates will be separate product contracts.

## Files

The app serves these public, synthetic-only downloads:

- [Blank bank template](../public/templates/bank-v1.csv)
- [Synthetic bank transactions](../public/templates/bank-v1-example.csv)
- [Matching synthetic statement metadata](../public/templates/bank-v1-example-manifest.json)
- [Synthetic foreign-currency income](../public/templates/bank-v1-fx-example.csv)
- [Defined income and expense categories](../public/templates/categories-v1.csv)

In the repository the files are under `public/templates/`; a running app serves them
at `/templates/<filename>`. They contain no real data.
CSV uses UTF-8, the exact header below, comma separators, and standard quoted fields
when text includes a comma, quote or newline. Every parsed cell remains a string.

```csv
schema_version,row_id,transaction_ref,transaction_date,description,direction,amount,currency,event_type,category,book_amount_inr,fx_rate,related_row_id
bank-v1,R001,DEMO-001,2026-09-01,Synthetic salary,credit,85000.00,INR,income,salary,,,
```

| Column | Contract |
| --- | --- |
| `schema_version` | Always `bank-v1` |
| `row_id` | Unique within this file, 1–64 ASCII letters/digits/underscore/hyphen; a row locator, **not** a bank reference or duplicate-proof ID |
| `transaction_ref` | Bank reference when provided, otherwise blank; never invent one |
| `transaction_date` | Actual economic/posting date, `YYYY-MM-DD`; must be within reviewed coverage |
| `description` | Narration, 1–500 characters; no account numbers or unnecessary private identifiers |
| `direction` | `credit` increases bank cash; `debit` decreases it |
| `amount` | Positive settled native amount, plain decimal; no commas, symbols, exponent, NaN or Infinity |
| `currency` | Initial supported currencies: INR, USD, EUR, GBP, JPY; one native currency per file/account |
| `event_type` | Explicit reviewed economic meaning, listed below; debit/credit alone does not determine it |
| `category` | Defined category **code**, such as `grocery`, `fees`, `entertainment` or `salary`; blank means Uncategorized |
| `book_amount_inr` | Positive evidenced INR book amount, settled to paise; required for foreign currency unless an evidenced FX rate is supplied |
| `fx_rate` | Positive INR per native currency unit, at most 18 decimal places; not a guessed current market rate |
| `related_row_id` | Optional in-file related row, e.g. the original purchase for a refund; links to earlier imported events belong in review metadata |

INR book values use half-up rounding to two decimals at the posting boundary. Native
amounts must already match currency settlement precision (two decimals, or zero for
JPY); unsupported precision is rejected. Source decimal strings are retained in evidence.
If both an explicit INR amount and a rate are supplied they must agree after rounding.
No floating-point conversion participates in authoritative calculations.

## Event types and categories

| Event type | Cash direction and accounting |
| --- | --- |
| `income` | Credit cash, credit an income ledger bucket; income category or Uncategorized |
| `expense` | Debit cash, debit expense; expense category or Uncategorized |
| `expense_refund` | Credit cash, reverse expense; normally use the original expense category |
| `income_reversal` | Debit cash, reverse income; income category or Uncategorized |
| `transfer` | Either direction; two asset/transfer-clearing legs, no income/expense category |
| `card_repayment` | Debit cash, reduce the card liability; no expense category |
| `opening_balance` | Explicitly reviewed asset/equity entry; incomplete-history quality flag; no category |
| `unresolved_reconciliation` | Explicitly reviewed asset/equity adjustment with explanation and unresolved quality; no automatic balancing |

The `direction` column describes the **bank movement**, not the ledger debit/credit
sign convention. In the ledger, asset/expense debits are positive and income/liability/
equity credits negative. Each confirmed event has at least two legs and an exact zero
sum of INR book values.

Categories are seeded separately for every household. Grocery, Fees & charges and
Entertainment are included, along with the other codes in `categories-v1.csv`. Unknown
codes and income/expense kind mismatches are errors; an explicit blank remains
Uncategorized. Account/category management and bulk assignment arrive in Phase 5.
Automatic categorization rules are not implemented yet. Existing confirmed category
references cannot be overwritten: reclassification uses sourced reversal/replacement.
Cosmetic category names may change; category code and income/expense kind cannot.

Bank v1 handles simple economic events. It does not infer investment purchases/sales,
loan principal/interest splits, gross interest/TDS, corporate actions or acquisition
costs from a net bank movement. Such rows need explicit supporting product detail in
later contracts; do not label the principal or an ambiguous net amount as ordinary
income/expense merely to make the file pass.

## Account and statement metadata

The review envelope supplies the selected account UUID, native currency, coverage start
and end, `complete`/`partial`/`balance_only` declaration, nullable opening/closing balances,
`openingKnown` and a reason when history is unknown. The example manifest illustrates
this; users will select these in the Phase 5 interface, not copy real account numbers
into CSVs. Dates use the household's India reporting context; balances are at the start
and end of the declared coverage respectively.

Opening/closing balances are **observations**. They never create additional assets.
A reviewed opening-equity event is needed only if explicitly establishing a ledger
opening position. A known opening balance does not prove earlier cash flows, acquisition
cost, or historical returns. Reconciliation remains unknown when opening evidence,
closing evidence or complete coverage is missing. A mismatch is shown with its exact
difference and never converted silently into income or spending.

`balance_only` has no transaction rows; its observations become retained source evidence
in confirmation. Database batch `row_count` counts all retained evidence rows (including
statement observations), not just transaction CSV rows. The overall confirmation limit
is 5,000 source rows and 3,000,000 encoded bytes, including review metadata. Phase 5 must
check the final serialized request, not just the CSV portion.

## Transfer and FX handling

Review resolves destination/clearing ledger accounts separately from category codes.
The opposite statement side links its new source row to the existing event or clears
a reviewed transfer-clearing account. A matching date/amount/description is only a
candidate: identical legitimate transactions must not be silently removed.

A new request ID plus matching file fingerprint requires duplicate review. Only the
same idempotency key, account and canonical content hash is an exact retry. Reusing a
key for changed content is a conflict. Source references and row hashes remain available
without a uniqueness constraint that would discard legitimate identical movements.

The pure FX conversion helper requires known source carrying value, gross INR proceeds
and explicit fees. It emits separate cash, realized FX P&L and fee legs. Unknown carrying
value yields an unknown result. Complex conversions use a reviewed `fx_conversion`
ledger event; they are not automatically inferred from a single `bank-v1` row.

## Database guarantees and operational boundaries

Migration 0002 adds shared dimensions, cash instruments/holdings, effective ownership,
reporting scopes, source evidence, ledger, observations/reconciliation and durable work
intent. Migration 0003 installs RLS, scoped keys, append-only guards and deferred checks.
`NUMERIC` values use explicit range/scale checks matching `(38,12)` money and `(38,18)`
fractions. Unconstrained NUMERIC plus checks deliberately rejects excess input scale;
a typmod alone would round before a CHECK could detect precision loss.

Draft events exist only within the confirmation transaction. At commit every event must
be confirmed, sourced and balanced. Evidence, revision, outbox and affected-account
rebuild intent must commit together. Later inserts cannot extend an old batch or modify
confirmed postings. Reversals must negate the original ledger/category/counterparty
legs exactly; replacements require a traceable reversal. Reconciliation records are
append-only at an input revision and do not contribute to asset totals.

Ownership allocations are versioned, append-only half-open intervals `[from,to)`.
Each allocation includes all represented owners and totals exactly one. Holding-specific
allocations override account allocations; never multiply both. Current Phase 4 rejects
editing or overlapping an existing interval; audited ownership correction/closing of
open-ended intervals will need an explicit later workflow before ownership editing is
exposed. Reporting scope inclusion selects owners/accounts/holdings without adding a
holding twice when its parent account is also selected.

Financial operations use the existing verified member transaction boundary. Viewers
cannot write; editors/owners can insert supported reviewed records. No worker grants,
public write APIs, dispatcher or report releases are enabled by this phase.

## Upgrading an existing local installation

Your account and financial history are preserved. Back up any real database before an
upgrade. With the private `DATABASE_ADMIN_URL` available locally, run:

```sh
npm run db:migrate
```

The migration seeds category definitions and a zero source revision for existing
households, then advances the schema to version 2. Fresh setup runs the same migrations.
Identity access remains compatible with version 1 so you can sign in before migration;
financial readiness requires version 2. Nothing migrates automatically at startup.

## Guidance for external CSV conversion

When using an external tool such as ChatGPT, provide this contract and request:

> Convert only the supplied statement's bank transactions into bank-v1 CSV. Preserve
> real references, dates, settled amounts and narration; leave missing references blank.
> Use row_id only as an in-file locator. Use only the defined category codes. Identify
> ambiguous event types separately for my review rather than guessing or emitting a
> misleading row. Do not invent FX rates, purchase costs, transfers, historical flows,
> opening balances or missing statement dates. Return statement coverage and opening/
> closing evidence separately. Flag partial coverage and unknown history explicitly.

Inspect that output against your original statement before confirmation. This application
has no hosted AI, raw-statement parser, bank connection or automatic import approval.
