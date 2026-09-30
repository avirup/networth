import { afterAll, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type { IdentityService } from "@/db/auth/service";
import { beginCalculationPlan, advanceCalculationPlan, type CalculationPlan } from "@/db/workflows/planning";
import { beginBankCandidate, advanceBankCandidate, type BankCandidate } from "@/db/calculations/bank-worker";
import { advanceBalanceCandidate, type BalanceCandidate } from "@/db/calculations/bank-balance-worker";
import { cleanupDerivedReports, publishBankRelease } from "@/db/calculations/publish";
import { readBankOverview } from "@/db/reports/service";

export function reportReleaseCases(admin: Pool, service: IdentityService, household: () => string, session: () => string, completedRun: () => string) {
  const url = new URL(process.env.TEST_DATABASE_URL!); url.username = "networth_test_worker"; url.password = "synthetic-worker-test-only";
  const pool = new Pool({ connectionString: url.toString(), max: 2 }), db = drizzle(pool);
  afterAll(() => pool.end());
  let releaseId: string;
  let previousReleaseId: string;

  async function resume(runId: string) {
    await admin.query("update ops.execution_capacity set verified_until=now()+interval '1 hour',remaining_attempts=1000,remaining_storage_bytes=300000000");
    await service.scoped(session(), household(), "admin", tx => tx.execute(sql`select ops.resume_calculation_budget(${runId}::uuid)`));
  }

  it("rejects a stale complete candidate without replacing the current release", async () => {
    expect(await publishBankRelease({ runId: completedRun(), householdId: household() }, db)).toBeNull();
    expect((await admin.query("select state from ops.calculation_run where id=$1", [completedRun()])).rows[0].state).toBe("superseded");
    expect((await admin.query("select count(*)::int n from ops.current_report_release")).rows[0].n).toBe(0);
  });

  it("builds and atomically publishes the latest complete banking manifest", async () => {
    await admin.query("update ops.execution_capacity set verified_until=now()+interval '1 hour',remaining_attempts=1000,remaining_storage_bytes=300000000");
    const intent = (await admin.query(`select o.id as "outboxId",o.household_id as "householdId",o.batch_id as "batchId",o.revision
      from ops.outbox_event o join ops.workflow_delivery d on d.outbox_id=o.id and d.state='received'
      where o.household_id=$1 order by o.revision desc limit 1`, [household()])).rows[0];
    let plan: CalculationPlan = await beginCalculationPlan(intent, db);
    for (let i = 0; i < 10 && plan.state !== "prepared"; i++) plan = await advanceCalculationPlan({ runId: plan.id, householdId: household(), page: plan.page }, db);
    expect(plan.state).toBe("prepared");
    const asOf = (await admin.query("select max(coverage_end)::text date from core.import_batch where household_id=$1 and revision<=$2", [household(), plan.source_revision])).rows[0].date;
    let bank: BankCandidate = await beginBankCandidate({ runId: plan.id, householdId: household(), asOf }, db);
    for (let i = 0; i < 101 && bank.state !== "calculated"; i++) {
      try { bank = await advanceBankCandidate({ runId: plan.id, householdId: household(), page: bank.page }, db); }
      catch (error) { if (!(error instanceof Error) || !error.message.includes("paused:")) throw error; await resume(plan.id); }
    }
    expect(bank.state).toBe("calculated");
    let balance: BalanceCandidate | undefined;
    for (let i = 0; i < 150 && balance?.state !== "calculated"; i++) {
      try { balance = await advanceBalanceCandidate({ runId: plan.id, householdId: household(), page: balance?.page ?? 0 }, db); }
      catch (error) { if (!(error instanceof Error) || !error.message.includes("paused:")) throw error; await resume(plan.id); }
    }
    expect(balance?.state).toBe("calculated");
    releaseId = (await publishBankRelease({ runId: plan.id, householdId: household() }, db))!;
    expect(releaseId).toBeTruthy();
    expect(await publishBankRelease({ runId: plan.id, householdId: household() }, db)).toBe(releaseId);
    const manifest = (await admin.query("select count(*)::int n from ops.report_release_account where release_id=$1", [releaseId])).rows[0].n;
    const expected = (await admin.query("select count(distinct account_id)::int n from core.import_batch where household_id=$1 and revision<=$2", [household(), plan.source_revision])).rows[0].n;
    expect(manifest).toBe(expected);
  }, 120_000);

  it("reuses unchanged account generations in an incremental release", async () => {
    previousReleaseId = releaseId;
    const before = (await admin.query("select account_id,source_run_id,generation_id,effective_date::text from ops.report_release_account where release_id=$1 order by account_id", [releaseId])).rows;
    const changed = before[0]; expect(changed).toBeTruthy();
    const created = (await admin.query(`insert into ops.calculation_run(household_id,source_revision,rule_version,state)
      select household_id,source_revision,'bank-plan-v1','prepared' from ops.report_release where id=$1 returning id`, [releaseId])).rows[0].id;
    const generation = (await admin.query(`insert into ops.bank_candidate(run_id,household_id,as_of,state)
      select $1,household_id,as_of,'calculated' from ops.report_release where id=$2 returning generation_id`, [created, releaseId])).rows[0].generation_id;
    await admin.query("insert into ops.bank_balance_candidate(run_id,household_id,generation_id,state) values($1,$2,$3,'calculated')", [created, household(), generation]);
    await admin.query(`insert into reporting.bank_balance_checkpoint(household_id,run_id,generation_id,account_id,currency,effective_date,calculated_balance,reconciled_balance,result)
      select household_id,$1,$2,account_id,currency,effective_date,calculated_balance,reconciled_balance,result from reporting.bank_balance_checkpoint
      where run_id=$3 and generation_id=$4 and account_id=$5`, [created, generation, changed.source_run_id, changed.generation_id, changed.account_id]);
    await admin.query(`insert into reporting.bank_account_movement
      select household_id,$1,$2,account_id,currency,ledger_kind,effective_date,native_delta,book_delta_inr,cash_delta,opening_delta,unresolved_delta,posting_count,incomplete_evidence
      from reporting.bank_account_movement where run_id=$3 and generation_id=$4 and account_id=$5`, [created, generation, changed.source_run_id, changed.generation_id, changed.account_id]);
    await admin.query(`insert into reporting.bank_category_movement(household_id,run_id,generation_id,account_id,month,kind,category_id,amount_inr,posting_count)
      select household_id,$1,$2,account_id,month,kind,category_id,amount_inr,posting_count from reporting.bank_category_movement
      where run_id=$3 and generation_id=$4 and account_id=$5`, [created, generation, changed.source_run_id, changed.generation_id, changed.account_id]);
    releaseId = (await publishBankRelease({ runId: created, householdId: household() }, db))!;
    const after = (await admin.query("select account_id,source_run_id,generation_id,effective_date::text from ops.report_release_account where release_id=$1 order by account_id", [releaseId])).rows;
    expect(after).toHaveLength(before.length);
    expect(after.find(row => row.account_id === changed.account_id)).toMatchObject({ source_run_id: created, generation_id: generation });
    for (const original of before.slice(1)) expect(after.find(row => row.account_id === original.account_id)).toEqual(original);
    expect((await admin.query("select state from ops.report_release where id=$1", [previousReleaseId])).rows[0].state).toBe("previous");
  });

  it("pins one authorized release and serves exact report strings", async () => {
    const report = await service.scoped(session(), household(), "read", (tx, actor) => readBankOverview(tx, actor, "2026-09"));
    expect(report?.release.id).toBe(releaseId);
    expect(report?.summary.netWorthInr).toMatch(/^-?\d+(\.\d+)?$/);
    expect(report?.summary.monthlyIncomeInr).toMatch(/^-?\d+(\.\d+)?$/);
    expect(report?.accounts.length).toBeGreaterThan(0);
    expect((await admin.query("select count(*)::int n from ops.report_request_pin where release_id=$1 and expires_at>now()", [releaseId])).rows[0].n).toBeGreaterThan(0);
  });

  it("retains pinned previous data and cleans only safe expired generations", async () => {
    await admin.query("update ops.report_release set published_at=now()-interval '25 hours' where id=$1", [previousReleaseId]);
    await admin.query("insert into ops.report_request_pin(household_id,release_id,expires_at) values($1,$2,now()+interval '15 minutes')", [household(), previousReleaseId]);
    await cleanupDerivedReports(db);
    expect((await admin.query("select count(*)::int n from ops.report_release where id=$1", [previousReleaseId])).rows[0].n).toBe(1);
    await admin.query("update ops.report_request_pin set expires_at=now()-interval '1 second' where release_id=$1", [previousReleaseId]);
    await cleanupDerivedReports(db);
    expect((await admin.query("select count(*)::int n from ops.report_release where id=$1", [previousReleaseId])).rows[0].n).toBe(0);
    expect((await admin.query("select release_id from ops.current_report_release where household_id=$1", [household()])).rows[0].release_id).toBe(releaseId);
  });
}
