import { afterAll, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { IdentityService } from "@/db/auth/service";
import { workerTransaction } from "@/db/workflows/connection";
import { finishPlanningAttempt, failPlanningAttempt } from "@/db/workflows/planning";
import { beginBankCandidate, claimBankAttempt, readBankWorkerInput, commitBankPage, advanceBankCandidate, type BankCandidate } from "@/db/calculations/bank-worker";
import { calculateBankPage } from "@/lib/finance/bank-calculation";
export function bankCandidateCases(admin: Pool, service: IdentityService, household: () => string, session: () => string) {
  const url = new URL(process.env.TEST_DATABASE_URL!); url.username = "networth_test_worker"; url.password = "synthetic-worker-test-only";
  const pool = new Pool({ connectionString: url.toString(), max: 3 }), db = drizzle(pool);
  afterAll(() => pool.end());
  let runId: string, reference: string, candidate: BankCandidate;
  const scope = () => ({ runId, householdId: household() });
  const request = (token: string) => ({ ...scope(), token });
  const checkpoint = () => ({ ...scope(), page: candidate.page });
  async function claim() { const result = await claimBankAttempt(checkpoint(), db); if (result.status !== "claimed") throw new Error(`Expected bank claim, got ${result.status}`); return result; }
  it("creates a fixed-date candidate once and denies direct worker/member financial access", async () => {
    runId = (await admin.query("select id from ops.calculation_run where household_id=$1", [household()])).rows[0].id;
    reference = session();
    const results = await Promise.all([beginBankCandidate({ ...scope(), asOf: "2026-09-30" }, db), beginBankCandidate({ ...scope(), asOf: "2026-09-30" }, db)]);
    expect(results[0]!.generation_id).toBe(results[1]!.generation_id); candidate = results[0]!;
    await expect(beginBankCandidate({ ...scope(), asOf: "2026-11-30" }, db)).rejects.toThrow();
    await expect(beginBankCandidate({ ...scope(), householdId: randomUUID(), asOf: "2026-09-30" }, db)).rejects.toThrow();
    await expect(workerTransaction(tx => tx.execute(sql`select * from core.fact_posting`), db)).rejects.toThrow();
    await expect(workerTransaction(tx => tx.execute(sql`select * from reporting.bank_account_movement`), db)).rejects.toThrow();
    await expect(service.scoped(reference, household(), "read", tx => tx.execute(sql`select * from reporting.bank_category_movement`))).rejects.toThrow();
    await expect(readBankWorkerInput(request(randomUUID()), db)).rejects.toThrow();
  });
  it("rejects stale or wrong-stage tokens and refuses tampered financial results", async () => {
    const first = await claim();
    expect((await claimBankAttempt(checkpoint(), db)).status).toBe("busy");
    await expect(finishPlanningAttempt(request(first.token), db)).rejects.toThrow();
    await admin.query("update ops.calculation_budget set lease_until=now()-interval '1 second' where run_id=$1", [runId]);
    const second = await claim();
    await expect(readBankWorkerInput(request(first.token), db)).rejects.toThrow();
    expect(await failPlanningAttempt(request(first.token), db)).toBe(false);
    const inputs = await readBankWorkerInput(request(second.token), db);
    expect(inputs.events).toHaveLength(100);
    const result = calculateBankPage(inputs.context, inputs.events);
    const bad = structuredClone(result); bad.accountMovements[0]!.nativeDelta = "999999";
    await expect(commitBankPage(request(second.token), bad, db)).rejects.toMatchObject({ cause: { message: "bank result does not reconcile to captured postings" } });
    expect((await admin.query("select count(*)::int n from reporting.bank_account_movement where run_id=$1", [runId])).rows[0].n).toBe(0);
    await expect(commitBankPage(request(second.token), { ...result, sourceRevision: result.sourceRevision + 1 }, db)).rejects.toThrow();
    candidate = await commitBankPage(request(second.token), result, db);
    expect(candidate.page).toBe(1);
    await expect(commitBankPage(request(second.token), result, db)).rejects.toThrow();
    const attempts = (await admin.query("select total_attempts::text from ops.calculation_budget where run_id=$1", [runId])).rows[0].total_attempts;
    expect((await advanceBankCandidate({ ...scope(), page: 0 }, db)).page).toBe(1);
    expect((await admin.query("select total_attempts::text from ops.calculation_budget where run_id=$1", [runId])).rows[0].total_attempts).toBe(attempts);
  });
  it("rolls back candidate facts with their checkpoint while retaining the committed attempt", async () => {
    const reserved = await claim(), inputs = await readBankWorkerInput(request(reserved.token), db);
    const result = calculateBankPage(inputs.context, inputs.events);
    const before = (await admin.query("select coalesce(sum(posting_count),0)::text n from reporting.bank_account_movement where run_id=$1", [runId])).rows[0].n;
    await expect(workerTransaction(async tx => {
      await tx.execute(sql`select * from ops.commit_bank_page(${runId}::uuid,${household()}::uuid,${reserved.token}::uuid,${JSON.stringify(result)}::jsonb)`);
      throw new Error("Synthetic interruption after candidate writes");
    }, db)).rejects.toThrow("Synthetic interruption");
    expect((await admin.query("select page from ops.bank_candidate where run_id=$1", [runId])).rows[0].page).toBe(1);
    expect((await admin.query("select coalesce(sum(posting_count),0)::text n from reporting.bank_account_movement where run_id=$1", [runId])).rows[0].n).toBe(before);
    candidate = await commitBankPage(request(reserved.token), result, db);
    expect(candidate.page).toBe(2);
  });
  it("pauses bank work on expired verification and resumes the same candidate without resetting usage", async () => {
    const before = (await admin.query("select total_attempts::text from ops.calculation_budget where run_id=$1", [runId])).rows[0].total_attempts;
    await admin.query("update ops.execution_capacity set verified_until=now()-interval '1 second'");
    expect(await claimBankAttempt(checkpoint(), db)).toMatchObject({ status: "paused", reason: "capacity" });
    await expect(service.scoped(reference, household(), "admin", tx => tx.execute(sql`select ops.resume_calculation_budget(${runId}::uuid)`))).rejects.toThrow();
    await admin.query("update ops.execution_capacity set verified_until=now()+interval '1 hour',remaining_attempts=100,remaining_storage_bytes=300000000");
    await service.scoped(reference, household(), "admin", tx => tx.execute(sql`select ops.resume_calculation_budget(${runId}::uuid)`));
    expect((await admin.query("select total_attempts::text from ops.calculation_budget where run_id=$1", [runId])).rows[0].total_attempts).toBe(before);
    const concurrent = await Promise.allSettled([advanceBankCandidate(checkpoint(), db), advanceBankCandidate(checkpoint(), db)]);
    const finished = concurrent.filter(r => r.status === "fulfilled").map(r => r.value);
    expect(finished.length).toBeGreaterThan(0);
    for (const failed of concurrent.filter(r => r.status === "rejected")) expect(failed.reason).toMatchObject({ status: 409 });
    candidate = finished[0]!; expect(candidate.page).toBe(3);
  });
  it("matches a full captured-ledger reference after all bounded pages and never publishes a report", async () => {
    for (let i = 0; i < 60 && candidate.state !== "calculated"; i++) candidate = await advanceBankCandidate(checkpoint(), db);
    expect(candidate.state).toBe("calculated");
    const missing = await admin.query(`with expected as (
      select l.account_id,p.currency,l.kind ledger_kind,e.effective_date,sum(p.native_amount) native_delta,sum(p.book_amount_inr) book_delta_inr,count(*) posting_count
      from core.fact_posting p join core.transaction_event e on e.id=p.event_id and e.household_id=p.household_id
      join core.import_batch b on b.id=e.batch_id and b.household_id=e.household_id
      join core.ledger_account l on l.id=p.ledger_account_id and l.household_id=p.household_id
      join ops.calculation_run r on r.id=$1 and r.household_id=p.household_id
      where b.revision<=r.source_revision and e.effective_date<=$2 and l.kind in ('asset','liability')
      group by l.account_id,p.currency,l.kind,e.effective_date
    ), actual as (select account_id,currency,ledger_kind,effective_date,native_delta,book_delta_inr,posting_count from reporting.bank_account_movement where run_id=$1)
    select * from ((select * from expected except all select * from actual) union all (select * from actual except all select * from expected)) differences`, [runId, candidate.as_of]);
    expect(missing.rows).toHaveLength(0);
    const categories = await admin.query(`with expected as (
      select cash.account_id,date_trunc('month',e.effective_date)::date AS month,l.kind,p.category_id,
      sum(case when l.kind='income' then -p.book_amount_inr else p.book_amount_inr end) amount_inr,count(*) posting_count
      from core.fact_posting p join core.transaction_event e on e.id=p.event_id and e.household_id=p.household_id
      join core.import_batch b on b.id=e.batch_id and b.household_id=e.household_id
      join core.ledger_account l on l.id=p.ledger_account_id and l.household_id=p.household_id
      join core.fact_posting ap on ap.event_id=e.id and ap.household_id=e.household_id
      join core.ledger_account cash on cash.id=ap.ledger_account_id and cash.household_id=ap.household_id and cash.kind='asset'
      join ops.calculation_run r on r.id=$1 and r.household_id=p.household_id
      where b.revision<=r.source_revision and e.effective_date<=$2 and l.kind in ('income','expense')
      group by cash.account_id,2,l.kind,p.category_id
    ), actual as (select account_id,month,kind,category_id,amount_inr,posting_count from reporting.bank_category_movement where run_id=$1)
    select * from ((select * from expected except all select * from actual) union all (select * from actual except all select * from expected)) differences`, [runId, candidate.as_of]);
    expect(categories.rows).toHaveLength(0);
    expect((await admin.query("select count(*)::int n from reporting.bank_category_movement where run_id=$1 and category_id is null and amount_inr=2499 and posting_count=2499", [runId])).rows[0].n).toBe(1);
    expect(candidate.event_count).toBeGreaterThan(4998);
    expect((await advanceBankCandidate(checkpoint(), db)).page).toBe(candidate.page);
    await expect(service.scoped(reference, household(), "admin", tx => tx.execute(sql`select ops.resume_calculation_budget(${runId}::uuid)`))).rejects.toThrow();
    expect((await admin.query("select count(*)::int n from ops.current_report_release")).rows[0].n).toBe(0);
  }, 120_000);
}
