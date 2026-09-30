import "server-only";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/auth/connection";
import { workerTransaction } from "./connection";
import { sendWorkIntent } from "@/lib/workflows/send";
import { workIntentSchema, type WorkIntent } from "@/lib/workflows/events";
type Claim = { outbox_id: string; household_id: string; batch_id: string; revision: number; lease_token: string };
export async function dispatchPending(options: { database?: Database; send?: (intent: WorkIntent) => Promise<void>; householdId?: string; maximum?: number } = {}) {
  const maximum = options.maximum ?? 5;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 5) throw new Error("Dispatch limit must be 1–5.");
  // One at a time: each 8s send plus bounded SQL stays inside the 60s invocation budget.
  let sent = 0, failed = 0;
  const startDeadline = Date.now() + 15_000;
  for (let i = 0; i < maximum && Date.now() < startDeadline; i++) {
    const claims = await workerTransaction(tx => tx.execute<Claim>(sql`select * from ops.claim_deliveries(1,${options.householdId ?? null}::uuid)`), options.database);
    const claim = claims.rows[0]; if (!claim) break;
    const intent = workIntentSchema.parse({ outboxId: claim.outbox_id, householdId: claim.household_id, batchId: claim.batch_id, revision: claim.revision });
    let succeeded = false;
    try { await (options.send ?? sendWorkIntent)(intent); succeeded = true; sent++; } catch { failed++; }
    await workerTransaction(tx => tx.execute(sql`select ops.finish_delivery(${claim.outbox_id}::uuid,${claim.lease_token}::uuid,${succeeded})`), options.database);
  }
  return { sent, failed };
}
export async function acceptDelivery(input: unknown, database?: Database) {
  const intent = workIntentSchema.parse(input);
  await workerTransaction(tx => tx.execute(sql`select ops.accept_delivery(${intent.outboxId}::uuid,${intent.householdId}::uuid,${intent.batchId}::uuid,${intent.revision})`), database);
  return { state: "received" as const, outboxId: intent.outboxId };
}
