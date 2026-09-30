import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db/auth/connection";
import { workerTransaction } from "@/db/workflows/connection";
import { failPlanningAttempt } from "@/db/workflows/planning";
import { AccessError } from "@/lib/auth/errors";
import { economicDate } from "@/lib/finance/decimal";
import { calculateBankPage, type BankCalculationContext, type BankCalculationEvent } from "@/lib/finance/bank-calculation";
export type BankCandidate = { run_id: string; household_id: string; generation_id: string; as_of: string; rule_version: "bank-movements-v1"; state: "building" | "calculated"; page: number; cursor_date: string | null; cursor_id: string | null; event_count: number };
export type BankClaim = { status: "claimed"; token: string; candidate: BankCandidate } | { status: "unchanged"; candidate: BankCandidate } | { status: "busy"; candidate: BankCandidate } | { status: "paused"; reason: string; candidate: BankCandidate };
const scope = z.object({ runId: z.uuid(), householdId: z.uuid() });
const attempt = scope.extend({ token: z.uuid() }).strict();
export async function beginBankCandidate(input: unknown, database?: Database) {
  const request = scope.extend({ asOf: z.string() }).strict().parse(input);
  economicDate(request.asOf);
  return (await workerTransaction(tx => tx.execute<{ candidate: BankCandidate }>(sql`select to_jsonb(c) as candidate from ops.begin_bank_candidate(${request.runId}::uuid,${request.householdId}::uuid,${request.asOf}::date) c`), database)).rows[0]!.candidate;
}
export async function claimBankAttempt(input: unknown, database?: Database) {
  const request = scope.extend({ page: z.number().int().min(0).max(2147483647) }).strict().parse(input);
  return (await workerTransaction(tx => tx.execute<{ claim: BankClaim }>(sql`select ops.claim_bank_attempt(${request.runId}::uuid,${request.householdId}::uuid,${request.page}) as claim`), database)).rows[0]!.claim;
}
export async function readBankWorkerInput(input: unknown, database?: Database) {
  const request = attempt.parse(input);
  return (await workerTransaction(tx => tx.execute<{ input: { context: BankCalculationContext; events: BankCalculationEvent[]; hasMore: boolean; lastCursor: { date: string; eventId: string } | null } }>(sql`select ops.bank_page_input(${request.runId}::uuid,${request.householdId}::uuid,${request.token}::uuid) as input`), database)).rows[0]!.input;
}
export async function commitBankPage(input: unknown, result: ReturnType<typeof calculateBankPage>, database?: Database) {
  const request = attempt.parse(input), serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, "utf8") > 3_000_000) throw new AccessError(413, "Bank result exceeds the response budget.");
  return (await workerTransaction(tx => tx.execute<{ candidate: BankCandidate }>(sql`select to_jsonb(c) as candidate from ops.commit_bank_page(${request.runId}::uuid,${request.householdId}::uuid,${request.token}::uuid,${serialized}::jsonb) c`), database)).rows[0]!.candidate;
}
// One bounded, explicitly invoked page. No idle loop, hidden retry or Inngest scheduling.
export async function advanceBankCandidate(input: unknown, database?: Database) {
  const claim = await claimBankAttempt(input, database);
  if (claim.status === "unchanged") return claim.candidate;
  if (claim.status === "busy") throw new AccessError(409, "Bank calculation is already running.");
  if (claim.status === "paused") throw new AccessError(503, `Bank calculation paused: ${claim.reason}.`);
  const request = { runId: claim.candidate.run_id, householdId: claim.candidate.household_id, token: claim.token };
  try {
    const source = await readBankWorkerInput(request, database);
    return await commitBankPage(request, calculateBankPage(source.context, source.events), database);
  } catch {
    try { await failPlanningAttempt(request, database); } catch { /* Durable lease expiry retains usage. */ }
    throw new AccessError(503, "Bank calculation failed; its checkpoint is preserved.");
  }
}
