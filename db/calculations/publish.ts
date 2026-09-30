import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/db/auth/connection";
import { workerTransaction } from "@/db/workflows/connection";
const request = z.object({ runId: z.uuid(), householdId: z.uuid() }).strict();
export type WorkflowSnapshot = {
  plan: { id: string; household_id: string; state: "planning" | "prepared" | "superseded"; page: number };
  asOf: string;
  bank: { state: "building" | "calculated"; page: number } | null;
  balance: { state: "building" | "calculated"; page: number } | null;
  releaseId: string | null;
};
export async function readWorkflowSnapshot(input: unknown, database?: Database) {
  const parsed = request.parse(input);
  return (await workerTransaction(tx => tx.execute<{ snapshot: WorkflowSnapshot }>(sql`select ops.calculation_workflow_snapshot(${parsed.runId}::uuid,${parsed.householdId}::uuid) snapshot`), database)).rows[0]!.snapshot;
}
export async function publishBankRelease(input: unknown, database?: Database) {
  const parsed = request.parse(input);
  return (await workerTransaction(tx => tx.execute<{ release: string | null }>(sql`select ops.publish_bank_release(${parsed.runId}::uuid,${parsed.householdId}::uuid) release`), database)).rows[0]!.release;
}
export async function cleanupDerivedReports(database?: Database) {
  return (await workerTransaction(tx => tx.execute<{ cleaned: number }>(sql`select ops.cleanup_derived_reports() cleaned`), database)).rows[0]!.cleaned;
}
