import { sql } from "drizzle-orm";
import { pgSchema, uuid, text, timestamp, integer, bigint, numeric, date, jsonb, boolean, unique, check, foreignKey, index, primaryKey } from "drizzle-orm/pg-core";
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
check("import_batch_0", sql`${t.schemaVersion} in ('bank-v1','card-v1')`),
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
unique("rebuild_batch_account").on(t.householdId,t.batchId,t.accountId),
index("rebuild_planning_cursor").on(t.householdId,t.revision,t.id)
]);
// Global verifier-owned lease: member sessions may read, but cannot grant capacity.
export const importAdmission = ops.table("import_admission", {
  singleton: boolean().primaryKey().default(true), verifiedUntil: instant("verified_until").notNull(),
  workflowVerified: boolean("workflow_verified").notNull().default(false),
  remainingImports: integer("remaining_imports").notNull(), remainingStorageBytes: bigint("remaining_storage_bytes", { mode: "bigint" }).notNull(), reason: text().notNull(),
}, t => [check("import_admission_singleton_check", sql`${t.singleton}`), check("import_admission_remaining_imports_check", sql`${t.remainingImports}>=0`), check("import_admission_remaining_storage_bytes_check", sql`${t.remainingStorageBytes}>=0`), check("import_admission_reason_check", sql`length(${t.reason}) between 1 and 500`)]);
export const workflowDelivery = ops.table("workflow_delivery", {
  outboxId: uuid("outbox_id").primaryKey(), householdId: uuid("household_id").notNull(),
  state: text().notNull().default("pending"), attempts: integer().notNull().default(0), totalAttempts: integer("total_attempts").notNull().default(0),
  leaseToken: uuid("lease_token"), leaseUntil: instant("lease_until"), nextAttemptAt: instant("next_attempt_at").notNull().defaultNow(),
  sentAt: instant("sent_at"), receivedAt: instant("received_at"), lastError: text("last_error"),
}, t => [foreignKey({ columns: [t.householdId,t.outboxId], foreignColumns: [outbox.householdId,outbox.id] }),
  check("workflow_delivery_state_check", sql`${t.state} in ('pending','sending','sent','received','paused')`),
  check("workflow_delivery_attempts_check", sql`${t.attempts} between 0 and 3`),
  check("workflow_delivery_total_attempts_check", sql`${t.totalAttempts}>=${t.attempts}`),
  check("workflow_delivery_last_error_check", sql`${t.lastError} in ('send_failed','attempt_limit')`),
  check("workflow_delivery_check", sql`(${t.leaseToken} is null)=(${t.leaseUntil} is null)`),
  index("workflow_delivery_pending").on(t.nextAttemptAt,t.outboxId).where(sql`${t.state} in ('pending','sending')`),
]);

export const calculationRuns = ops.table("calculation_run", {
  ...base(), sourceRevision: integer("source_revision").notNull(), ruleVersion: text("rule_version").notNull(),
  state: text().notNull().default("planning"), page: integer().notNull().default(0),
  cursorRevision: integer("cursor_revision").notNull().default(0),
  cursorId: uuid("cursor_id").notNull().default("00000000-0000-0000-0000-000000000000"),
  createdAt: instant("created_at").notNull().defaultNow(), updatedAt: instant("updated_at").notNull().defaultNow(),
}, t => [unique("calculation_run_scope").on(t.householdId,t.id), unique("calculation_run_household").on(t.householdId),
  check("calculation_run_source_revision_check", sql`${t.sourceRevision}>0`),
  check("calculation_run_rule_version_check", sql`${t.ruleVersion}='bank-plan-v1'`),
  check("calculation_run_state_check", sql`${t.state} in ('planning','prepared','superseded')`),
  check("calculation_run_page_check", sql`${t.page}>=0`),
  check("calculation_run_cursor_revision_check", sql`${t.cursorRevision}>=0 and ${t.cursorRevision}<=${t.sourceRevision}`),
]);
export const calculationAccounts = ops.table("calculation_account", {
  householdId: uuid("household_id").notNull(), runId: uuid("run_id").notNull(),
  accountId: uuid("account_id").notNull(), earliestDate: date("earliest_date").notNull(),
}, t => [primaryKey({ columns: [t.runId,t.accountId] }),
  foreignKey({ columns: [t.householdId,t.runId], foreignColumns: [calculationRuns.householdId,calculationRuns.id] }),
  foreignKey({ columns: [t.householdId,t.accountId], foreignColumns: [accounts.householdId,accounts.id] }),
]);

