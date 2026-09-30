import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db/auth/connection";
import { workerTransaction } from "@/db/workflows/connection";
import { failPlanningAttempt } from "@/db/workflows/planning";
import { AccessError } from "@/lib/auth/errors";
import { calculateBankBalance, type BankBalanceInput } from "@/lib/finance/bank-balance";
import { bankBalanceMovements, type BankBalancePosting } from "@/lib/finance/bank-balance-source";

export type BalanceCandidate = { run_id: string; household_id: string; generation_id: string; state: "building" | "calculated"; page: number; cursor_account_id: string | null };
type BalanceClaim = { status: "claimed"; token: string; candidate: BalanceCandidate } | { status: "busy"; candidate: BalanceCandidate } | { status: "unchanged"; candidate: BalanceCandidate } | { status: "paused"; reason: string; candidate: BalanceCandidate };
export type BalanceSource = { scope: BankBalanceInput["scope"]; postings: BankBalancePosting[]; batches: { id: string; start: string; end: string; completeness: "complete" | "partial" | "balance_only"; supported: boolean }[]; closing: BankBalanceInput["closing"] };
const scope = z.object({ runId: z.uuid(), householdId: z.uuid() });
const attempt = scope.extend({ token: z.uuid() }).strict();
export async function claimBalanceAttempt(input: unknown, database?: Database) {
  const request = scope.extend({ page: z.number().int().min(0).max(2147483647) }).strict().parse(input);
  return (await workerTransaction(tx => tx.execute<{ claim: BalanceClaim }>(sql`select ops.claim_bank_balance_attempt(${request.runId}::uuid,${request.householdId}::uuid,${request.page}) as claim`), database)).rows[0]!.claim;
}
export async function readBalanceWorkerInput(input: unknown, database?: Database) {
  const request = attempt.parse(input);
  return (await workerTransaction(tx => tx.execute<{ input: BalanceSource | null }>(sql`select ops.bank_balance_input(${request.runId}::uuid,${request.householdId}::uuid,${request.token}::uuid) as input`), database)).rows[0]!.input;
}
export function evaluateBalanceSource(source: BalanceSource | null) {
  if (!source) return null;
  return calculateBankBalance({ scope: source.scope, ...bankBalanceMovements(source.scope, source.postings), closing: source.closing,
    coverage: source.batches.map(b => ({ evidenceId: b.id, start: b.start, end: b.end, completeness: b.completeness === "complete" && !b.supported ? "partial" : b.completeness })) });
}
export async function commitBalance(input: unknown, result: ReturnType<typeof evaluateBalanceSource>, database?: Database) {
  const request = attempt.parse(input), serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, "utf8") > 3_000_000) throw new AccessError(413, "Balance result exceeds the response budget.");
  return (await workerTransaction(tx => tx.execute<{ candidate: BalanceCandidate }>(sql`select to_jsonb(c) as candidate from ops.commit_bank_balance(${request.runId}::uuid,${request.householdId}::uuid,${request.token}::uuid,${serialized}::jsonb) c`), database)).rows[0]!.candidate;
}
// One reserved account step; retries and owner resume retain the shared usage budget.
export async function advanceBalanceCandidate(input: unknown, database?: Database) {
  const claim = await claimBalanceAttempt(input, database);
  if (claim.status === "unchanged") return claim.candidate;
  if (claim.status === "busy") throw new AccessError(409, "Balance calculation is already running.");
  if (claim.status === "paused") throw new AccessError(503, `Balance calculation paused: ${claim.reason}.`);
  const request = { runId: claim.candidate.run_id, householdId: claim.candidate.household_id, token: claim.token };
  try { return await commitBalance(request, evaluateBalanceSource(await readBalanceWorkerInput(request, database)), database); }
  catch {
    try { await failPlanningAttempt(request, database); } catch { /* Expiry retains the reserved usage. */ }
    throw new AccessError(503, "Balance calculation failed; its checkpoint is preserved.");
  }
}
