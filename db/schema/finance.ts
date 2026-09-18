import { sql } from "drizzle-orm";
import { pgSchema, uuid, text, timestamp, integer, numeric, date, jsonb, boolean, unique, check, foreignKey, index } from "drizzle-orm/pg-core";
import { core, households } from "./index";
export const ops = pgSchema("ops");
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const amount = (name: string) => numeric(name);
const base = () => ({ id: uuid().defaultRandom().primaryKey(), householdId: uuid("household_id").notNull().references(() => households.id) });
export const currencies = core.table("dim_currency", { code: text().primaryKey(), settlementDigits: integer("settlement_digits").notNull() }, t => [check("currency_code", sql`${t.code} ~ '^[A-Z]{3}$' and ${t.settlementDigits} between 0 and 12`)]);
export const dates = core.table("dim_date", { day: date().primaryKey(), year: integer().notNull(), month: integer().notNull(), financialYear: integer("financial_year").notNull(), financialQuarter: integer("financial_quarter").notNull() });
export const owners = core.table("dim_owner", { ...base(),
name: text().notNull(), entityType: text("entity_type").notNull().default("individual"),
}, t => [
unique("dim_owner_scope").on(t.householdId, t.id),
check("dim_owner_0", sql`length(${t.name}) between 1 and 100`),
check("dim_owner_1", sql`${t.entityType} in ('individual','entity')`)
]);
export const institutions = core.table("dim_institution", { ...base(),
name: text().notNull(), kind: text().notNull().default("bank"),
}, t => [
unique("dim_institution_scope").on(t.householdId, t.id),
check("dim_institution_0", sql`length(${t.name}) between 1 and 100`)
]);
export const accounts = core.table("dim_account", { ...base(),
institutionId: uuid("institution_id"), name: text().notNull(), kind: text().notNull().default("bank"), currency: text().notNull().references(() => currencies.code), maskedReference: text("masked_reference"), openedOn: date("opened_on"), closedOn: date("closed_on"),
}, t => [
unique("dim_account_scope").on(t.householdId, t.id),
foreignKey({ columns: [t.householdId, t.institutionId], foreignColumns: [institutions.householdId, institutions.id] }),
check("dim_account_0", sql`length(${t.name}) between 1 and 100`),
check("dim_account_1", sql`${t.maskedReference} is null or ${t.maskedReference} ~ '^[*]{4}[A-Za-z0-9]{0,4}$'`),
check("dim_account_2", sql`${t.kind} in ('bank','cash','credit_card','custody')`),
check("dim_account_3", sql`${t.closedOn} is null or ${t.openedOn} is null or ${t.closedOn} >= ${t.openedOn}`)
]);
export const instruments = core.table("dim_instrument", { ...base(),
name: text().notNull(), productType: text("product_type").notNull().default("cash"), currency: text().notNull().references(() => currencies.code),
}, t => [
unique("dim_instrument_scope").on(t.householdId, t.id),
check("dim_instrument_0", sql`${t.productType} = 'cash'`),
check("dim_instrument_1", sql`length(${t.name}) between 1 and 100`),
unique("cash_currency").on(t.householdId, t.currency)
]);
export const holdings = core.table("holding", { ...base(),
accountId: uuid("account_id").notNull(), instrumentId: uuid("instrument_id").notNull(),
}, t => [
unique("holding_scope").on(t.householdId, t.id),
foreignKey({ columns: [t.householdId, t.accountId], foreignColumns: [accounts.householdId, accounts.id] }),
foreignKey({ columns: [t.householdId, t.instrumentId], foreignColumns: [instruments.householdId, instruments.id] }),
unique("holding_position").on(t.householdId,t.accountId,t.instrumentId)
]);
export const categories = core.table("dim_category", { ...base(),
code: text().notNull(), name: text().notNull(), kind: text().notNull(), archived: boolean().notNull().default(false),
}, t => [
unique("dim_category_scope").on(t.householdId, t.id),
check("dim_category_0", sql`${t.code} ~ '^[a-z][a-z0-9_]{0,63}$'`),
check("dim_category_1", sql`${t.kind} in ('income','expense')`),
check("dim_category_2", sql`length(${t.name}) between 1 and 100`),
unique("category_code").on(t.householdId,t.code)
]);
export const counterparties = core.table("dim_counterparty", { ...base(),
name: text().notNull(),
}, t => [
unique("dim_counterparty_scope").on(t.householdId, t.id),
check("dim_counterparty_0", sql`length(${t.name}) between 1 and 200`)
]);
export const ownershipSets = core.table("ownership_allocation", { ...base(),
accountId: uuid("account_id"), holdingId: uuid("holding_id"), validFrom: date("valid_from").notNull(), validTo: date("valid_to"), recordedAt: instant("recorded_at").notNull().defaultNow(),
}, t => [
unique("ownership_allocation_scope").on(t.householdId, t.id),
foreignKey({ columns: [t.householdId, t.accountId], foreignColumns: [accounts.householdId, accounts.id] }),
foreignKey({ columns: [t.householdId, t.holdingId], foreignColumns: [holdings.householdId, holdings.id] }),
check("ownership_allocation_0", sql`num_nonnulls(${t.accountId},${t.holdingId})=1`),
check("ownership_allocation_1", sql`${t.validTo} is null or ${t.validTo}>${t.validFrom}`)
]);
export const ownershipInterests = core.table("ownership_interest", { ...base(),
allocationId: uuid("allocation_id").notNull(), ownerId: uuid("owner_id").notNull(), fraction: numeric().notNull(),
}, t => [
unique("ownership_interest_scope").on(t.householdId, t.id),
foreignKey({ columns: [t.householdId, t.allocationId], foreignColumns: [ownershipSets.householdId, ownershipSets.id] }),
foreignKey({ columns: [t.householdId, t.ownerId], foreignColumns: [owners.householdId, owners.id] }),
check("ownership_interest_0", sql`${t.fraction} >= 0 and ${t.fraction} <= 1`),
unique("allocation_owner").on(t.householdId,t.allocationId,t.ownerId)
]);
export const reportingScopes = core.table("reporting_scope", { ...base(),
name: text().notNull(), version: integer().notNull().default(1),
}, t => [
unique("reporting_scope_scope").on(t.householdId, t.id),
check("reporting_scope_0", sql`${t.version}>0`),
check("reporting_scope_1", sql`length(${t.name}) between 1 and 100`)
]);
export const scopeMembers = core.table("scope_member", { ...base(),
scopeId: uuid("scope_id").notNull(), ownerId: uuid("owner_id"), accountId: uuid("account_id"), holdingId: uuid("holding_id"), validFrom: date("valid_from").notNull(), validTo: date("valid_to"),
}, t => [
unique("scope_member_scope").on(t.householdId, t.id),
foreignKey({ columns: [t.householdId, t.scopeId], foreignColumns: [reportingScopes.householdId, reportingScopes.id] }),
foreignKey({ columns: [t.householdId, t.ownerId], foreignColumns: [owners.householdId, owners.id] }),
foreignKey({ columns: [t.householdId, t.accountId], foreignColumns: [accounts.householdId, accounts.id] }),
foreignKey({ columns: [t.householdId, t.holdingId], foreignColumns: [holdings.householdId, holdings.id] }),
check("scope_member_0", sql`num_nonnulls(${t.ownerId},${t.accountId},${t.holdingId})=1`),
check("scope_member_1", sql`${t.validTo} is null or ${t.validTo}>${t.validFrom}`)
]);
export const batches = core.table("import_batch", { ...base(),
accountId: uuid("account_id").notNull(), schemaVersion: text("schema_version").notNull(), idempotencyKey: uuid("idempotency_key").notNull(), contentHash: text("content_hash").notNull(), coverageStart: date("coverage_start").notNull(), coverageEnd: date("coverage_end").notNull(), completeness: text().notNull(), rowCount: integer("row_count").notNull(), requestBytes: integer("request_bytes").notNull(), revision: integer().notNull(), reviewedBy: uuid("reviewed_by").notNull(), confirmedAt: instant("confirmed_at").notNull().defaultNow(),
}, t => [
unique("import_batch_scope").on(t.householdId, t.id),
foreignKey({ columns: [t.householdId, t.accountId], foreignColumns: [accounts.householdId, accounts.id] }),
check("import_batch_0", sql`${t.schemaVersion}='bank-v1'`),
check("import_batch_1", sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
check("import_batch_2", sql`${t.coverageStart}<=${t.coverageEnd}`),
check("import_batch_3", sql`${t.completeness} in ('complete','partial','balance_only')`),
check("import_batch_4", sql`${t.rowCount} between 1 and 5000 and ${t.requestBytes} between 1 and 3000000 and ${t.revision}>0`),
unique("batch_retry").on(t.householdId,t.idempotencyKey),
unique("batch_revision").on(t.householdId,t.revision)
]);
export const sourceRecords = core.table("source_record", { ...base(),
batchId: uuid("batch_id").notNull(), rowNumber: integer("row_number").notNull(), providerReference: text("provider_reference"), rowHash: text("row_hash").notNull(), payload: jsonb().$type<Record<string, string>>().notNull(),
}, t => [
unique("source_record_scope").on(t.householdId, t.id),
foreignKey({ columns: [t.householdId, t.batchId], foreignColumns: [batches.householdId, batches.id] }),
check("source_record_0", sql`${t.rowNumber} between 1 and 5000`),
check("source_record_1", sql`${t.rowHash} ~ '^[0-9a-f]{64}$'`),
check("source_record_2", sql`octet_length(${t.payload}::text)<=16000`),
unique("source_row").on(t.householdId,t.batchId,t.rowNumber),
index("source_fingerprint").on(t.householdId,t.rowHash)
]);
export const events = core.table("transaction_event", { ...base(),
batchId: uuid("batch_id").notNull(), kind: text().notNull(), effectiveDate: date("effective_date").notNull(), state: text().notNull().default("pending"), quality: text().notNull().default("complete"), reviewNote: text("review_note"), reversesId: uuid("reverses_id"), replacesId: uuid("replaces_id"), recordedAt: instant("recorded_at").notNull().defaultNow(),
}, t => [
unique("transaction_event_scope").on(t.householdId, t.id),
foreignKey({ columns: [t.householdId, t.batchId], foreignColumns: [batches.householdId, batches.id] }),
check("transaction_event_0", sql`${t.kind} in ('income','expense','expense_refund','income_reversal','transfer','card_repayment','opening_balance','unresolved_reconciliation','fx_conversion','reversal')`),
check("transaction_event_1", sql`${t.state} in ('pending','confirmed')`),
check("transaction_event_2", sql`${t.quality} in ('complete','opening_history_unknown','unresolved')`),
check("transaction_event_3", sql`${t.kind} not in ('opening_balance','unresolved_reconciliation') or (length(btrim(${t.reviewNote}))>0 and ${t.quality}<>'complete')`),
unique("single_reversal").on(t.householdId,t.reversesId)
]);
export const sourceLinks = core.table("event_source_link", { ...base(),
eventId: uuid("event_id").notNull(), sourceId: uuid("source_id").notNull(),
}, t => [
unique("event_source_link_scope").on(t.householdId, t.id),
foreignKey({ columns: [t.householdId, t.eventId], foreignColumns: [events.householdId, events.id] }),
foreignKey({ columns: [t.householdId, t.sourceId], foreignColumns: [sourceRecords.householdId, sourceRecords.id] }),
unique("source_event").on(t.householdId,t.eventId,t.sourceId)
]);
export const ledgerAccounts = core.table("ledger_account", { ...base(),
accountId: uuid("account_id"), holdingId: uuid("holding_id"), code: text().notNull(), kind: text().notNull(), currency: text().notNull().references(() => currencies.code),
}, t => [
unique("ledger_account_scope").on(t.householdId, t.id),
foreignKey({ columns: [t.householdId, t.accountId], foreignColumns: [accounts.householdId, accounts.id] }),
foreignKey({ columns: [t.householdId, t.holdingId], foreignColumns: [holdings.householdId, holdings.id] }),
check("ledger_account_0", sql`${t.kind} in ('asset','liability','equity','income','expense')`),
check("ledger_account_1", sql`length(${t.code}) between 1 and 100`),
unique("ledger_code").on(t.householdId,t.code)
]);
export const postings = core.table("fact_posting", { ...base(),
eventId: uuid("event_id").notNull(), lineNumber: integer("line_number").notNull(), ledgerAccountId: uuid("ledger_account_id").notNull(), nativeAmount: numeric("native_amount").notNull(), currency: text().notNull().references(() => currencies.code), bookAmountInr: numeric("book_amount_inr").notNull(), categoryId: uuid("category_id"), counterpartyId: uuid("counterparty_id"),
}, t => [
unique("fact_posting_scope").on(t.householdId, t.id),
foreignKey({ columns: [t.householdId, t.eventId], foreignColumns: [events.householdId, events.id] }),
foreignKey({ columns: [t.householdId, t.ledgerAccountId], foreignColumns: [ledgerAccounts.householdId, ledgerAccounts.id] }),
foreignKey({ columns: [t.householdId, t.categoryId], foreignColumns: [categories.householdId, categories.id] }),
foreignKey({ columns: [t.householdId, t.counterpartyId], foreignColumns: [counterparties.householdId, counterparties.id] }),
check("fact_posting_0", sql`${t.lineNumber}>0`),
check("fact_posting_1", sql`abs(${t.nativeAmount})<1e26 and scale(${t.nativeAmount})<=12`),
check("fact_posting_2", sql`abs(${t.bookAmountInr})<1e26 and scale(${t.bookAmountInr})<=12`),
unique("posting_line").on(t.householdId,t.eventId,t.lineNumber)
]);
export const observations = core.table("fact_statement_observation", { ...base(),
sourceId: uuid("source_id").notNull(), accountId: uuid("account_id").notNull(), asOf: date("as_of").notNull(), kind: text().notNull(), balance: amount("balance"), unknownReason: text("unknown_reason"), currency: text().notNull().references(() => currencies.code),
}, t => [
unique("fact_statement_observation_scope").on(t.householdId, t.id),
foreignKey({ columns: [t.householdId, t.sourceId], foreignColumns: [sourceRecords.householdId, sourceRecords.id] }),
foreignKey({ columns: [t.householdId, t.accountId], foreignColumns: [accounts.householdId, accounts.id] }),
check("fact_statement_observation_0", sql`${t.kind} in ('opening','closing')`),
check("fact_statement_observation_1", sql`(${t.balance} is null and length(btrim(${t.unknownReason}))>0) or (${t.balance} is not null and ${t.unknownReason} is null)`),
check("fact_statement_observation_2", sql`${t.balance} is null or abs(${t.balance})<1e26`)
]);
export const reconciliations = core.table("reconciliation_result", { ...base(),
observationId: uuid("observation_id").notNull(), revision: integer().notNull(), status: text().notNull(), calculatedBalance: amount("calculated_balance"), difference: amount("difference"), explanation: text(), resolutionEventId: uuid("resolution_event_id"),
}, t => [
unique("reconciliation_result_scope").on(t.householdId, t.id),
foreignKey({ columns: [t.householdId, t.observationId], foreignColumns: [observations.householdId, observations.id] }),
foreignKey({ columns: [t.householdId, t.resolutionEventId], foreignColumns: [events.householdId, events.id] }),
check("reconciliation_result_0", sql`${t.revision}>0`),
check("reconciliation_result_1", sql`(${t.status}='unknown' and ${t.calculatedBalance} is null and ${t.difference} is null and length(btrim(${t.explanation}))>0) or (${t.status}='matched' and ${t.calculatedBalance} is not null and ${t.difference}=0) or (${t.status}='mismatch' and ${t.calculatedBalance} is not null and ${t.difference}<>0 and length(btrim(${t.explanation}))>0)`)
]);
export const revisions = ops.table("source_revision", { householdId: uuid("household_id").primaryKey().references(() => households.id), revision: integer().notNull().default(0) }, t => [check("revision_nonnegative", sql`${t.revision}>=0`)]);
export const outbox = ops.table("outbox_event", { ...base(),
batchId: uuid("batch_id").notNull(), revision: integer().notNull(), state: text().notNull().default("pending"), createdAt: instant("created_at").notNull().defaultNow(),
}, t => [
unique("outbox_event_scope").on(t.householdId, t.id),
foreignKey({ columns: [t.householdId, t.batchId], foreignColumns: [batches.householdId, batches.id] }),
check("outbox_event_0", sql`${t.revision}>0`),
check("outbox_event_1", sql`${t.state} in ('pending','dispatched')`),
unique("outbox_batch").on(t.householdId,t.batchId)
]);
export const rebuilds = ops.table("rebuild_request", { ...base(),
batchId: uuid("batch_id").notNull(), accountId: uuid("account_id").notNull(), earliestDate: date("earliest_date").notNull(), revision: integer().notNull(), cause: text().notNull().default("bank_import"),
}, t => [
unique("rebuild_request_scope").on(t.householdId, t.id),
foreignKey({ columns: [t.householdId, t.batchId], foreignColumns: [batches.householdId, batches.id] }),
foreignKey({ columns: [t.householdId, t.accountId], foreignColumns: [accounts.householdId, accounts.id] }),
check("rebuild_request_0", sql`${t.revision}>0`),
unique("rebuild_batch_account").on(t.householdId,t.batchId,t.accountId)
]);