export const executionCapacity = ops.table("execution_capacity", {
  singleton: boolean().primaryKey().default(true), verifiedUntil: instant("verified_until").notNull(),
  remainingAttempts: bigint("remaining_attempts", { mode: "bigint" }).notNull(),
  remainingStorageBytes: bigint("remaining_storage_bytes", { mode: "bigint" }).notNull(),
}, t => [check("execution_capacity_singleton_check", sql`${t.singleton}`),
  check("execution_capacity_remaining_attempts_check", sql`${t.remainingAttempts}>=0`),
  check("execution_capacity_remaining_storage_bytes_check", sql`${t.remainingStorageBytes}>=0`),
]);
export const calculationBudgets = ops.table("calculation_budget", {
  runId: uuid("run_id").primaryKey(), householdId: uuid("household_id").notNull(),
  windowNumber: integer("window_number").notNull().default(1), windowAttempts: integer("window_attempts").notNull().default(0),
  totalAttempts: bigint("total_attempts", { mode: "bigint" }).notNull().default(sql`0`),
  stepPage: integer("step_page").notNull().default(0), stepAttempts: integer("step_attempts").notNull().default(0),
  state: text().notNull().default("ready"), reason: text(), leaseToken: uuid("lease_token"), leaseUntil: instant("lease_until"),
}, t => [foreignKey({ columns: [t.householdId,t.runId], foreignColumns: [calculationRuns.householdId,calculationRuns.id] }),
  check("calculation_budget_window_number_check", sql`${t.windowNumber}>0`),
  check("calculation_budget_window_attempts_check", sql`${t.windowAttempts} between 0 and 100`),
  check("calculation_budget_total_attempts_check", sql`${t.totalAttempts}>=${t.windowAttempts}`),
  check("calculation_budget_step_page_check", sql`${t.stepPage}>=0`),
  check("calculation_budget_step_attempts_check", sql`${t.stepAttempts} between 0 and 4`),
  check("calculation_budget_state_check", sql`${t.state} in ('ready','paused')`),
  check("calculation_budget_reason_check", sql`${t.reason} in ('capacity','retry_limit','window_limit')`),
  check("calculation_budget_lease_check", sql`(${t.leaseToken} is null)=(${t.leaseUntil} is null)`),
  check("calculation_budget_pause_check", sql`(${t.state}='paused')=(${t.reason} is not null)`),
]);

export const reporting = pgSchema("reporting");
export const bankCandidates = ops.table("bank_candidate", {
  runId: uuid("run_id").primaryKey(), householdId: uuid("household_id").notNull(), generationId: uuid("generation_id").notNull().defaultRandom(),
  asOf: date("as_of").notNull(), ruleVersion: text("rule_version").notNull().default("bank-movements-v1"), state: text().notNull().default("building"),
  page: integer().notNull().default(0), cursorDate: date("cursor_date"), cursorId: uuid("cursor_id"), eventCount: integer("event_count").notNull().default(0),
}, t => [foreignKey({ columns: [t.householdId,t.runId], foreignColumns: [calculationRuns.householdId,calculationRuns.id] }),
  unique("bank_candidate_generation").on(t.householdId,t.runId,t.generationId),
  check("bank_candidate_as_of_check", sql`${t.asOf} between '1900-01-01' and '9999-12-31'`),
  check("bank_candidate_rule_version_check", sql`${t.ruleVersion}='bank-movements-v1'`),
  check("bank_candidate_state_check", sql`${t.state} in ('building','calculated')`),
  check("bank_candidate_page_check", sql`${t.page}>=0`), check("bank_candidate_event_count_check", sql`${t.eventCount}>=0`),
  check("bank_candidate_cursor_check", sql`(${t.cursorDate} is null)=(${t.cursorId} is null)`),
]);
export const bankAccountMovements = reporting.table("bank_account_movement", {
  householdId: uuid("household_id").notNull(), runId: uuid("run_id").notNull(), generationId: uuid("generation_id").notNull(),
  accountId: uuid("account_id").notNull(), currency: text().notNull().references(() => currencies.code), ledgerKind: text("ledger_kind").notNull(), effectiveDate: date("effective_date").notNull(),
  nativeDelta: numeric("native_delta").notNull(), bookDeltaInr: numeric("book_delta_inr").notNull(), cashDelta: numeric("cash_delta").notNull(),
  openingDelta: numeric("opening_delta").notNull(), unresolvedDelta: numeric("unresolved_delta").notNull(), postingCount: bigint("posting_count", { mode: "bigint" }).notNull(), incompleteEvidence: boolean("incomplete_evidence").notNull(),
}, t => [primaryKey({ columns: [t.runId,t.accountId,t.currency,t.ledgerKind,t.effectiveDate] }),
  foreignKey({ columns: [t.householdId,t.runId,t.generationId], foreignColumns: [bankCandidates.householdId,bankCandidates.runId,bankCandidates.generationId] }),
  foreignKey({ columns: [t.householdId,t.accountId], foreignColumns: [accounts.householdId,accounts.id] }),
  check("bank_account_movement_ledger_kind_check", sql`${t.ledgerKind} in ('asset','liability')`), check("bank_account_movement_posting_count_check", sql`${t.postingCount}>0`),
]);
export const bankCategoryMovements = reporting.table("bank_category_movement", {
  id: uuid().defaultRandom().primaryKey(), householdId: uuid("household_id").notNull(), runId: uuid("run_id").notNull(), generationId: uuid("generation_id").notNull(),
  accountId: uuid("account_id").notNull(), month: date().notNull(), kind: text().notNull(), categoryId: uuid("category_id"),
  amountInr: numeric("amount_inr").notNull(), postingCount: bigint("posting_count", { mode: "bigint" }).notNull(),
}, t => [unique("bank_category_grain").on(t.runId,t.accountId,t.month,t.kind,t.categoryId).nullsNotDistinct(),
  foreignKey({ columns: [t.householdId,t.runId,t.generationId], foreignColumns: [bankCandidates.householdId,bankCandidates.runId,bankCandidates.generationId] }),
  foreignKey({ columns: [t.householdId,t.accountId], foreignColumns: [accounts.householdId,accounts.id] }),
  foreignKey({ columns: [t.householdId,t.categoryId], foreignColumns: [categories.householdId,categories.id] }),
  check("bank_category_movement_month_check", sql`extract(day from ${t.month})=1`), check("bank_category_movement_kind_check", sql`${t.kind} in ('income','expense')`),
  check("bank_category_movement_posting_count_check", sql`${t.postingCount}>0`),
]);

