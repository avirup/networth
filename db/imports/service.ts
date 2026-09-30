import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Transaction } from "@/db/auth/connection";
import type { Actor } from "@/db/auth/service";
import { AccessError } from "@/lib/auth/errors";
import { FINANCIAL_SCHEMA } from "@/lib/config/policy";
import { bankPostings } from "@/lib/finance/bank-posting";
import { calendarDate, decimal } from "@/lib/finance/decimal";
import { confirmationSchema, categoryKind, encodedBytes, localWarnings, statementReconciliation, validateConfirmation, type Confirmation } from "@/lib/imports/review";
import type { BankRow } from "@/lib/imports/bank-v1";
import * as f from "@/db/schema/finance";

function fail(message: string, status = 400): never { throw new AccessError(status, message); }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fingerprint(row: BankRow) { return hash([row.transaction_date, row.description, row.direction, row.amount, row.currency]); }
function validate(input: unknown) { try { return validateConfirmation(input); } catch (error) { return fail(error instanceof Error && error.name !== "ZodError" ? error.message : "Check the confirmation fields and every CSV row."); } }
function requireSchema(actor: Actor) { if (actor.schemaVersion !== FINANCIAL_SCHEMA) fail("Apply the database upgrade before importing.", 503); }
const scope = (householdId: string) => eq(f.accounts.householdId, householdId);
export async function importStatus(tx: Transaction, actor: Actor) {
  requireSchema(actor);
  const accounts = await tx.select({ id: f.accounts.id, name: f.accounts.name, currency: f.accounts.currency, kind: f.accounts.kind }).from(f.accounts).where(scope(actor.householdId)).orderBy(f.accounts.name).limit(1000);
  const revision = (await tx.select().from(f.revisions).where(eq(f.revisions.householdId, actor.householdId)))[0]!.revision;
  const readiness = await tx.execute<{ ready: boolean; reason: string }>(sql`select workflow_verified and verified_until>clock_timestamp() and remaining_imports>0 and remaining_storage_bytes>0 and pg_database_size(current_database())<400000000 as ready, reason from ops.import_admission where singleton`);
  const history = await tx.execute(sql`select b.id,b.revision,b.row_count as "rowCount",b.confirmed_at as "confirmedAt", a.name as "accountName",o.state,d.state as "deliveryState",d.total_attempts as "deliveryAttempts",cr.id as "calculationRunId",cr.state as "calculationState",cb.state as "planningExecutionState",cb.reason as "planningPauseReason",cb.window_attempts as "planningWindowAttempts",cb.total_attempts::text as "planningTotalAttempts",bc.state as "bankCalculationState",bc.page as "bankCalculationPage",bc.as_of::text as "bankCalculationAsOf",balance.state as "bankBalanceState",balance.page as "bankBalancePage",release.state as "reportState",release.id as "reportReleaseId"
    from core.import_batch b join core.dim_account a on a.id=b.account_id and a.household_id=b.household_id join ops.outbox_event o on o.batch_id=b.id and o.household_id=b.household_id
    left join ops.workflow_delivery d on d.outbox_id=o.id and d.household_id=b.household_id
    left join lateral (select candidate.* from ops.calculation_run candidate where candidate.household_id=b.household_id and b.revision<=candidate.source_revision order by candidate.source_revision desc,candidate.created_at desc limit 1) cr on true
    left join ops.calculation_budget cb on cb.run_id=cr.id and cb.household_id=b.household_id left join ops.bank_candidate bc on bc.run_id=cr.id and bc.household_id=b.household_id left join ops.bank_balance_candidate balance on balance.run_id=cr.id and balance.household_id=b.household_id
    left join ops.report_release release on release.run_id=cr.id and release.household_id=cr.household_id
    where b.household_id=${actor.householdId} order by b.revision desc limit 100`);
  return { accounts, revision, ready: readiness.rows[0]?.ready ?? false, reason: readiness.rows[0]?.ready ? "Capacity verified; confirmation will check again." : "Confirmation paused. A verified workflow and available storage/provider capacity are required.", history: history.rows };
}

