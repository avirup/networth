import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Transaction } from "@/db/auth/connection";
import type { Actor } from "@/db/auth/service";
import { AccessError } from "@/lib/auth/errors";
import { FINANCIAL_SCHEMA } from "@/lib/config/policy";
import { economicDate } from "@/lib/finance/decimal";
import { BANK_CALCULATION_PAGE_SIZE, calculateBankPage, type BankCalculationEvent, type BankCalculationLeg } from "@/lib/finance/bank-calculation";

const inputSchema = z.object({ runId: z.uuid(), asOf: z.string(), cursor: z.object({ date: z.string(), eventId: z.uuid() }).strict().optional() }).strict();
type Header = Omit<BankCalculationEvent, "legs">;

// Internal read-only diagnostic path through an authenticated membership transaction.
// It does not grant financial-table access to the worker or publish a report.
export async function readBankCalculationPage(tx: Transaction, actor: Actor, input: unknown) {
  if (actor.schemaVersion !== FINANCIAL_SCHEMA) throw new AccessError(503, "The installation needs an administrator upgrade.");
  const request = inputSchema.parse(input);
  economicDate(request.asOf);
  if (request.cursor) economicDate(request.cursor.date);
  const hh = actor.householdId;
  const run = (await tx.execute<{ source_revision: number; state: string }>(sql`
    select source_revision,state from ops.calculation_run
    where id=${request.runId}::uuid and household_id=${hh}::uuid and core.member_role(${hh}::uuid) is not null
  `)).rows[0];
  if (!run) throw new AccessError(404, "Calculation not found.");
  if (run.state !== "prepared") throw new AccessError(409, "Account planning is incomplete.");
  const after = request.cursor ? sql`and (e.effective_date,e.id)>(${request.cursor.date}::date,${request.cursor.eventId}::uuid)` : sql``;
  const headers = (await tx.execute<Header>(sql`
    select e.id,e.household_id as "householdId",b.revision,e.effective_date::text as "effectiveDate",
      e.kind,e.quality,original.kind as "reversedKind"
    from core.transaction_event e
    join core.import_batch b on b.id=e.batch_id and b.household_id=e.household_id
    left join core.transaction_event original on original.id=e.reverses_id and original.household_id=e.household_id
    where e.household_id=${hh}::uuid and e.state='confirmed' and b.revision<=${run.source_revision}
      and e.effective_date<=${request.asOf}::date ${after}
      and exists(select from core.fact_posting p join core.ledger_account l on l.id=p.ledger_account_id and l.household_id=p.household_id
        join ops.calculation_account a on a.account_id=l.account_id and a.household_id=l.household_id
        where p.event_id=e.id and p.household_id=e.household_id and a.run_id=${request.runId}::uuid)
    order by e.effective_date,e.id limit ${BANK_CALCULATION_PAGE_SIZE + 1}
  `)).rows;
  const selected = headers.slice(0, BANK_CALCULATION_PAGE_SIZE);
  const legs = selected.length ? (await tx.execute<BankCalculationLeg & { eventId: string }>(sql`
    select p.id,p.event_id as "eventId",p.ledger_account_id as "ledgerAccountId",l.account_id as "accountId",l.kind,
      p.currency,p.native_amount::text as "nativeAmount",p.book_amount_inr::text as "bookAmountInr",p.category_id as "categoryId"
    from core.fact_posting p join core.ledger_account l on l.id=p.ledger_account_id and l.household_id=p.household_id
    where p.household_id=${hh}::uuid and p.event_id in (${sql.join(selected.map(e => sql`${e.id}::uuid`), sql`,`)})
    order by p.event_id,p.line_number,p.id limit ${2 * BANK_CALCULATION_PAGE_SIZE + 1}
  `)).rows : [];
  if (legs.length > 2 * BANK_CALCULATION_PAGE_SIZE) throw new AccessError(409, "This page needs a financial rule for additional posting components.");
  const grouped = new Map<string, BankCalculationLeg[]>();
  for (const { eventId, ...leg } of legs) grouped.set(eventId, [...(grouped.get(eventId) ?? []), leg]);
  const events = selected.map(event => ({ ...event, legs: grouped.get(event.id) ?? [] }));
  const context = { householdId: hh, sourceRevision: run.source_revision, asOf: request.asOf };
  // Validate all source evidence before returning any partial contribution page.
  const calculation = calculateBankPage(context, events);
  const last = selected.at(-1);
  const nextCursor = headers.length > BANK_CALCULATION_PAGE_SIZE && last ? { date: last.effectiveDate, eventId: last.id } : null;
  const result = { runId: request.runId, context, events, calculation, nextCursor };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 3_000_000) throw new AccessError(413, "Calculation page exceeds the response budget.");
  return result;
}
