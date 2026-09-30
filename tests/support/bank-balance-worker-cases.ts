import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type { IdentityService } from "@/db/auth/service";
import { workerTransaction } from "@/db/workflows/connection";
import { finishPlanningAttempt } from "@/db/workflows/planning";
import { readBankWorkerInput } from "@/db/calculations/bank-worker";
import { readBankBalanceInput } from "@/db/calculations/bank-balance-input";
import { claimBalanceAttempt, readBalanceWorkerInput, evaluateBalanceSource, commitBalance, advanceBalanceCandidate, type BalanceCandidate } from "@/db/calculations/bank-balance-worker";

export function bankBalanceWorkerCases(admin: Pool, service: IdentityService, household: () => string, session: () => string) {
  const url = new URL(process.env.TEST_DATABASE_URL!); url.username = "networth_test_worker"; url.password = "synthetic-worker-test-only";
  const pool = new Pool({ connectionString: url.toString(), max: 3 }), db = drizzle(pool);
  afterAll(() => pool.end());
  let runId: string, candidate: BalanceCandidate;
  const scope = () => ({ runId, householdId: household() });
  const request = (token: string) => ({ ...scope(), token });
  const checkpoint = () => ({ ...scope(), page: candidate?.page ?? 0 });
  async function claim() { const value = await claimBalanceAttempt(checkpoint(), db); if (value.status !== "claimed") throw new Error(`Expected balance claim, got ${value.status}`); candidate = value.candidate; return value; }
  it("restricts balance input and checkpoint access and fixes the source generation", async () => {
    runId = (await admin.query("select id from ops.calculation_run where household_id=$1", [household()])).rows[0].id;
    await admin.query("update ops.execution_capacity set verified_until=now()+interval '1 hour',remaining_attempts=250,remaining_storage_bytes=300000000");
    await expect(claimBalanceAttempt({ ...checkpoint(), householdId: randomUUID() }, db)).rejects.toThrow();
    await expect(workerTransaction(tx => tx.execute(sql`select * from reporting.bank_balance_checkpoint`), db)).rejects.toThrow();
    await expect(workerTransaction(tx => tx.execute(sql`select ops.expected_bank_balance('{}'::jsonb)`), db)).rejects.toThrow();
    await expect(service.scoped(session(), household(), "read", tx => tx.execute(sql`select * from reporting.bank_balance_checkpoint`))).rejects.toThrow();
    const first = await claim();
    expect(candidate.generation_id).toBe((await admin.query("select generation_id from ops.bank_candidate where run_id=$1", [runId])).rows[0].generation_id);
    expect((await claimBalanceAttempt(checkpoint(), db)).status).toBe("busy");
    await expect(finishPlanningAttempt(request(first.token), db)).rejects.toThrow();
    await expect(readBankWorkerInput(request(first.token), db)).rejects.toThrow();
    await admin.query("update ops.calculation_budget set lease_until=now()-interval '1 second' where run_id=$1", [runId]);
    await expect(readBalanceWorkerInput(request(first.token), db)).rejects.toThrow();
  });
  it("checks worker results against source evidence and commits facts with progress once", async () => {
    const lease = await claim(), input = await readBalanceWorkerInput(request(lease.token), db);
    expect(input).not.toBeNull();
    const result = evaluateBalanceSource(input)!;
    const diagnostic = await service.scoped(session(), household(), "read", (tx, actor) => readBankBalanceInput(tx, actor, { runId, accountId: input!.scope.accountId, asOf: input!.scope.asOf }));
    expect(result).toEqual(diagnostic.calculation);
    await expect(commitBalance(request(lease.token), { ...result, calculatedBalance: "999.000000000000" }, db)).rejects.toMatchObject({ cause: { message: "balance result does not reconcile to captured evidence" } });
    await expect(commitBalance(request(lease.token), { ...result, sourceRevision: result.sourceRevision + 1 }, db)).rejects.toThrow();
    const before = (await admin.query("select total_attempts::text from ops.calculation_budget where run_id=$1", [runId])).rows[0].total_attempts;
    candidate = await commitBalance(request(lease.token), result, db);
    await expect(commitBalance(request(lease.token), result, db)).rejects.toThrow();
    expect((await advanceBalanceCandidate({ ...scope(), page: 0 }, db)).page).toBe(1);
    expect((await admin.query("select total_attempts::text from ops.calculation_budget where run_id=$1", [runId])).rows[0].total_attempts).toBe(before);
    expect((await admin.query("select result from reporting.bank_balance_checkpoint where run_id=$1", [runId])).rows).toEqual([{ result }]);
  });
  it("rolls back checkpoint rows and cursor together while preserving reserved usage", async () => {
    const lease = await claim(), result = evaluateBalanceSource(await readBalanceWorkerInput(request(lease.token), db));
    await expect(workerTransaction(async tx => {
      await tx.execute(sql`select * from ops.commit_bank_balance(${runId}::uuid,${household()}::uuid,${lease.token}::uuid,${JSON.stringify(result)}::jsonb)`);
      throw new Error("synthetic rollback");
    }, db)).rejects.toThrow("synthetic rollback");
    expect((await admin.query("select page from ops.bank_balance_candidate where run_id=$1", [runId])).rows[0].page).toBe(1);
    expect((await admin.query("select count(*)::int n from reporting.bank_balance_checkpoint where run_id=$1", [runId])).rows[0].n).toBe(1);
    candidate = await commitBalance(request(lease.token), result, db);
    expect(candidate.page).toBe(2);
  });
  it("pauses on expired verification, resumes without erasing usage and serializes concurrent steps", async () => {
    await admin.query("update ops.execution_capacity set verified_until=now()-interval '1 second'");
    expect((await claimBalanceAttempt(checkpoint(), db)).status).toBe("paused");
    const before = (await admin.query("select total_attempts::text from ops.calculation_budget where run_id=$1", [runId])).rows[0].total_attempts;
    await admin.query("update ops.execution_capacity set verified_until=now()+interval '1 hour',remaining_attempts=250,remaining_storage_bytes=300000000");
    await service.scoped(session(), household(), "admin", tx => tx.execute(sql`select ops.resume_calculation_budget(${runId}::uuid)`));
    expect((await admin.query("select total_attempts::text from ops.calculation_budget where run_id=$1", [runId])).rows[0].total_attempts).toBe(before);
    const outcomes = await Promise.allSettled([advanceBalanceCandidate(checkpoint(), db), advanceBalanceCandidate(checkpoint(), db)]);
    const completed = outcomes.filter(x => x.status === "fulfilled");
    expect(completed.length).toBeGreaterThan(0); candidate = completed[0]!.value;
    expect(candidate.page).toBe(3);
    for (const failure of outcomes.filter(x => x.status === "rejected")) expect(failure.reason).toMatchObject({ status: 409 });
  });
  it("finishes bounded accounts through an owner-resumed window and retains incomplete results privately", async () => {
    let resumed = false;
    for (let i = 0; i < 125 && candidate.state !== "calculated"; i++) {
      const budget = (await admin.query("select state,total_attempts::text from ops.calculation_budget where run_id=$1", [runId])).rows[0];
      if (budget.state === "paused") {
        resumed = true;
        await service.scoped(session(), household(), "admin", tx => tx.execute(sql`select ops.resume_calculation_budget(${runId}::uuid)`));
        expect((await admin.query("select total_attempts::text from ops.calculation_budget where run_id=$1", [runId])).rows[0].total_attempts).toBe(budget.total_attempts);
      }
      candidate = await advanceBalanceCandidate(checkpoint(), db);
    }
    expect(resumed).toBe(true); expect(candidate.state).toBe("calculated");
    const known = (await admin.query(`select c.result,c.reconciled_balance::text amount from reporting.bank_balance_checkpoint c
      join core.dim_account a on a.id=c.account_id where c.run_id=$1 and a.name='Synthetic reviewed opening bank'`, [runId])).rows[0];
    expect(known.amount).toBe("115.000000000000");
    expect(known.result.history).toBe("unknown");
    const counts = (await admin.query(`select (select count(*) from reporting.bank_balance_checkpoint where run_id=$1)::int actual,
      (select count(*) from ops.calculation_account c join core.dim_account a on a.id=c.account_id where c.run_id=$1 and a.kind in ('bank','cash'))::int expected`, [runId])).rows[0];
    expect(counts.actual).toBe(counts.expected);
    expect((await advanceBalanceCandidate(checkpoint(), db)).page).toBe(candidate.page);
    await expect(service.scoped(session(), household(), "admin", tx => tx.execute(sql`select ops.resume_calculation_budget(${runId}::uuid)`))).rejects.toThrow();
    expect((await admin.query("select count(*)::int n from ops.current_report_release")).rows[0].n).toBe(0);
  }, 120_000);
  return () => runId;
}