type Match = { rowId: string; eventId: string; kind: string; effectiveDate: string; reason: string };
async function inspect(tx: Transaction, actor: Actor, data: Confirmation) {
  const hh = actor.householdId;
  const account = (await tx.select().from(f.accounts).where(and(scope(hh), eq(f.accounts.id, data.manifest.accountId))))[0];
  if (data.newAccount ? !!account : !account) fail("Account selection changed. Review the account again.", 409);
  if (account && (account.currency !== data.manifest.currency || !["bank", "cash"].includes(account.kind) || account.closedOn)) fail("Use an open bank or cash account with the same currency.");
  const warnings = localWarnings(data);
  const overlap = await tx.execute(sql`select id from core.import_batch where household_id=${hh} and account_id=${data.manifest.accountId} and coverage_start<=${data.manifest.coverageEnd}::date and coverage_end>=${data.manifest.coverageStart}::date limit 1`);
  if (overlap.rows.length) warnings.push({ code: "overlap", message: "Statement coverage overlaps an earlier batch. Review duplicates; balances remain evidence only." });
  const keys = data.rows.map(row => ({ row_id: row.row_id, hash: fingerprint(row), ref: row.transaction_ref, day: row.transaction_date, amount: decimal(row.amount).mul(row.direction === "credit" ? 1 : -1).toFixed(), kind: row.event_type }));
  const matches = await tx.execute<Match>(sql`
    with input as (select * from jsonb_to_recordset(${JSON.stringify(keys)}::jsonb) as x(row_id text,hash text,ref text,day date,amount numeric,kind text)), candidates as (
      select distinct x.row_id,e.id,e.kind,e.effective_date,'Similar source evidence'::text reason from input x
      join core.source_record s on s.household_id=${hh} and (s.row_hash=x.hash or (x.ref<>'' and s.provider_reference=x.ref))
      join core.import_batch b on b.id=s.batch_id and b.household_id=s.household_id and b.account_id=${data.manifest.accountId}
      join core.event_source_link l on l.source_id=s.id and l.household_id=s.household_id
      join core.transaction_event e on e.id=l.event_id and e.household_id=l.household_id
      union
      select distinct x.row_id,e.id,e.kind,e.effective_date,'Possible opposite-side transfer'::text from input x
      join core.transaction_event e on e.household_id=${hh} and e.kind=x.kind and e.kind in ('transfer','card_repayment') and e.effective_date=x.day
      join core.fact_posting p on p.event_id=e.id and p.household_id=e.household_id and p.native_amount=x.amount and p.currency=${data.manifest.currency}
      join core.ledger_account a on a.id=p.ledger_account_id and a.household_id=p.household_id and a.account_id=${data.manifest.accountId}
    ) select row_id as "rowId",id as "eventId",kind,effective_date::text as "effectiveDate",reason from candidates c
      where not exists(select from core.transaction_event r where r.household_id=${hh} and r.reverses_id=c.id)
      and kind<>'reversal' order by row_id,id limit 1001`);
  if (matches.rows.length > 1000) fail("Too many duplicate candidates. Split this statement into smaller reviewed batches.");
  if (matches.rows.length) warnings.push({ code: "duplicates", message: "Possible duplicates were found. Link existing events, replace mistakes, or explain why these are separate transactions." });
  return { warnings, matches: matches.rows, reconciliation: statementReconciliation(data) };
}
export async function reviewImport(tx: Transaction, actor: Actor, input: unknown) {
  requireSchema(actor); const data = validate(input);
  await tx.execute(sql`select revision from ops.source_revision where household_id=${actor.householdId} for share`);
  const result = await inspect(tx, actor, data);
  const status = await importStatus(tx, actor);
  return { ...result, revision: status.revision, ready: status.ready, reason: status.reason };
}

