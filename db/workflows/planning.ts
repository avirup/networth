import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { AccessError } from "@/lib/auth/errors";
import type { Database } from "@/db/auth/connection";
import { workerTransaction } from "./connection";
import { workIntentSchema } from "@/lib/workflows/events";

export type CalculationPlan = {
  id: string;
  household_id: string;
  source_revision: number;
  rule_version: "bank-plan-v1";
  state: "planning" | "prepared" | "superseded";
  page: number;
  cursor_revision: number;
  cursor_id: string;
};

// Internal preparation primitives. Not scheduled until metered execution admission exists.
// A prepared plan contains dirty ranges, not financial results or a published release.
export async function beginCalculationPlan(input: unknown, database?: Database) {
  const intent = workIntentSchema.parse(input);
  const result = await workerTransaction(tx => tx.execute<CalculationPlan>(sql`
    select * from ops.begin_calculation_plan(${intent.outboxId}::uuid,${intent.householdId}::uuid,${intent.batchId}::uuid,${intent.revision})
  `), database);
  return result.rows[0]!;
}

const checkpointSchema = z.object({ runId: z.uuid(), householdId: z.uuid(), page: z.number().int().min(0).max(2147483647) }).strict();
export type PlanningClaim =
  | { status: "claimed"; token: string; plan: CalculationPlan }
  | { status: "unchanged"; plan: CalculationPlan }
  | { status: "busy"; plan: CalculationPlan }
  | { status: "paused"; reason: "capacity" | "retry_limit" | "window_limit"; plan: CalculationPlan };

export async function claimPlanningAttempt(input: unknown, database?: Database): Promise<PlanningClaim> {
  const checkpoint = checkpointSchema.parse(input);
  const result = await workerTransaction(tx => tx.execute<{ claim: PlanningClaim }>(sql`
    select ops.claim_planning_attempt(${checkpoint.runId}::uuid,${checkpoint.householdId}::uuid,${checkpoint.page}) as claim
  `), database);
  return result.rows[0]!.claim;
}

const attemptSchema = z.object({ runId: z.uuid(), householdId: z.uuid(), token: z.uuid() }).strict();
export async function finishPlanningAttempt(input: unknown, database?: Database) {
  const attempt = attemptSchema.parse(input);
  const result = await workerTransaction(tx => tx.execute<CalculationPlan>(sql`
    select * from ops.finish_planning_attempt(${attempt.runId}::uuid,${attempt.householdId}::uuid,${attempt.token}::uuid)
  `), database);
  return result.rows[0]!;
}

export async function failPlanningAttempt(input: unknown, database?: Database) {
  const attempt = attemptSchema.parse(input);
  const result = await workerTransaction(tx => tx.execute<{ released: boolean }>(sql`
    select ops.fail_planning_attempt(${attempt.runId}::uuid,${attempt.householdId}::uuid,${attempt.token}::uuid) as released
  `), database);
  return result.rows[0]!.released;
}

export async function advanceCalculationPlan(input: unknown, database?: Database) {
  const checkpoint = checkpointSchema.parse(input);
  // Reserve and commit usage before entering the transaction that can fail or time out.
  const claim = await claimPlanningAttempt(checkpoint, database);
  if (claim.status === "unchanged") return claim.plan;
  if (claim.status === "busy") throw new AccessError(409, "Calculation planning is already running.");
  if (claim.status === "paused") throw new AccessError(503, `Calculation paused: ${claim.reason}.`);
  const attempt = { runId: checkpoint.runId, householdId: checkpoint.householdId, token: claim.token };
  try { return await finishPlanningAttempt(attempt, database); }
  catch {
    // Failure keeps the usage charge. A failed release is recovered by lease expiry.
    try { await failPlanningAttempt(attempt, database); } catch { /* Expiring claim remains durable. */ }
    throw new AccessError(503, "Calculation planning failed; its checkpoint is preserved.");
  }
}
