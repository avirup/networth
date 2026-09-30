import { afterAll, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { IdentityService } from "@/db/auth/service";
import { advanceCalculationPlan } from "@/db/workflows/planning";
import { readBankCalculationPage } from "@/db/calculations/bank-input";
import { confirmImport, reviewImport } from "@/db/imports/service";
import { encodedBytes, type Confirmation } from "@/lib/imports/review";

export function bankCalculationCases(admin: Pool, service: IdentityService, household: () => string) {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.username = "networth_test_worker"; url.password = "synthetic-worker-test-only";
  const pool = new Pool({ connectionString: url.toString() }), worker = drizzle(pool);
  afterAll(() => pool.end());
  let reference: string, runId: string;
  let first: Awaited<ReturnType<typeof readBankCalculationPage>>;
  const read = (input: unknown) => service.scoped(reference, household(), "read", (tx, actor) => readBankCalculationPage(tx, actor, input));
  it("reads only prepared, household-authorized calculation inputs in bounded complete event pages", async () => {
    reference = (await service.login("owner@example.test", "local recovered synthetic password", "bank-calculation-tests"))!.reference;
    const run = (await admin.query("select id,page from ops.calculation_run where household_id=$1", [household()])).rows[0];
    runId = run.id;
    await expect(read({ runId, asOf: "2026-12-31" })).rejects.toMatchObject({ status: 409 });
    await admin.query("update ops.execution_capacity set verified_until=now()+interval '1 hour',remaining_attempts=100,remaining_storage_bytes=300000000");
    await service.scoped(reference, household(), "admin", tx => tx.execute(sql`select ops.resume_calculation_budget(${runId}::uuid)`));
    expect((await advanceCalculationPlan({ runId, householdId: household(), page: run.page }, worker)).state).toBe("prepared");
    first = await read({ runId, asOf: "2026-12-31" });
    expect(first.events).toHaveLength(100);
    expect(first.events.every(e => e.householdId === household() && e.revision <= first.context.sourceRevision && e.legs.length === 2)).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(3_000_000);
    const second = await read({ runId, asOf: "2026-12-31", cursor: first.nextCursor });
    expect(second.events).toHaveLength(100);
    expect(second.events.some(e => first.events.some(previous => previous.id === e.id))).toBe(false);
    expect(second.context).toEqual(first.context);
    const reversed = (await admin.query("select id,effective_date::text date from core.transaction_event where household_id=$1 and kind='reversal' order by effective_date,id limit 1", [household()])).rows[0];
    const previous = (await admin.query("select id,effective_date::text date from core.transaction_event where household_id=$1 and (effective_date,id)<($2::date,$3::uuid) order by effective_date desc,id desc limit 1", [household(), reversed.date, reversed.id])).rows[0];
    const reversalPage = await read({ runId, asOf: "2026-12-31", ...(previous ? { cursor: { date: previous.date, eventId: previous.id } } : {}) });
    expect(reversalPage.events.find(e => e.id === reversed.id)?.reversedKind).toBe("expense");
  });
  it("preserves the captured input page after a later backdated financial import", async () => {
    await admin.query("update ops.import_admission set verified_until=now()+interval '1 hour',remaining_imports=100,remaining_storage_bytes=300000000");
    const input: Confirmation = {
      idempotencyKey: randomUUID(), expectedRevision: (await admin.query("select revision from ops.source_revision where household_id=$1", [household()])).rows[0].revision,
      newAccount: { name: "Synthetic later bank", maskedReference: "****6789" },
      manifest: { schemaVersion: "bank-v1", accountId: randomUUID(), currency: "INR", coverageStart: "2026-01-01", coverageEnd: "2026-01-01", completeness: "complete", openingBalance: "0", closingBalance: "999", openingKnown: true, historyReason: "" },
      rows: [{ schema_version: "bank-v1", row_id: "late", transaction_ref: "synthetic-late-input", transaction_date: "2026-01-01", description: "Synthetic late salary", direction: "credit", amount: "999", currency: "INR", event_type: "income", category: "salary", book_amount_inr: "", fx_rate: "", related_row_id: "" }], decisions: { late: { action: "new", note: "" } }, acknowledgements: [],
    };
    const committed = await service.scoped(reference, household(), "import", async (tx, actor) => {
      input.acknowledgements = (await reviewImport(tx, actor, input)).warnings.map(w => w.code);
      return confirmImport(tx, actor, input, encodedBytes(input), true);
    });
    expect(committed.revision).toBeGreaterThan(first.context.sourceRevision);
    expect(await read({ runId, asOf: "2026-12-31" })).toEqual(first);
    expect((await read({ runId, asOf: "2026-01-01" })).events).toHaveLength(0);
  });
  it("does not leak another household or turn statement observations into movement facts", async () => {
    const other = (await admin.query("select id from ops.calculation_run where household_id<>$1", [household()])).rows[0].id;
    await expect(read({ runId: other, asOf: "2026-12-31" })).rejects.toMatchObject({ status: 404 });
    await expect(read({ runId: randomUUID(), asOf: "2026-12-31" })).rejects.toMatchObject({ status: 404 });
    const early = await read({ runId, asOf: "2026-08-31" });
    expect(early.events).toHaveLength(0);
    expect(early.calculation.accountMovements).toHaveLength(0);
    expect(early.calculation.categoryMovements).toHaveLength(0);
    expect(early.nextCursor).toBeNull();
    await expect(read({ runId, asOf: "2026-02-30" })).rejects.toThrow();
  });
  return () => reference;
}
