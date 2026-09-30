# Live bank reports

Migration `0011_live_bank_reports` raises the installation schema to 10. It adds read-only,
authenticated reporting functions; authoritative evidence and the Phase 6 calculation and
publication workflow are unchanged.

Every dashboard request derives the household from the active membership and uses the sole
supported `household` reporting scope. `ops.pin_report_context` selects a published release,
renews its 15-minute retention pin, and falls back to the current release when a requested
release has already expired. The response marks that fallback so the interface can tell the
user that every panel was reloaded together. The release supplies the source revision and
as-of date; clients cannot widen either boundary.

`reporting.bank_dashboard` aggregates accounts, categories, twelve monthly income/expense
points, event-grouped largest expense, data coverage, processing freshness and a reconciled
cash-flow summary. Each fact family is aggregated before it enters the JSON document, which
prevents posting/source joins from multiplying money. Exact money remains a decimal string.
Point-in-time account balances are shown only at their effective date and are never summed
over the trend months.

The monthly cash boundary is all bank/cash accounts in the release manifest. Its equation is:

```text
net cash movement
= recognized income
- recognized expense
- card/debt principal
+ other funding (or - other outflow / cash drawdown)
```

Internal transfers cancel when both accounts are in the boundary. Opening equity and
unresolved reconciliation movements are excluded. Investment allocation remains explicitly
unknown because the bank template cannot establish custody or portfolio boundaries; the
remainder is never relabelled as investment spending. This preserves a reconciled result for
borrowing, external transfers, cash drawdown and overspending without inventing Sankey bands.

`reporting.bank_activity` returns economic events rather than posting rows, then attaches
bounded source and import provenance. `/api/reports/activity` defaults to 25 events and caps
pages at 1,000; opaque keyset cursors use `(effective_date,event_id)`. Both dashboard and
activity responses enforce the 3,000,000-byte response limit. The client keeps only a
component-local cache whose key contains household, scope, release, as-of date, month and
resource. API reads remain `no-store` so private reports do not enter a shared server cache.

The Overview, Accounts and Activity screens use these contracts. They cover loading, no
release, empty period, incomplete evidence, newer-source/stale, paused processing, report
failure and expired-release recovery. Cards and investments remain unavailable until their
product-specific accounting phases.
