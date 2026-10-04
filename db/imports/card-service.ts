import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Transaction } from "@/db/auth/connection";
import type { Actor } from "@/db/auth/service";
import { AccessError } from "@/lib/auth/errors";
import { FINANCIAL_SCHEMA } from "@/lib/config/policy";
import { calendarDate, decimal } from "@/lib/finance/decimal";
import { cardOpeningPostings, cardPostings } from "@/lib/finance/card-posting";
import { cardConfirmationSchema, reviewCardConfirmation, validateCardConfirmation, type CardConfirmation } from "@/lib/imports/card-review";
import { encodedBytes } from "@/lib/imports/review";
import type { CardRow } from "@/lib/imports/card-v1";
import { importStatus } from "./service";
import * as f from "@/db/schema/finance";

function fail(message: string, status = 400): never { throw new AccessError(status, message); }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fingerprint = (row: CardRow) => hash([row.transaction_date, row.description, row.direction, row.amount, row.currency]);
const ledgerEventKind = (row: CardRow) => row.event_type === "card_refund" ? "expense_refund" : row.event_type === "card_repayment" ? "card_repayment" : "expense";
function validate(input: unknown) { try { return validateCardConfirmation(input); } catch (error) { return fail(error instanceof Error && error.name !== "ZodError" ? error.message : "Check the card confirmation fields and every CSV row."); } }
function requireSchema(actor: Actor) { if (actor.schemaVersion !== FINANCIAL_SCHEMA) fail("Apply the database upgrade before importing.", 503); }

type Match = { rowId: string; eventId: string; kind: string; effectiveDate: string; reason: string };
async function inspect(tx: Transaction, actor: Actor, data: CardConfirmation) {
  const hh = actor.householdId;
  const account = (await tx.select().from(f.accounts).where(and(eq(f.accounts.householdId, hh), eq(f.accounts.id, data.manifest.accountId))))[0];
  if (data.newAccount ? !!account : !account) fail("Card account selection changed. Review it again.", 409);
  if (account && (account.currency !== "INR" || account.kind !== "credit_card" || account.closedOn)) fail("Use an open INR credit-card account.");
  const facility = (await tx.select().from(f.creditFacilities).where(and(eq(f.creditFacilities.householdId, hh), eq(f.creditFacilities.id, data.facility.id))))[0];
  if (data.facility.newFacility ? !!facility : !facility) fail("Credit facility selection changed. Review it again.", 409);
  const reviewed = reviewCardConfirmation(data);
  const warnings = [...reviewed.warnings];
  const overlap = await tx.execute(sql`select id from core.import_batch where household_id=${hh} and account_id=${data.manifest.accountId} and coverage_start<=${data.manifest.coverageEnd}::date and coverage_end>=${data.manifest.coverageStart}::date limit 1`);
  if (overlap.rows.length) warnings.push({ code: "overlap", message: "Statement coverage overlaps earlier card evidence. Review duplicates and corrections." });
  const keys = data.rows.map(row => ({ row_id: row.row_id, hash: fingerprint(row), ref: row.transaction_ref, day: row.transaction_date, amount: decimal(row.amount).mul(row.direction === "debit" ? -1 : 1).toFixed(), kind: row.event_type }));
  const matches = await tx.execute<Match>(sql`
    with input as (select * from jsonb_to_recordset(${JSON.stringify(keys)}::jsonb) as x(row_id text,hash text,ref text,day date,amount numeric,kind text)), candidates as (
      select distinct x.row_id,e.id,e.kind,e.effective_date,'Similar source evidence'::text reason from input x
      join core.source_record s on s.household_id=${hh} and (s.row_hash=x.hash or (x.ref<>'' and s.provider_reference=x.ref))
      join core.import_batch b on b.id=s.batch_id and b.household_id=s.household_id and b.account_id=${data.manifest.accountId}
      join core.event_source_link l on l.source_id=s.id and l.household_id=s.household_id
      join core.transaction_event e on e.id=l.event_id and e.household_id=l.household_id
      union
      select distinct x.row_id,e.id,e.kind,e.effective_date,'Possible bank-side repayment'::text from input x
      join core.transaction_event e on e.household_id=${hh} and e.kind='card_repayment' and x.kind='card_repayment' and e.effective_date=x.day
      join core.fact_posting p on p.event_id=e.id and p.household_id=e.household_id and p.native_amount=x.amount and p.currency='INR'
      join core.ledger_account a on a.id=p.ledger_account_id and a.household_id=p.household_id and a.account_id=${data.manifest.accountId}
    ) select row_id as "rowId",id as "eventId",kind,effective_date::text as "effectiveDate",reason from candidates c
    where kind<>'reversal' and not exists(select from core.transaction_event r where r.household_id=${hh} and r.reverses_id=c.id)
    order by row_id,id limit 1001`);
  if (matches.rows.length > 1000) fail("Too many duplicate candidates. Split this statement into smaller reviewed batches.");
  if (matches.rows.length) warnings.push({ code: "duplicates", message: "Possible duplicate card events were found. Link, replace, or explain each separate event." });
  return { ...reviewed, warnings, matches: matches.rows };
}