export const bankBalanceCandidates = ops.table("bank_balance_candidate", {
  runId: uuid("run_id").primaryKey(), householdId: uuid("household_id").notNull(), generationId: uuid("generation_id").notNull(),
  state: text().notNull().default("building"), page: integer().notNull().default(0), cursorAccountId: uuid("cursor_account_id"),
}, t => [foreignKey({ columns: [t.householdId,t.runId,t.generationId], foreignColumns: [bankCandidates.householdId,bankCandidates.runId,bankCandidates.generationId] }),
  check("bank_balance_candidate_state_check", sql`${t.state} in ('building','calculated')`), check("bank_balance_candidate_page_check", sql`${t.page}>=0`),
]);
export const bankBalanceCheckpoints = reporting.table("bank_balance_checkpoint", {
  householdId: uuid("household_id").notNull(), runId: uuid("run_id").notNull(), generationId: uuid("generation_id").notNull(), accountId: uuid("account_id").notNull(),
  currency: text().notNull().references(() => currencies.code), effectiveDate: date("effective_date").notNull(),
  calculatedBalance: numeric("calculated_balance"), reconciledBalance: numeric("reconciled_balance"), result: jsonb().notNull(),
}, t => [primaryKey({ columns: [t.runId,t.accountId,t.effectiveDate] }),
  foreignKey({ columns: [t.householdId,t.runId,t.generationId], foreignColumns: [bankCandidates.householdId,bankCandidates.runId,bankCandidates.generationId] }),
  foreignKey({ columns: [t.householdId,t.accountId], foreignColumns: [accounts.householdId,accounts.id] }),
]);

