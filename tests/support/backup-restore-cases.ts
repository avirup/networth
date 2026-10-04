import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { acceptDelivery } from "@/db/workflows/dispatch";
import { beginCalculationPlan, advanceCalculationPlan } from "@/db/workflows/planning";
import { beginBankCandidate, advanceBankCandidate } from "@/db/calculations/bank-worker";
import { advanceBalanceCandidate, type BalanceCandidate } from "@/db/calculations/bank-balance-worker";
import { publishBankRelease } from "@/db/calculations/publish";
import { readBankOverview } from "@/db/reports/service";
import { drizzle } from "drizzle-orm/node-postgres";
import type { createIdentityService } from "@/db/auth/service";
import { createIdentityService as identityService } from "@/db/auth/service";
import { exportHouseholdBackup, restoreHouseholdBackup, verifyHouseholdBackup } from "@/db/backup/service";
import { migrateIdentity } from "@/db/auth/migrate";

export function backupRestoreCases(admin: Pool, service: ReturnType<typeof createIdentityService>, household: () => string, session: () => string) {
  it("exports one encrypted snapshot and restores authoritative history into an isolated empty database", async () => {
    const directory = path.join(await mkdtemp(path.join(tmpdir(), "networth-restore-drill-")), "backup");
    const passphrase = "synthetic encrypted restore drill"; const ownerEmail = "owner@example.test"; const newPassword = "restored synthetic owner password";
    const originalReport = await service.scoped(session(), household(), "read", (tx, actor) => readBankOverview(tx, actor, "2026-09"));
    expect(originalReport).not.toBeNull();
    const source = await admin.query(`select
      (select count(*)::int from core.import_batch where household_id=$1) batches,
      (select count(*)::int from core.source_record where household_id=$1) sources,
      (select count(*)::int from core.transaction_event where household_id=$1) events,
      (select count(*)::int from core.fact_posting where household_id=$1) postings,
      (select count(*)::int from core.reconciliation_result where household_id=$1) reconciliations,
      (select coalesce(sum(book_amount_inr),0)::text from core.fact_posting where household_id=$1) total,
      (select coalesce(jsonb_agg(id order by id),'[]'::jsonb)::text from core.source_record where household_id=$1) source_ids,
      (select coalesce(jsonb_agg(jsonb_build_array(event_id,source_id) order by event_id,source_id),'[]'::jsonb)::text from core.event_source_link where household_id=$1) provenance`, [household()]);
    const exportPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    const exported = await exportHouseholdBackup({ pool: exportPool, directory, ownerEmail, ownerPassword: "local recovered synthetic password", passphrase }).finally(() => exportPool.end());
    expect(exported.manifest.controls.sourceRecordCount).toBe(source.rows[0].sources);
    expect((await verifyHouseholdBackup(directory, passphrase)).exportId).toBe(exported.manifest.exportId);

    const sourceUrl = new URL(process.env.TEST_DATABASE_URL!); const database = `networth_restore_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(sourceUrl); maintenanceUrl.pathname = "/postgres";
    const maintenance = new Pool({ connectionString: maintenanceUrl.toString(), max: 1 }); let target: Pool | undefined; let runtime: Pool | undefined; let worker: Pool | undefined;
    try {
      await maintenance.query(`create database "${database}"`);
      const targetUrl = new URL(sourceUrl); targetUrl.pathname = `/${database}`; target = new Pool({ connectionString: targetUrl.toString(), max: 2 });
      await drizzle(target).transaction(tx => migrateIdentity(tx, "networth_test_app"));
      const restored = await restoreHouseholdBackup({ pool: target, directory, passphrase, ownerEmail, ownerPassword: newPassword, authSecret: "synthetic-auth-secret-for-tests-only" });
      expect(restored.recoveryCodes).toHaveLength(8);
      const rows = await target.query(`select
        (select count(*)::int from core.import_batch where household_id=$1) batches,
        (select count(*)::int from core.source_record where household_id=$1) sources,
        (select count(*)::int from core.transaction_event where household_id=$1) events,
        (select count(*)::int from core.fact_posting where household_id=$1) postings,
        (select count(*)::int from core.reconciliation_result where household_id=$1) reconciliations,
        (select coalesce(sum(book_amount_inr),0)::text from core.fact_posting where household_id=$1) total,
        (select coalesce(jsonb_agg(id order by id),'[]'::jsonb)::text from core.source_record where household_id=$1) source_ids,
        (select coalesce(jsonb_agg(jsonb_build_array(event_id,source_id) order by event_id,source_id),'[]'::jsonb)::text from core.event_source_link where household_id=$1) provenance,
        (select count(*)::int from ops.report_release) releases,
        (select count(*)::int from ops.workflow_delivery where household_id=$1 and state='pending') queued`, [household()]);
      expect(rows.rows[0]).toEqual({ ...source.rows[0], releases: 0, queued: 1 });
      const runtimeUrl = new URL(targetUrl); runtimeUrl.username = "networth_test_app"; runtimeUrl.password = "synthetic-runtime-test-only";
      runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 1 });
      const restoredService = identityService({ db: drizzle(runtime), admin: drizzle(target), runtimeRole: "networth_test_app", secret: "synthetic-auth-secret-for-tests-only" });
      const login = await restoredService.login(ownerEmail, newPassword, "restore-test");
      expect(login).not.toBeNull();
      if (!login || !originalReport) throw new Error("Expected authenticated source and restored report.");
      await target.query("insert into ops.import_admission values(true,now()+interval '1 hour',true,100,300000000,'Synthetic restore verification')");
      await target.query("insert into ops.execution_capacity values(true,now()+interval '1 hour',1000,300000000)");
      const workerUrl = new URL(targetUrl); workerUrl.username = "networth_test_worker"; workerUrl.password = "synthetic-worker-test-only";
      worker = new Pool({ connectionString: workerUrl.toString(), max: 2 }); const workerDb = drizzle(worker);
      const intent = (await target.query('select id as "outboxId",household_id as "householdId",batch_id as "batchId",revision from ops.outbox_event')).rows[0];
      await acceptDelivery(intent, workerDb);
      let plan = await beginCalculationPlan(intent, workerDb);
      for (let i = 0; i < 100 && plan.state !== "prepared"; i++)
        plan = await advanceCalculationPlan({ runId: plan.id, householdId: household(), page: plan.page }, workerDb);
      expect(plan.state).toBe("prepared");
      const resume = async () => {
        await target!.query("update ops.execution_capacity set remaining_attempts=1000,remaining_storage_bytes=300000000");
        await restoredService.scoped(login.reference, household(), "admin", tx => tx.execute(sql`select ops.resume_calculation_budget(${plan.id}::uuid)`));
      };
      let bank = await beginBankCandidate({ runId: plan.id, householdId: household(), asOf: originalReport.release.asOf }, workerDb);
      for (let i = 0; i < 150 && bank.state !== "calculated"; i++) {
        try { bank = await advanceBankCandidate({ runId: plan.id, householdId: household(), page: bank.page }, workerDb); }
        catch (error) { if (!(error instanceof Error) || !error.message.includes("paused:")) throw error; await resume(); }
      }
      expect(bank.state).toBe("calculated");
      let balance: BalanceCandidate | undefined;
      for (let i = 0; i < 150 && balance?.state !== "calculated"; i++) {
        try { balance = await advanceBalanceCandidate({ runId: plan.id, householdId: household(), page: balance?.page ?? 0 }, workerDb); }
        catch (error) { if (!(error instanceof Error) || !error.message.includes("paused:")) throw error; await resume(); }
      }
      expect(balance?.state).toBe("calculated");
      expect(await publishBankRelease({ runId: plan.id, householdId: household() }, workerDb)).toBeTruthy();
      const restoredReport = await restoredService.scoped(login.reference, household(), "read", (tx, actor) => readBankOverview(tx, actor, "2026-09"));
      expect(restoredReport).toMatchObject({
        summary: originalReport.summary, accounts: originalReport.accounts, categories: originalReport.categories,
        trends: originalReport.trends, cashFlow: originalReport.cashFlow, largestExpense: originalReport.largestExpense,
        scope: originalReport.scope, release: { sourceRevision: originalReport.release.sourceRevision, asOf: originalReport.release.asOf },
      });
      await expect(restoreHouseholdBackup({ pool: target, directory, passphrase, ownerEmail, ownerPassword: newPassword, authSecret: "synthetic-auth-secret-for-tests-only" })).rejects.toThrow(/empty/);
      expect((await service.operationsStatus(session())).lastBackupAt).not.toBeNull();
    } finally {
      await worker?.end(); await runtime?.end(); await target?.end(); // Pool shutdown can resolve before PostgreSQL has processed the socket closes.
      for (let attempt = 0; attempt < 100; attempt++) {
        const connected = await maintenance.query("select count(*)::int n from pg_stat_activity where datname=$1", [database]);
        if (connected.rows[0].n === 0) break;
        await delay(50);
      }
      await maintenance.query(`drop database if exists "${database}"`); await maintenance.end();
      await rm(path.dirname(directory), { recursive: true, force: true });
    }
  }, 180_000);
}