export async function confirmImport(tx: Transaction, actor: Actor, input: unknown, requestBytes: number, workflowConfigured = false) {
  requireSchema(actor); if (!["owner", "editor"].includes(actor.role)) fail("Import permission is required.", 403);
  const data = validate(input), hh = actor.householdId;
  if (requestBytes < encodedBytes(input) || requestBytes > 3_000_000) fail("Confirmation request exceeds the permitted envelope.", 413);
  // Serialize household revisions and re-check after waiting. An exact retry wins before stale checks.
  const revision = (await tx.execute<{ revision: number }>(sql`select revision from ops.source_revision where household_id=${hh} for update`)).rows[0]!.revision;
  const submitted = confirmationSchema.parse(input);
  const contentHash = hash(submitted);
  const retry = (await tx.select().from(f.batches).where(and(eq(f.batches.householdId, hh), eq(f.batches.idempotencyKey, data.idempotencyKey))))[0];
  if (retry) {
    if (retry.contentHash !== contentHash) fail("This retry key belongs to a different review. Start a new review.", 409);
    return { batchId: retry.id, revision: retry.revision, retry: true, state: "committed" };
  }
  if (!workflowConfigured) fail("Confirmation paused. Configure and verify the calculation workflow first.", 503);
  if (revision !== data.expectedRevision) fail("Household records changed. Review the statement again before confirming.", 409);
  const review = await inspect(tx, actor, data);
  for (const warning of review.warnings) if (!data.acknowledgements.includes(warning.code)) fail(`Acknowledge: ${warning.message}`);
  for (const match of review.matches) if (data.decisions[match.rowId]!.action === "new" && !data.decisions[match.rowId]!.note) fail(`Row ${match.rowId}: explain why this possible duplicate is a separate transaction.`);
  const allAccounts = await tx.select().from(f.accounts).where(scope(hh));
  if (allAccounts.length >= 1000 && data.newAccount) fail("Account capacity reached.");
  if (data.newAccount) {
    await tx.insert(f.accounts).values({ id: data.manifest.accountId, householdId: hh, name: data.newAccount.name, currency: data.manifest.currency, maskedReference: data.newAccount.maskedReference });
    allAccounts.push({ id: data.manifest.accountId, householdId: hh, name: data.newAccount.name, kind: "bank", currency: data.manifest.currency, maskedReference: data.newAccount.maskedReference, institutionId: null, openedOn: null, closedOn: null });
  }
  const ledgers = await tx.select().from(f.ledgerAccounts).where(eq(f.ledgerAccounts.householdId, hh));
  const newLedgers: (typeof f.ledgerAccounts.$inferInsert)[] = [];
  function ledger(accountId: string | null, kind: "asset" | "liability" | "income" | "expense" | "equity", currency: string) {
    const code = accountId ? `account:${accountId}` : `bank:${kind}:INR`;
    const existing = ledgers.find(l => l.code === code) ?? newLedgers.find(l => l.code === code);
    if (existing) { if (existing.kind !== kind || existing.currency !== currency) fail("Ledger account identity does not match this import."); return existing.id!; }
    const id = randomUUID(); newLedgers.push({ id, householdId: hh, accountId, kind, currency, code }); return id;
  }
  const cash = ledger(data.manifest.accountId, "asset", data.manifest.currency);
  const categoryRows = await tx.select().from(f.categories).where(eq(f.categories.householdId, hh));
  const targetIds = [...new Set(data.rows.flatMap(row => data.decisions[row.row_id]!.eventId ? [data.decisions[row.row_id]!.eventId!] : []))];
  const targets = targetIds.length ? await tx.select().from(f.events).where(and(eq(f.events.householdId, hh), inArray(f.events.id, targetIds))) : [];
  const targetLegs = targetIds.length ? await tx.select().from(f.postings).where(and(eq(f.postings.householdId, hh), inArray(f.postings.eventId, targetIds))) : [];
  const reversals = targetIds.length ? await tx.select().from(f.events).where(and(eq(f.events.householdId, hh), inArray(f.events.reversesId, targetIds))) : [];
  const batchId = randomUUID(), nextRevision = revision + 1;
  const sources: (typeof f.sourceRecords.$inferInsert)[] = [], eventRows: (typeof f.events.$inferInsert)[] = [], postingRows: (typeof f.postings.$inferInsert)[] = [], links: (typeof f.sourceLinks.$inferInsert)[] = [];
  const affected = new Set([data.manifest.accountId]);
  const resolutions: { observationId: string; eventId: string; row: BankRow }[] = [];
  for (const [index, row] of data.rows.entries()) {
    const decision = data.decisions[row.row_id]!, sourceId = randomUUID();
    sources.push({ id: sourceId, householdId: hh, batchId, rowNumber: index + 1, providerReference: row.transaction_ref || null, rowHash: fingerprint(row), payload: { ...submitted.rows[index]!, review: JSON.stringify(decision) } });
    const target = targets.find(e => e.id === decision.eventId);
    const originalLegs = targetLegs.filter(p => p.eventId === target?.id);
    if (decision.eventId && (!target || target.state !== "confirmed" || target.kind === "reversal" || reversals.some(e => e.reversesId === target.id))) fail(`Row ${row.row_id}: the selected event is unavailable or has been reversed.`, 409);
    if (target) {
      const accountLeg = originalLegs.find(p => ledgers.some(l => l.id === p.ledgerAccountId && l.accountId === data.manifest.accountId));
      if (!accountLeg) fail("Selected event does not belong to this statement account.");
      if (decision.action === "link") {
        const signed = decimal(row.amount).mul(row.direction === "credit" ? 1 : -1);
        const book = bankPostings(row, { cashAccount: "check", offsetAccount: "offset", offsetKind: categoryKind(row) ?? (row.event_type === "transfer" ? "asset" : row.event_type === "card_repayment" ? "liability" : "equity"), reviewedAdjustment: true }).legs[0]!.bookAmountInr;
        if (target.kind !== row.event_type || target.effectiveDate !== row.transaction_date || accountLeg.currency !== row.currency || !decimal(accountLeg.nativeAmount).eq(signed) || !decimal(accountLeg.bookAmountInr).eq(book)) fail(`Row ${row.row_id}: linked event date, type and amounts must agree.`);
        const originalCategory = originalLegs.find(p => p.categoryId)?.categoryId;
        if ((categoryRows.find(c => c.id === originalCategory)?.code ?? "") !== row.category) fail("Linking cannot change an existing category. Use a reviewed replacement.");
        links.push({ householdId: hh, eventId: target.id, sourceId }); continue;
      }
      if (target.effectiveDate < data.manifest.coverageStart || target.effectiveDate > data.manifest.coverageEnd) fail("Correction coverage must include the original event date.");
      const reversalId = randomUUID();
      eventRows.push({ id: reversalId, householdId: hh, batchId, kind: "reversal", effectiveDate: target.effectiveDate, reversesId: target.id, quality: target.quality, reviewNote: decision.note });
      links.push({ householdId: hh, eventId: reversalId, sourceId });
      for (const leg of originalLegs) {
        postingRows.push({ householdId: hh, eventId: reversalId, lineNumber: leg.lineNumber, ledgerAccountId: leg.ledgerAccountId, nativeAmount: decimal(leg.nativeAmount).neg().toFixed(), bookAmountInr: decimal(leg.bookAmountInr).neg().toFixed(), currency: leg.currency, categoryId: leg.categoryId, counterpartyId: leg.counterpartyId });
        const oldAccount = ledgers.find(l => l.id === leg.ledgerAccountId)?.accountId;
        if (oldAccount) affected.add(oldAccount);
        if (ledgers.find(l => l.id === leg.ledgerAccountId)?.holdingId) fail("Investment corrections require their product-specific import workflow.");
      }
    }
    const kind = categoryKind(row) ?? (row.event_type === "transfer" ? "asset" : row.event_type === "card_repayment" ? "liability" : "equity");
    let offset: string;
    if (kind === "asset" || kind === "liability") {
      const other = allAccounts.find(a => a.id === decision.offsetAccountId && a.id !== data.manifest.accountId && !a.closedOn && (kind === "liability" ? a.kind === "credit_card" : ["bank", "cash"].includes(a.kind)));
      if (!other || other.currency !== "INR" || row.currency !== "INR") fail(`Row ${row.row_id}: select a distinct INR ${kind === "asset" ? "bank" : "card"} account. Cross-currency transfers need a separately evidenced FX workflow.`);
      offset = ledger(other.id, kind, other.currency); affected.add(other.id);
    } else offset = ledger(null, kind, "INR");
    const built = bankPostings(row, { cashAccount: cash, offsetAccount: offset, offsetKind: kind, reviewedAdjustment: !!decision.note });
    const eventId = randomUUID();
    eventRows.push({ id: eventId, householdId: hh, batchId, kind: row.event_type, effectiveDate: row.transaction_date, quality: built.quality, reviewNote: decision.note || null, replacesId: decision.action === "replace" ? target!.id : null });
    links.push({ householdId: hh, eventId, sourceId });
    for (const [i, leg] of built.legs.entries()) {
      const category = leg.category ? categoryRows.find(c => c.code === leg.category && !c.archived && c.kind === leg.kind) : null;
      if (leg.category && !category) fail("Category is unavailable. Review the row again.");
      postingRows.push({ householdId: hh, eventId, lineNumber: i + 1, ledgerAccountId: leg.account, nativeAmount: leg.nativeAmount, bookAmountInr: leg.bookAmountInr, currency: leg.currency, categoryId: category?.id ?? null });
    }
    if (decision.resolutionObservationId) resolutions.push({ observationId: decision.resolutionObservationId, eventId, row });
  }
  const observationRows: (typeof f.observations.$inferInsert)[] = [];
  for (const kind of ["opening", "closing"] as const) {
    const value = kind === "opening" ? data.manifest.openingBalance : data.manifest.closingBalance;
    const sourceId = randomUUID(), asOf = kind === "opening" ? data.manifest.coverageStart : data.manifest.coverageEnd;
    sources.push({ id: sourceId, householdId: hh, batchId, rowNumber: sources.length + 1, rowHash: hash([kind, asOf, value]), payload: { kind, as_of: asOf, balance: value ?? "", unknown_reason: value === null ? data.manifest.historyReason || "Closing statement balance not supplied." : "" } });
    observationRows.push({ id: randomUUID(), householdId: hh, sourceId, accountId: data.manifest.accountId, kind, asOf, balance: value, currency: data.manifest.currency, unknownReason: value === null ? data.manifest.historyReason || "Closing statement balance not supplied." : null });
  }
  // All writes, capacity reservation and deferred ledger checks commit or roll back together.
  await tx.insert(f.batches).values({ id: batchId, householdId: hh, accountId: data.manifest.accountId, schemaVersion: "bank-v1", idempotencyKey: data.idempotencyKey, contentHash, coverageStart: data.manifest.coverageStart, coverageEnd: data.manifest.coverageEnd, completeness: data.manifest.completeness, rowCount: sources.length, requestBytes, revision: nextRevision, reviewedBy: actor.userId });
  await tx.update(f.revisions).set({ revision: nextRevision }).where(eq(f.revisions.householdId, hh));
  const dates = [...new Set([data.manifest.coverageStart, data.manifest.coverageEnd, ...eventRows.map(e => e.effectiveDate)])].map(calendarDate);
  for (let i = 0; i < dates.length; i += 250) await tx.insert(f.dates).values(dates.slice(i, i + 250)).onConflictDoNothing();
  if (newLedgers.length) await tx.insert(f.ledgerAccounts).values(newLedgers);
  for (let i = 0; i < sources.length; i += 250) await tx.insert(f.sourceRecords).values(sources.slice(i, i + 250));
  for (let i = 0; i < eventRows.length; i += 250) await tx.insert(f.events).values(eventRows.slice(i, i + 250));
  for (let i = 0; i < postingRows.length; i += 250) await tx.insert(f.postings).values(postingRows.slice(i, i + 250));
  for (let i = 0; i < links.length; i += 250) await tx.insert(f.sourceLinks).values(links.slice(i, i + 250));
  if (eventRows.length) await tx.update(f.events).set({ state: "confirmed" }).where(and(eq(f.events.householdId, hh), eq(f.events.batchId, batchId)));
  await tx.insert(f.observations).values(observationRows);
  const rec = review.reconciliation;
  await tx.insert(f.reconciliations).values({ householdId: hh, observationId: observationRows[1]!.id!, revision: nextRevision, status: rec.status, calculatedBalance: rec.calculated, difference: rec.difference, explanation: rec.reason });
  for (const resolution of resolutions) {
    const original = await tx.execute<{ balance: string; difference: string; asOf: string }>(sql`select o.balance::text,r.difference::text,o.as_of::text as "asOf" from core.fact_statement_observation o join lateral (select * from core.reconciliation_result r where r.household_id=o.household_id and r.observation_id=o.id order by revision desc limit 1) r on true where o.household_id=${hh} and o.id=${resolution.observationId} and o.account_id=${data.manifest.accountId} and r.status='mismatch' and o.kind='closing'`);
    const evidence = original.rows[0];
    if (!evidence || resolution.row.transaction_date !== evidence.asOf || !decimal(resolution.row.amount).mul(resolution.row.direction === "credit" ? 1 : -1).eq(evidence.difference)) fail("Resolution must match the latest evidenced difference, date and account.");
    await tx.insert(f.reconciliations).values({ householdId: hh, observationId: resolution.observationId, revision: nextRevision, status: "matched", calculatedBalance: evidence.balance, difference: "0", explanation: "Difference represented by a reviewed unresolved equity adjustment; history remains incomplete.", resolutionEventId: resolution.eventId });
  }
  await tx.insert(f.outbox).values({ householdId: hh, batchId, revision: nextRevision });
  await tx.insert(f.rebuilds).values([...affected].map(accountId => ({ householdId: hh, batchId, accountId, earliestDate: data.manifest.coverageStart, revision: nextRevision })));
  return { batchId, revision: nextRevision, retry: false, state: "committed" };
}
