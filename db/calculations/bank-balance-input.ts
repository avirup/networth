import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Transaction } from "@/db/auth/connection";
import type { Actor } from "@/db/auth/service";
import { AccessError } from "@/lib/auth/errors";
import { FINANCIAL_SCHEMA } from "@/lib/config/policy";
import { economicDate } from "@/lib/finance/decimal";
import { calculateBankBalance, BANK_BALANCE_WINDOW_LIMIT, type BankBalanceInput } from "@/lib/finance/bank-balance";
import { bankBalanceMovements, BANK_BALANCE_POSTING_LIMIT, type BankBalancePosting } from "@/lib/finance/bank-balance-source";

// Initial backfill diagnostic only. This is not an incremental reporting API.
const requestSchema = z.object({ runId: z.uuid(), accountId: z.uuid(), asOf: z.string() }).strict();
type Batch = { id: string; start: string; end: string; completeness: BankBalanceInput["coverage"][number]["completeness"]; supported: boolean };

/** Internal read-only evaluation under an authenticated membership transaction.
 * Reads complete bounded evidence, never private candidate facts or a partial page.
 * No HTTP route, financial writes, worker privilege or workflow scheduling. */
export async function readBankBalanceInput(tx: Transaction, actor: Actor, input: unknown) {
  if (actor.schemaVersion !== FINANCIAL_SCHEMA) throw new AccessError(503, "The installation needs an administrator upgrade.");
  const request = requestSchema.parse(input);
  economicDate(request.asOf);
  const hh = actor.householdId;
  const run = (await tx.execute<{ sourceRevision: number; state: string; currency: string }>(sql`
    select r.source_revision as "sourceRevision",r.state,a.currency
    from ops.calculation_run r
    join ops.calculation_account p on p.run_id=r.id and p.household_id=r.household_id
    join core.dim_account a on a.id=p.account_id and a.household_id=p.household_id
    where r.id=${request.runId}::uuid and r.household_id=${hh}::uuid
      and a.id=${request.accountId}::uuid and a.kind in ('bank','cash')
      and core.member_role(${hh}::uuid) is not null
  `)).rows[0];
  if (!run) throw new AccessError(404, "Bank calculation account not found.");
  if (run.state !== "prepared") throw new AccessError(409, "Account planning is incomplete.");
  // Capture provenance before aggregation. One asset posting per event/account is
  // required; opposite-side links never multiply the authoritative posting stream.
  const postings = (await tx.execute<BankBalancePosting>(sql`
    select p.id,e.id as "eventId",e.effective_date::text as date,e.kind,original.kind as "originalKind",
      e.quality,p.native_amount::text as native,p.book_amount_inr::text as book,p.currency,
      nullif(btrim(e.review_note),'') is not null as reviewed,
      exists(select from core.transaction_event reversal
        join core.import_batch rb on rb.id=reversal.batch_id and rb.household_id=reversal.household_id
        where reversal.household_id=e.household_id and reversal.reverses_id=e.id
          and rb.revision<=${run.sourceRevision} and reversal.effective_date<=${request.asOf}::date) as reversed
    from core.fact_posting p
    join core.ledger_account l on l.id=p.ledger_account_id and l.household_id=p.household_id
    join core.transaction_event e on e.id=p.event_id and e.household_id=p.household_id
    join core.import_batch b on b.id=e.batch_id and b.household_id=e.household_id
    left join core.transaction_event original on original.id=e.reverses_id and original.household_id=e.household_id
    where p.household_id=${hh}::uuid and l.account_id=${request.accountId}::uuid
      and l.kind='asset' and e.state='confirmed' and b.revision<=${run.sourceRevision}
      and e.effective_date<=${request.asOf}::date
    order by e.effective_date,e.id,p.id limit ${BANK_BALANCE_POSTING_LIMIT + 1}
  `)).rows;
  if (postings.length > BANK_BALANCE_POSTING_LIMIT) throw new AccessError(413, "Balance evidence requires persisted checkpoint boundaries; no partial result was calculated.");
  const batches = (await tx.execute<Batch>(sql`
    select b.id,b.coverage_start::text as start,b.coverage_end::text as end,b.completeness,
      -- An import-time match alone is insufficient after its linked events change.
      exists(select from core.fact_statement_observation o
        join core.source_record s on s.id=o.source_id and s.household_id=o.household_id
        join core.reconciliation_result rr on rr.observation_id=o.id and rr.household_id=o.household_id
        where s.batch_id=b.id and s.household_id=b.household_id and o.account_id=b.account_id and o.currency=${run.currency} and o.kind='closing'
          and rr.revision=b.revision and rr.status='matched')
      and not exists(select from core.source_record s
        join core.event_source_link link on link.source_id=s.id and link.household_id=s.household_id
        join core.transaction_event e on e.id=link.event_id and e.household_id=link.household_id
        where s.batch_id=b.id and s.household_id=b.household_id
          and (e.kind='reversal' or (e.batch_id=b.id and e.replaces_id is not null) or exists(
            select from core.transaction_event reversal
            join core.import_batch rb on rb.id=reversal.batch_id and rb.household_id=reversal.household_id
            where reversal.household_id=e.household_id and reversal.reverses_id=e.id
              and rb.revision<=${run.sourceRevision} and reversal.effective_date<=${request.asOf}::date))) as supported
    from core.import_batch b
    where b.household_id=${hh}::uuid and b.account_id=${request.accountId}::uuid
      and b.revision<=${run.sourceRevision} and b.coverage_start<=${request.asOf}::date
    order by b.coverage_start,b.id limit ${BANK_BALANCE_WINDOW_LIMIT + 1}
  `)).rows;
  if (batches.length > BANK_BALANCE_WINDOW_LIMIT) throw new AccessError(413, "Balance coverage exceeds the bounded evidence window.");
  const start = [request.asOf, ...postings.map(row => row.date), ...batches.map(row => row.start)].sort()[0]!;
  const closing = (await tx.execute<BankBalanceInput["closing"][number]>(sql`
    select o.id as "evidenceId",o.as_of::text as date,o.balance::text as balance
    from core.fact_statement_observation o
    join core.source_record s on s.id=o.source_id and s.household_id=o.household_id
    join core.import_batch b on b.id=s.batch_id and b.household_id=s.household_id
    where o.household_id=${hh}::uuid and o.account_id=${request.accountId}::uuid and o.currency=${run.currency}
      and o.kind='closing' and o.as_of=${request.asOf}::date and b.revision<=${run.sourceRevision}
    order by o.id limit ${BANK_BALANCE_WINDOW_LIMIT + 1}
  `)).rows;
  if (closing.length > BANK_BALANCE_WINDOW_LIMIT) throw new AccessError(413, "Closing evidence exceeds the bounded evidence window.");
  let movements: ReturnType<typeof bankBalanceMovements>;
  try { movements = bankBalanceMovements({ accountId: request.accountId, currency: run.currency, start }, postings); }
  catch { throw new AccessError(409, "Balance evidence needs a supported rule or persisted checkpoint boundary."); }
  const evidence: BankBalanceInput = {
    scope: { householdId: hh, sourceRevision: run.sourceRevision, accountId: request.accountId, currency: run.currency, start, asOf: request.asOf },
    ...movements,
    coverage: batches.map(b => ({ evidenceId: b.id, start: b.start, end: b.end, completeness: b.completeness === "complete" && !b.supported ? "partial" : b.completeness })),
    closing,
  };
  const result = { runId: request.runId, evidence, calculation: calculateBankBalance(evidence) };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 3_000_000) throw new AccessError(413, "Balance evidence exceeds the response budget.");
  return result;
}