export async function reviewCardImport(tx: Transaction, actor: Actor, input: unknown) {
  requireSchema(actor); const data = validate(input);
  await tx.execute(sql`select revision from ops.source_revision where household_id=${actor.householdId} for share`);
  const result = await inspect(tx, actor, data), status = await importStatus(tx, actor);
  return { warnings: result.warnings, matches: result.matches, reconciliation: result.reconciliation, revision: status.revision, ready: status.ready, reason: status.reason };
}

export async function confirmCardImport(tx: Transaction, actor: Actor, input: unknown, requestBytes: number, workflowConfigured = false) {
  requireSchema(actor); if (!["owner", "editor"].includes(actor.role)) fail("Import permission is required.", 403);
  const data = validate(input), hh = actor.householdId;
  if (requestBytes < encodedBytes(input) || requestBytes > 3_000_000) fail("Confirmation request exceeds the permitted envelope.", 413);
  const revision = (await tx.execute<{ revision: number }>(sql`select revision from ops.source_revision where household_id=${hh} for update`)).rows[0]!.revision;
  const submitted = cardConfirmationSchema.parse(input), contentHash = hash(submitted);
  const retry = (await tx.select().from(f.batches).where(and(eq(f.batches.householdId, hh), eq(f.batches.idempotencyKey, data.idempotencyKey))))[0];
  if (retry) {
    if (retry.contentHash !== contentHash) fail("This retry key belongs to a different review. Start a new review.", 409);
    return { batchId: retry.id, revision: retry.revision, retry: true, state: "committed" };
  }
  if (!workflowConfigured) fail("Confirmation paused. Configure and verify the calculation workflow first.", 503);
  if (revision !== data.expectedRevision) fail("Household records changed. Review the statement again before confirming.", 409);
  const review = await inspect(tx, actor, data);
  for (const warning of review.warnings) if (!data.acknowledgements.includes(warning.code)) fail(`Acknowledge: ${warning.message}`);
  for (const match of review.matches) if (data.decisions[match.rowId]!.action === "new" && !data.decisions[match.rowId]!.note) fail(`Row ${match.rowId}: explain why this possible duplicate is separate.`);

  const accounts = await tx.select().from(f.accounts).where(eq(f.accounts.householdId, hh));
  if (accounts.length >= 1000 && data.newAccount) fail("Account capacity reached.");
  if (data.newAccount) {
    await tx.insert(f.accounts).values({ id: data.manifest.accountId, householdId: hh, name: data.newAccount.name, kind: "credit_card", currency: "INR", maskedReference: data.newAccount.maskedReference });
    accounts.push({ id: data.manifest.accountId, householdId: hh, name: data.newAccount.name, kind: "credit_card", currency: "INR", maskedReference: data.newAccount.maskedReference, institutionId: null, openedOn: null, closedOn: null });
  }
  if (data.facility.newFacility) await tx.insert(f.creditFacilities).values({ id: data.facility.id, householdId: hh, name: data.facility.newFacility.name, currency: "INR" });

  const ledgers = await tx.select().from(f.ledgerAccounts).where(eq(f.ledgerAccounts.householdId, hh));
  const newLedgers: (typeof f.ledgerAccounts.$inferInsert)[] = [];
  function ledger(accountId: string | null, kind: "asset" | "liability" | "expense" | "equity") {
    const code = accountId ? `account:${accountId}` : `card:${kind}:INR`;
    const existing = ledgers.find(row => row.code === code) ?? newLedgers.find(row => row.code === code);
    if (existing) { if (existing.kind !== kind || existing.currency !== "INR") fail("Ledger account identity does not match this import."); return existing.id!; }
    const id = randomUUID(); newLedgers.push({ id, householdId: hh, accountId, kind, currency: "INR", code }); return id;
  }
  const cardLedger = ledger(data.manifest.accountId, "liability"), expenseLedger = ledger(null, "expense"), equityLedger = ledger(null, "equity");
  const categories = await tx.select().from(f.categories).where(eq(f.categories.householdId, hh));
  const targetIds = [...new Set(data.rows.flatMap(row => data.decisions[row.row_id]!.eventId ? [data.decisions[row.row_id]!.eventId!] : []))];
  const targets = targetIds.length ? await tx.select().from(f.events).where(and(eq(f.events.householdId, hh), inArray(f.events.id, targetIds))) : [];
  const targetLegs = targetIds.length ? await tx.select().from(f.postings).where(and(eq(f.postings.householdId, hh), inArray(f.postings.eventId, targetIds))) : [];
  const reversals = targetIds.length ? await tx.select().from(f.events).where(and(eq(f.events.householdId, hh), inArray(f.events.reversesId, targetIds))) : [];
  const batchId = randomUUID(), nextRevision = revision + 1;
  const sources: (typeof f.sourceRecords.$inferInsert)[] = [], eventRows: (typeof f.events.$inferInsert)[] = [], postingRows: (typeof f.postings.$inferInsert)[] = [], sourceLinks: (typeof f.sourceLinks.$inferInsert)[] = [];
  const affected = new Set([data.manifest.accountId]);
  for (const [index, row] of data.rows.entries()) {
    const decision = data.decisions[row.row_id]!, sourceId = randomUUID();
    sources.push({ id: sourceId, householdId: hh, batchId, rowNumber: index + 1, providerReference: row.transaction_ref || null, rowHash: fingerprint(row), payload: { ...submitted.rows[index]!, review: JSON.stringify(decision) } });
    const target = targets.find(event => event.id === decision.eventId), originalLegs = targetLegs.filter(posting => posting.eventId === target?.id);
    if (decision.eventId && (!target || target.state !== "confirmed" || target.kind === "reversal" || reversals.some(event => event.reversesId === target.id))) fail(`Row ${row.row_id}: selected event is unavailable or reversed.`, 409);
    if (target) {
      const accountLeg = originalLegs.find(posting => ledgers.some(item => item.id === posting.ledgerAccountId && item.accountId === data.manifest.accountId));
      if (!accountLeg) fail("Selected event does not belong to this card.");
      if (decision.action === "link") {
        const signed = decimal(row.amount).mul(row.direction === "debit" ? -1 : 1);
        if (target.kind !== ledgerEventKind(row) || target.effectiveDate !== row.transaction_date || accountLeg.currency !== "INR" || !decimal(accountLeg.nativeAmount).eq(signed) || !decimal(accountLeg.bookAmountInr).eq(signed)) fail(`Row ${row.row_id}: linked event date, type and amount must agree.`);
        const category = originalLegs.find(posting => posting.categoryId)?.categoryId;
        if ((categories.find(item => item.id === category)?.code ?? "") !== row.category) fail("Linking cannot change a category. Use a reviewed replacement.");
        sourceLinks.push({ householdId: hh, eventId: target.id, sourceId }); continue;
      }
      if (target.effectiveDate < data.manifest.coverageStart || target.effectiveDate > data.manifest.coverageEnd) fail("Correction coverage must include the original event date.");
      const reversalId = randomUUID();
      eventRows.push({ id: reversalId, householdId: hh, batchId, kind: "reversal", effectiveDate: target.effectiveDate, reversesId: target.id, quality: target.quality, reviewNote: decision.note });
      sourceLinks.push({ householdId: hh, eventId: reversalId, sourceId });
      for (const leg of originalLegs) {
        postingRows.push({ householdId: hh, eventId: reversalId, lineNumber: leg.lineNumber, ledgerAccountId: leg.ledgerAccountId, nativeAmount: decimal(leg.nativeAmount).neg().toFixed(), bookAmountInr: decimal(leg.bookAmountInr).neg().toFixed(), currency: leg.currency, categoryId: leg.categoryId, counterpartyId: leg.counterpartyId });
        const accountId = ledgers.find(item => item.id === leg.ledgerAccountId)?.accountId; if (accountId) affected.add(accountId);
      }
    }
    let offset = expenseLedger, offsetKind: "expense" | "asset" = "expense";
    if (row.event_type === "card_repayment") {
      const bank = accounts.find(account => account.id === decision.offsetAccountId && account.id !== data.manifest.accountId && !account.closedOn && ["bank", "cash"].includes(account.kind) && account.currency === "INR");
      if (!bank) fail(`Row ${row.row_id}: select an open INR bank account for repayment.`);
      offset = ledger(bank.id, "asset"); offsetKind = "asset"; affected.add(bank.id);
    }
    const built = cardPostings(row, { cardAccount: cardLedger, offsetAccount: offset, offsetKind });
    const eventId = randomUUID();
    eventRows.push({ id: eventId, householdId: hh, batchId, kind: ledgerEventKind(row), effectiveDate: row.transaction_date, quality: "complete", reviewNote: decision.note || null, replacesId: decision.action === "replace" ? target!.id : null });
    sourceLinks.push({ householdId: hh, eventId, sourceId });
    for (const [i, leg] of built.legs.entries()) {
      const category = leg.category ? categories.find(item => item.code === leg.category && !item.archived && item.kind === leg.kind) : null;
      if (leg.category && !category) fail("Category is unavailable. Review the row again.");
      postingRows.push({ householdId: hh, eventId, lineNumber: i + 1, ledgerAccountId: leg.account, nativeAmount: leg.nativeAmount, bookAmountInr: leg.bookAmountInr, currency: leg.currency, categoryId: category?.id ?? null });
    }
  }
  const observations: (typeof f.observations.$inferInsert)[] = [];
  for (const kind of ["opening", "closing"] as const) {
    const value = kind === "opening" ? data.manifest.openingOutstanding : data.manifest.statementOutstanding;
    const sourceId = randomUUID(), asOf = kind === "opening" ? data.manifest.coverageStart : data.manifest.coverageEnd;
    sources.push({ id: sourceId, householdId: hh, batchId, rowNumber: sources.length + 1, rowHash: hash([kind, asOf, value]), payload: { kind, as_of: asOf, outstanding: value ?? "", unknown_reason: value === null ? data.manifest.historyReason || "Statement outstanding not supplied." : "" } });
    observations.push({ id: randomUUID(), householdId: hh, sourceId, accountId: data.manifest.accountId, kind, asOf, balance: value, currency: "INR", unknownReason: value === null ? data.manifest.historyReason || "Statement outstanding not supplied." : null });
  }
  if (data.openingDecision.action === "establish" && data.manifest.openingOutstanding !== null) {
    const source = observations[0]!.sourceId, built = cardOpeningPostings(data.manifest.openingOutstanding, { cardAccount: cardLedger, equityAccount: equityLedger, reviewed: true });
    if (built.legs.length) {
      const eventId = randomUUID(); eventRows.push({ id: eventId, householdId: hh, batchId, kind: "opening_balance", effectiveDate: data.manifest.coverageStart, quality: built.quality, reviewNote: data.openingDecision.note });
      sourceLinks.push({ householdId: hh, eventId, sourceId: source });
      built.legs.forEach((leg, i) => postingRows.push({ householdId: hh, eventId, lineNumber: i + 1, ledgerAccountId: leg.account, nativeAmount: leg.nativeAmount, bookAmountInr: leg.bookAmountInr, currency: leg.currency }));
    }
  }

  await tx.insert(f.batches).values({ id: batchId, householdId: hh, accountId: data.manifest.accountId, schemaVersion: "card-v1", idempotencyKey: data.idempotencyKey, contentHash, coverageStart: data.manifest.coverageStart, coverageEnd: data.manifest.coverageEnd, completeness: data.manifest.completeness, rowCount: sources.length, requestBytes, revision: nextRevision, reviewedBy: actor.userId });
  await tx.update(f.revisions).set({ revision: nextRevision }).where(eq(f.revisions.householdId, hh));
  const dates = [...new Set([data.manifest.coverageStart, data.manifest.coverageEnd, ...(data.manifest.paymentDueDate ? [data.manifest.paymentDueDate] : []), ...eventRows.map(event => event.effectiveDate)])].map(calendarDate);
  for (let i = 0; i < dates.length; i += 250) await tx.insert(f.dates).values(dates.slice(i, i + 250)).onConflictDoNothing();
  if (newLedgers.length) await tx.insert(f.ledgerAccounts).values(newLedgers);
  for (let i = 0; i < sources.length; i += 250) await tx.insert(f.sourceRecords).values(sources.slice(i, i + 250));
  for (let i = 0; i < eventRows.length; i += 250) await tx.insert(f.events).values(eventRows.slice(i, i + 250));
  for (let i = 0; i < postingRows.length; i += 250) await tx.insert(f.postings).values(postingRows.slice(i, i + 250));
  for (let i = 0; i < sourceLinks.length; i += 250) await tx.insert(f.sourceLinks).values(sourceLinks.slice(i, i + 250));
  if (eventRows.length) await tx.update(f.events).set({ state: "confirmed" }).where(and(eq(f.events.householdId, hh), eq(f.events.batchId, batchId)));
  await tx.insert(f.observations).values(observations);
  const rec = review.reconciliation;
  await tx.insert(f.reconciliations).values({ householdId: hh, observationId: observations[1]!.id!, revision: nextRevision, status: rec.status, calculatedBalance: rec.calculated, difference: rec.difference, explanation: rec.reason });
  const evidenceSource = observations[1]!.sourceId;
  await tx.insert(f.creditFacilityTerms).values({ householdId: hh, facilityId: data.facility.id, sourceId: evidenceSource, effectiveDate: data.manifest.coverageStart, limitInr: data.facility.limitInr });
  await tx.insert(f.accountFacilityLinks).values({ householdId: hh, accountId: data.manifest.accountId, facilityId: data.facility.id, sourceId: evidenceSource, effectiveDate: data.manifest.coverageStart });
  await tx.insert(f.cardStatements).values({ householdId: hh, observationId: observations[1]!.id!, paymentDueDate: data.manifest.paymentDueDate, minimumDue: data.manifest.minimumDue });
  await tx.insert(f.outbox).values({ householdId: hh, batchId, revision: nextRevision });
  await tx.insert(f.rebuilds).values([...affected].map(accountId => ({ householdId: hh, batchId, accountId, earliestDate: data.manifest.coverageStart, revision: nextRevision, cause: "card_import" })));
  return { batchId, revision: nextRevision, retry: false, state: "committed" };
}