export const reportReleases = ops.table("report_release", {
  id: uuid().defaultRandom().primaryKey(), householdId: uuid("household_id").notNull(), runId: uuid("run_id").notNull(),
  sourceRevision: integer("source_revision").notNull(), asOf: date("as_of").notNull(), state: text().notNull().default("published"),
  publishedAt: instant("published_at").notNull().defaultNow(), retiredAt: instant("retired_at"),
}, t => [unique("report_release_scope").on(t.householdId,t.id), unique("report_release_run").on(t.runId),
  foreignKey({ columns: [t.householdId,t.runId], foreignColumns: [calculationRuns.householdId,calculationRuns.id] }),
  check("report_release_revision_check", sql`${t.sourceRevision}>0`), check("report_release_state_check", sql`${t.state} in ('published','previous','retired')`),
]);
export const reportReleaseAccounts = ops.table("report_release_account", {
  householdId: uuid("household_id").notNull(), releaseId: uuid("release_id").notNull(), accountId: uuid("account_id").notNull(),
  sourceRunId: uuid("source_run_id").notNull(), generationId: uuid("generation_id").notNull(), effectiveDate: date("effective_date").notNull(),
}, t => [primaryKey({ columns: [t.releaseId,t.accountId] }),
  foreignKey({ columns: [t.householdId,t.releaseId], foreignColumns: [reportReleases.householdId,reportReleases.id] }),
  foreignKey({ columns: [t.householdId,t.sourceRunId,t.generationId], foreignColumns: [bankCandidates.householdId,bankCandidates.runId,bankCandidates.generationId] }),
  foreignKey({ columns: [t.householdId,t.accountId], foreignColumns: [accounts.householdId,accounts.id] }),
]);
export const currentReportReleases = ops.table("current_report_release", {
  householdId: uuid("household_id").primaryKey(), releaseId: uuid("release_id").notNull(), updatedAt: instant("updated_at").notNull().defaultNow(),
}, t => [foreignKey({ columns: [t.householdId,t.releaseId], foreignColumns: [reportReleases.householdId,reportReleases.id] })]);
export const reportRequestPins = ops.table("report_request_pin", {
  id: uuid().defaultRandom().primaryKey(), householdId: uuid("household_id").notNull(), releaseId: uuid("release_id").notNull(), expiresAt: instant("expires_at").notNull(),
}, t => [foreignKey({ columns: [t.householdId,t.releaseId], foreignColumns: [reportReleases.householdId,reportReleases.id] }), index("report_pin_expiry").on(t.expiresAt)]);

// Card facility terms are immutable dated observations. New evidence appends a
// revision; report readers select only observations captured by their release.
export const creditFacilities = core.table("credit_facility", {
  ...base(), name: text().notNull(), currency: text().notNull().default("INR"),
}, t => [unique("credit_facility_scope").on(t.householdId,t.id),
  check("credit_facility_name", sql`length(btrim(${t.name})) between 1 and 100`),
  check("credit_facility_currency", sql`${t.currency}='INR'`)]);

export const creditFacilityTerms = core.table("credit_facility_term", {
  ...base(), facilityId: uuid("facility_id").notNull(), sourceId: uuid("source_id").notNull(),
  effectiveDate: date("effective_date").notNull(), limitInr: numeric("limit_inr"),
}, t => [
  foreignKey({ columns: [t.householdId,t.facilityId], foreignColumns: [creditFacilities.householdId,creditFacilities.id] }),
  foreignKey({ columns: [t.householdId,t.sourceId], foreignColumns: [sourceRecords.householdId,sourceRecords.id] }),
  unique("facility_term_source").on(t.householdId,t.facilityId,t.sourceId,t.effectiveDate),
  index("facility_term_date").on(t.householdId,t.facilityId,t.effectiveDate),
  check("facility_term_limit", sql`${t.limitInr} is null or (${t.limitInr}>=0 and ${t.limitInr}<1e26 and scale(${t.limitInr})<=2)`),
]);

export const accountFacilityLinks = core.table("account_facility_link", {
  ...base(), accountId: uuid("account_id").notNull(), facilityId: uuid("facility_id"),
  sourceId: uuid("source_id").notNull(), effectiveDate: date("effective_date").notNull(),
}, t => [
  foreignKey({ columns: [t.householdId,t.accountId], foreignColumns: [accounts.householdId,accounts.id] }),
  foreignKey({ columns: [t.householdId,t.facilityId], foreignColumns: [creditFacilities.householdId,creditFacilities.id] }),
  foreignKey({ columns: [t.householdId,t.sourceId], foreignColumns: [sourceRecords.householdId,sourceRecords.id] }),
  unique("facility_link_source").on(t.householdId,t.accountId,t.sourceId,t.effectiveDate),
  index("facility_link_date").on(t.householdId,t.accountId,t.effectiveDate),
]);

export const cardStatements = core.table("card_statement", {
  ...base(), observationId: uuid("observation_id").notNull(), paymentDueDate: date("payment_due_date"),
  minimumDue: numeric("minimum_due"),
}, t => [
  foreignKey({ columns: [t.householdId,t.observationId], foreignColumns: [observations.householdId,observations.id] }),
  unique("card_statement_observation").on(t.householdId,t.observationId),
  check("card_statement_minimum", sql`${t.minimumDue} is null or (${t.minimumDue}>=0 and ${t.minimumDue}<1e26 and scale(${t.minimumDue})<=2)`),
]);
