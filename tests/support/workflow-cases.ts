import { afterAll, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { dispatchPending, acceptDelivery } from "@/db/workflows/dispatch";
import { workerTransaction } from "@/db/workflows/connection";
import type { IdentityService } from "@/db/auth/service";
import type { WorkIntent } from "@/lib/workflows/events";
export function workflowCases(admin: Pool, service: IdentityService, household: () => string) {
  const url = new URL(process.env.TEST_DATABASE_URL!); url.username = "networth_test_worker"; url.password = "synthetic-worker-test-only";
  const pool = new Pool({ connectionString: url.toString(), max: 3 }), db = drizzle(pool);
  const run = <T>(work: Parameters<typeof workerTransaction<T>>[0]) => workerTransaction(work, db);
  let intent: WorkIntent, reference: string;
  afterAll(() => pool.end());
  it("provisions delivery rows atomically and restricts workers to operational functions", async () => {
    await admin.query("do $$ begin if not exists(select from pg_roles where rolname='networth_test_worker') then create role networth_test_worker login password 'synthetic-worker-test-only' noinherit nosuperuser nocreatedb nocreaterole nobypassrls; end if; end $$");
    await admin.query("grant networth_worker to networth_test_worker with inherit false");
    const count = (await admin.query("select (select count(*) from ops.workflow_delivery)=(select count(*) from ops.outbox_event) equal")).rows[0].equal;
    expect(count).toBe(true);
    await expect(run(tx => tx.execute(sql`select * from core.auth_user`))).rejects.toThrow();
    await expect(run(tx => tx.execute(sql`select * from core.fact_posting`))).rejects.toThrow();
    await expect(run(tx => tx.execute(sql`update ops.import_admission set workflow_verified=true`))).rejects.toThrow();
    await expect(run(tx => tx.execute(sql`select * from ops.claim_deliveries(null)`))).rejects.toThrow();
    reference = (await service.login("owner@example.test", "local recovered synthetic password", "workflow-tests"))!.reference;
    await expect(service.scoped(reference, household(), "read", tx => tx.execute(sql`select * from ops.claim_deliveries(1)`))).rejects.toThrow();
  });
  it("keeps financial commits intact after send failure and retries the same identifier", async () => {
    const count = (await admin.query("select count(*)::int n from core.import_batch")).rows[0].n;
    const result = await dispatchPending({ database: db, householdId: household(), maximum: 1, send: async value => { intent = value; throw new Error("Synthetic network failure"); } });
    expect(result).toEqual({ sent: 0, failed: 1 });
    expect((await admin.query("select count(*)::int n from core.import_batch")).rows[0].n).toBe(count);
    const delivery = (await admin.query("select state,attempts,total_attempts from ops.workflow_delivery where outbox_id=$1", [intent.outboxId])).rows[0];
    expect(delivery).toEqual({ state: "pending", attempts: 1, total_attempts: 1 });
    // Isolate this work item from the other synthetic batches for deterministic retry checks.
    await admin.query("update ops.workflow_delivery set next_attempt_at=now()+interval '1 day' where outbox_id<>$1", [intent.outboxId]);
    await admin.query("update ops.workflow_delivery set next_attempt_at=now()-interval '1 second' where outbox_id=$1", [intent.outboxId]);
    const sent: WorkIntent[] = [];
    expect(await dispatchPending({ database: db, householdId: household(), send: async value => { sent.push(value); } })).toEqual({ sent: 1, failed: 0 });
    expect(sent).toEqual([intent]);
  });
  it("idempotently records receipts and rejects mismatched household/revision IDs", async () => {
    await expect(acceptDelivery({ ...intent, householdId: randomUUID() }, db)).rejects.toThrow();
    await expect(acceptDelivery({ ...intent, revision: intent.revision + 1 }, db)).rejects.toThrow();
    await acceptDelivery(intent, db); await acceptDelivery(intent, db);
    expect((await admin.query("select state from ops.workflow_delivery where outbox_id=$1", [intent.outboxId])).rows[0].state).toBe("received");
    let sends = 0;
    expect(await dispatchPending({ database: db, householdId: household(), send: async () => { sends++; } })).toEqual({ sent: 0, failed: 0 });
    expect(sends).toBe(0);
  });
  it("claims once under concurrency and fences stale senders after a crashed claim", async () => {
    const id = (await admin.query("select outbox_id from ops.workflow_delivery where outbox_id<>$1 order by outbox_id limit 1", [intent.outboxId])).rows[0].outbox_id;
    await admin.query("update ops.workflow_delivery set next_attempt_at=now()-interval '1 second' where outbox_id=$1", [id]);
    const claims = await Promise.all([run(tx => tx.execute(sql`select * from ops.claim_deliveries(1,${household()}::uuid)`)), run(tx => tx.execute(sql`select * from ops.claim_deliveries(1,${household()}::uuid)`))]);
    expect(claims.flatMap(c => c.rows)).toHaveLength(1);
    const first = claims.flatMap(c => c.rows)[0]!;
    await admin.query("update ops.workflow_delivery set lease_until=now()-interval '1 second' where outbox_id=$1", [id]);
    const second = (await run(tx => tx.execute(sql`select * from ops.claim_deliveries(1,${household()}::uuid)`))).rows[0]!;
    expect(second.lease_token).not.toBe(first.lease_token);
    expect((await run(tx => tx.execute(sql`select ops.finish_delivery(${id}::uuid,${first.lease_token}::uuid,true) ok`))).rows[0]!.ok).toBe(false);
    await run(tx => tx.execute(sql`select ops.finish_delivery(${id}::uuid,${second.lease_token}::uuid,false)`));
    await admin.query("update ops.workflow_delivery set next_attempt_at=now()-interval '1 second' where outbox_id=$1", [id]);
    await dispatchPending({ database: db, householdId: household(), maximum: 1, send: async () => { throw new Error("Synthetic retry exhaustion"); } });
    expect((await admin.query("select state,total_attempts from ops.workflow_delivery where outbox_id=$1", [id])).rows[0]).toEqual({ state: "paused", total_attempts: 3 });
    await service.scoped(reference, household(), "admin", tx => tx.execute(sql`select ops.resume_delivery(${id}::uuid)`));
    expect((await admin.query("select state,attempts,total_attempts from ops.workflow_delivery where outbox_id=$1", [id])).rows[0]).toEqual({ state: "pending", attempts: 0, total_attempts: 3 });
  });
  it("defers delivery with expired capacity and sends nothing for an empty sweep", async () => {
    await admin.query("update ops.import_admission set verified_until=now()-interval '1 second'");
    let sends = 0;
    expect(await dispatchPending({ database: db, send: async () => { sends++; } })).toEqual({ sent: 0, failed: 0 });
    expect(sends).toBe(0);
    await admin.query("update ops.import_admission set verified_until=now()+interval '1 hour'");
    expect(await dispatchPending({ database: db, householdId: randomUUID(), send: async () => { sends++; } })).toEqual({ sent: 0, failed: 0 });
    expect(sends).toBe(0);
  });
}
