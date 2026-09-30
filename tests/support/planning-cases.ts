import { afterAll, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { beginCalculationPlan, advanceCalculationPlan, type CalculationPlan, claimPlanningAttempt, finishPlanningAttempt, failPlanningAttempt } from "@/db/workflows/planning";
import { acceptDelivery } from "@/db/workflows/dispatch";
import { workerTransaction } from "@/db/workflows/connection";
import { confirmImport, reviewImport } from "@/db/imports/service";
import { encodedBytes, type Confirmation } from "@/lib/imports/review";
import type { IdentityService } from "@/db/auth/service";
import type { WorkIntent } from "@/lib/workflows/events";
import { accounts, rebuilds } from "@/db/schema/finance";

export function planningCases(admin: Pool, service: IdentityService, household: () => string) {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.username = "networth_test_worker"; url.password = "synthetic-worker-test-only";
  const pool = new Pool({ connectionString: url.toString(), max: 3 }), db = drizzle(pool);
  afterAll(() => pool.end());
  let reference: string, intent: WorkIntent, plan: CalculationPlan, lateIntent: WorkIntent;
  const accountId = randomUUID();
  const checkpoint = (page: number, householdId = household()) => ({ runId: plan.id, householdId, page });
  async function importFixture(date: string, first = false, invalidRevision = false) {
    const input: Confirmation = {
      idempotencyKey: randomUUID(), expectedRevision: (await admin.query("select revision from ops.source_revision where household_id=$1", [household()])).rows[0].revision,
      ...(first ? { newAccount: { name: "Synthetic planning account", maskedReference: "****1234" } } : {}),
      manifest: { schemaVersion: "bank-v1", accountId, currency: "INR", coverageStart: date, coverageEnd: date, completeness: "complete", openingBalance: "0", closingBalance: "0", openingKnown: true, historyReason: "" },
      rows: [], decisions: {}, acknowledgements: [],
    };
    const result = await service.scoped(reference, household(), "import", async (tx, actor) => {
      input.acknowledgements = (await reviewImport(tx, actor, input)).warnings.map(w => w.code);
      const committed = await confirmImport(tx, actor, input, encodedBytes(input), true);
      if (invalidRevision) {
        const otherAccount = (await tx.select().from(accounts)).find(a => a.id !== accountId)!;
        await tx.insert(rebuilds).values({ householdId: household(), accountId: otherAccount.id, batchId: committed.batchId, revision: committed.revision - 1, earliestDate: date });
      }
      if (first) {
        // More than one page, using real scoped writes and the same import transaction.
        const extra = Array.from({ length: 105 }, (_, i) => ({ id: randomUUID(), householdId: household(), name: `Synthetic planned account ${i}`, currency: "INR" }));
        await tx.insert(accounts).values(extra);
        await tx.insert(rebuilds).values(extra.map(a => ({ householdId: household(), accountId: a.id, batchId: committed.batchId, revision: committed.revision, earliestDate: date })));
      }
      return committed;
    });
    const outboxId = (await admin.query("select id from ops.outbox_event where batch_id=$1", [result.batchId])).rows[0].id;
    return { outboxId, householdId: household(), batchId: result.batchId, revision: result.revision };
  }
  it("captures one fixed candidate under concurrent starts and requires a matching receipt", async () => {
    reference = (await service.login("owner@example.test", "local recovered synthetic password", "planning-tests"))!.reference;
    await admin.query("update ops.import_admission set verified_until=now()+interval '1 hour',remaining_imports=100,remaining_storage_bytes=300000000");
    await admin.query("insert into ops.execution_capacity(singleton,verified_until,remaining_attempts,remaining_storage_bytes) values(true,now()+interval '1 hour',1000,300000000)");
    await importFixture("2026-08-01", true);
    intent = await importFixture("2026-07-01");
    await expect(beginCalculationPlan(intent, db)).rejects.toThrow();
    await acceptDelivery(intent, db);
    await expect(beginCalculationPlan({ ...intent, householdId: randomUUID() }, db)).rejects.toThrow();
    const results = await Promise.all([beginCalculationPlan(intent, db), beginCalculationPlan(intent, db)]);
    expect(results[0]!.id).toBe(results[1]!.id);
    plan = results[0]!;
    expect(plan).toMatchObject({ source_revision: intent.revision, rule_version: "bank-plan-v1", state: "planning", page: 0 });
    await expect(workerTransaction(tx => tx.execute(sql`update ops.calculation_run set source_revision=999`), db)).rejects.toThrow();
    await expect(service.scoped(reference, household(), "read", tx => tx.execute(sql`select * from ops.begin_calculation_plan(${intent.outboxId}::uuid,${household()}::uuid,${intent.batchId}::uuid,${intent.revision})`))).rejects.toThrow();
  });
  it("rejects a late batch that tries to insert rebuild work below the fixed revision", async () => {
    await expect(importFixture("2026-06-01", false, true)).rejects.toMatchObject({ cause: { message: "rebuild revision must match its batch" } });
    expect((await admin.query("select revision from ops.source_revision where household_id=$1", [household()])).rows[0].revision).toBe(intent.revision);
  });
  it("commits a bounded page once under concurrent retries and rejects skipped checkpoints", async () => {
    await expect(advanceCalculationPlan(checkpoint(1), db)).rejects.toThrow();
    await expect(advanceCalculationPlan(checkpoint(0, randomUUID()), db)).rejects.toThrow();
    const results = await Promise.allSettled([advanceCalculationPlan(checkpoint(0), db), advanceCalculationPlan(checkpoint(0), db)]);
    const successes = results.filter(r => r.status === "fulfilled").map(r => r.value);
    expect(successes.length).toBeGreaterThan(0);
    for (const failure of results.filter(r => r.status === "rejected")) expect(failure.reason).toMatchObject({ status: 409 });
    expect(successes.every(r => r.page === 1)).toBe(true);
    expect(successes[0]!.state).toBe("planning");
    const processed = (await admin.query("select count(*)::int n from ops.rebuild_request where household_id=$1 and (revision,id)<=($2,$3::uuid)", [household(), successes[0]!.cursor_revision, successes[0]!.cursor_id])).rows[0].n;
    expect(processed).toBe(100);
    plan = successes[0]!;
  });
  it("pauses with expired capacity without losing the checkpoint; duplicate reads remain safe", async () => {
    await admin.query("update ops.import_admission set verified_until=now()-interval '1 second'");
    await expect(advanceCalculationPlan(checkpoint(1), db)).rejects.toMatchObject({ status: 503, message: "Calculation paused: capacity." });
    expect((await advanceCalculationPlan(checkpoint(0), db)).page).toBe(1);
    expect((await beginCalculationPlan(intent, db)).page).toBe(1);
    await admin.query("update ops.import_admission set verified_until=now()+interval '1 hour'");
    await service.scoped(reference, household(), "admin", tx => tx.execute(sql`select ops.resume_calculation_budget(${plan.id}::uuid)`));
  });
  it("excludes later backdated imports and coalesces all captured requests to their earliest date", async () => {
    lateIntent = await importFixture("2026-01-01");
    await acceptDelivery(lateIntent, db);
    const existing = await beginCalculationPlan(lateIntent, db);
    expect(existing.id).toBe(plan.id);
    expect(existing.source_revision).toBe(intent.revision);
    plan = await advanceCalculationPlan(checkpoint(1), db);
    expect(plan.state).toBe("prepared");
    const actual = (await admin.query("select account_id,earliest_date::text from ops.calculation_account where run_id=$1 order by account_id", [plan.id])).rows;
    const expected = (await admin.query("select account_id,min(earliest_date)::text earliest_date from ops.rebuild_request where household_id=$1 and revision<=$2 group by account_id order by account_id", [household(), intent.revision])).rows;
    expect(actual).toEqual(expected);
    expect(actual.find(r => r.account_id === accountId).earliest_date).toBe("2026-07-01");
    expect((await advanceCalculationPlan(checkpoint(plan.page), db)).page).toBe(plan.page);
    expect((await admin.query("select count(*)::int n from ops.rebuild_request where household_id=$1 and revision>$2", [household(), plan.source_revision])).rows[0].n).toBeGreaterThan(0);
  });
  it("rolls back candidate rows and checkpoint together and scopes member visibility", async () => {
    // Force a transaction rollback after an otherwise valid page to exercise atomicity.
    await admin.query("update ops.calculation_run set state='planning',page=0,cursor_revision=0,cursor_id='00000000-0000-0000-0000-000000000000' where id=$1", [plan.id]);
    await admin.query("delete from ops.calculation_account where run_id=$1", [plan.id]);
    const claim = await claimPlanningAttempt(checkpoint(0), db);
    if (claim.status !== "claimed") throw new Error("Expected synthetic planning claim");
    await expect(workerTransaction(async tx => {
      await tx.execute(sql`select * from ops.finish_planning_attempt(${plan.id}::uuid,${household()}::uuid,${claim.token}::uuid)`);
      throw new Error("Synthetic interrupted transaction");
    }, db)).rejects.toThrow("Synthetic");
    expect((await admin.query("select page from ops.calculation_run where id=$1", [plan.id])).rows[0].page).toBe(0);
    expect((await admin.query("select count(*)::int n from ops.calculation_account where run_id=$1", [plan.id])).rows[0].n).toBe(0);
    const visible = await service.scoped(reference, household(), "read", tx => tx.execute(sql`select id from ops.calculation_run`));
    expect(visible.rows).toEqual([{ id: plan.id }]);
    const other = (await admin.query(`with h as (insert into core.household(name) values('Synthetic isolated planner') returning id),
      u as (insert into core.auth_user(name,email) values('Synthetic planner owner','planner-owner@example.test') returning id)
      insert into core.household_membership(household_id,user_id,role) select h.id,u.id,'owner' from h cross join u returning household_id`)).rows[0].household_id;
    await admin.query("insert into ops.calculation_run(household_id,source_revision,rule_version) values($1,1,'bank-plan-v1')", [other]);
    expect((await service.scoped(reference, household(), "read", tx => tx.execute(sql`select id from ops.calculation_run`))).rows).toEqual([{ id: plan.id }]);
    await admin.query("update ops.calculation_budget set lease_until=now()-interval '1 second' where run_id=$1", [plan.id]);
    plan = await advanceCalculationPlan(checkpoint(0), db);
    plan = await advanceCalculationPlan(checkpoint(plan.page), db);
    expect(plan.state).toBe("prepared");
  });
  async function resetPlanning() {
    await admin.query("update ops.calculation_run set state='planning',page=0,cursor_revision=0,cursor_id='00000000-0000-0000-0000-000000000000' where id=$1", [plan.id]);
    await admin.query("delete from ops.calculation_account where run_id=$1", [plan.id]);
    await admin.query("update ops.calculation_budget set state='ready',reason=null,window_attempts=0,step_page=0,step_attempts=0,lease_token=null,lease_until=null where run_id=$1", [plan.id]);
  }
  const budget = async () => (await admin.query("select window_attempts,total_attempts::text,step_attempts,state,reason from ops.calculation_budget where run_id=$1", [plan.id])).rows[0];
  const resume = () => service.scoped(reference, household(), "admin", tx => tx.execute(sql`select ops.resume_calculation_budget(${plan.id}::uuid)`));
  const attempt = (token: string) => ({ runId: plan.id, householdId: household(), token });
  async function claim() {
    const value = await claimPlanningAttempt(checkpoint(0), db);
    if (value.status !== "claimed") throw new Error(`Expected claim, received ${value.status}`);
    return value;
  }
  it("requires separate verified execution capacity and closes the unreserved worker path", async () => {
    await resetPlanning();
    await admin.query("delete from ops.execution_capacity");
    const before = await budget();
    expect(await claimPlanningAttempt(checkpoint(0), db)).toMatchObject({ status: "paused", reason: "capacity" });
    expect((await budget()).total_attempts).toBe(before.total_attempts);
    await expect(resume()).rejects.toMatchObject({ cause: { message: "capacity verification required" } });
    await expect(workerTransaction(tx => tx.execute(sql`select * from ops.advance_calculation_plan_reserved(${plan.id}::uuid,${household()}::uuid,0)`), db)).rejects.toThrow();
    await expect(workerTransaction(tx => tx.execute(sql`insert into ops.execution_capacity values(true,now(),100,1000000)`), db)).rejects.toThrow();
    await expect(workerTransaction(tx => tx.execute(sql`update ops.calculation_budget set window_attempts=0`), db)).rejects.toThrow();
    await admin.query("insert into ops.execution_capacity values(true,now()+interval '1 hour',1000,300000000)");
    await resume();
    expect((await budget()).total_attempts).toBe(before.total_attempts);
  });
  it("keeps charges across crashes and rollback, rejects busy claims and fences expired tokens", async () => {
    const before = BigInt((await budget()).total_attempts);
    const first = await claim();
    expect(await claimPlanningAttempt(checkpoint(0), db)).toMatchObject({ status: "busy" });
    expect(BigInt((await budget()).total_attempts)).toBe(before + 1n);
    await admin.query("update ops.calculation_budget set lease_until=now()-interval '1 second' where run_id=$1", [plan.id]);
    const second = await claim();
    await expect(finishPlanningAttempt(attempt(first.token), db)).rejects.toMatchObject({ cause: { message: "expired planning claim" } });
    expect(await failPlanningAttempt(attempt(first.token), db)).toBe(false);
    await expect(workerTransaction(async tx => {
      await tx.execute(sql`select * from ops.finish_planning_attempt(${plan.id}::uuid,${household()}::uuid,${second.token}::uuid)`);
      throw new Error("Synthetic failure after computation");
    }, db)).rejects.toThrow("Synthetic failure");
    expect(BigInt((await budget()).total_attempts)).toBe(before + 2n);
    expect((await admin.query("select page from ops.calculation_run where id=$1", [plan.id])).rows[0].page).toBe(0);
    expect(await failPlanningAttempt(attempt(second.token), db)).toBe(true);
    expect((await admin.query("select remaining_attempts::text from ops.execution_capacity")).rows[0].remaining_attempts).toBe("998");
  });
  it("pauses after the initial page attempt and three retries and preserves cumulative usage on resume", async () => {
    await resetPlanning();
    const before = BigInt((await budget()).total_attempts);
    for (let i = 0; i < 4; i++) {
      const reserved = await claim();
      expect(await failPlanningAttempt(attempt(reserved.token), db)).toBe(true);
    }
    expect(await claimPlanningAttempt(checkpoint(0), db)).toMatchObject({ status: "paused", reason: "retry_limit" });
    expect(await budget()).toMatchObject({ total_attempts: String(before + 4n), step_attempts: 4, state: "paused" });
    await admin.query("update ops.execution_capacity set verified_until=now()-interval '1 second'");
    await expect(resume()).rejects.toThrow();
    expect((await budget()).state).toBe("paused");
    await admin.query("update ops.execution_capacity set verified_until=now()+interval '1 hour'");
    await resume();
    expect(await budget()).toMatchObject({ total_attempts: String(before + 4n), window_attempts: 0, step_attempts: 0, state: "ready" });
  });
  it("enforces the 100-attempt window boundary without resetting lifetime usage", async () => {
    await resetPlanning();
    await admin.query("update ops.calculation_budget set window_attempts=99,total_attempts=999 where run_id=$1", [plan.id]);
    const last = await claim();
    expect(await failPlanningAttempt(attempt(last.token), db)).toBe(true);
    expect(await claimPlanningAttempt(checkpoint(0), db)).toMatchObject({ status: "paused", reason: "window_limit" });
    expect(await budget()).toMatchObject({ window_attempts: 100, total_attempts: "1000" });
    await resume();
    expect(await budget()).toMatchObject({ window_attempts: 0, total_attempts: "1000", state: "ready" });
    await expect(service.scoped(reference, household(), "admin", tx => tx.execute(sql`select ops.resume_calculation_budget(${randomUUID()}::uuid)`))).rejects.toThrow();
  });
  it("reserves the final shared execution credit only once across concurrent households", async () => {
    await resetPlanning();
    const other = (await admin.query("select id,household_id from ops.calculation_run where household_id<>$1", [household()])).rows[0];
    await admin.query("update ops.execution_capacity set remaining_attempts=1");
    const results = await Promise.all([claimPlanningAttempt(checkpoint(0), db), claimPlanningAttempt({ runId: other.id, householdId: other.household_id, page: 0 }, db)]);
    expect(results.filter(r => r.status === "claimed")).toHaveLength(1);
    expect(results.filter(r => r.status === "paused")).toHaveLength(1);
    expect((await admin.query("select remaining_attempts::text from ops.execution_capacity")).rows[0].remaining_attempts).toBe("0");
    for (const result of results) if (result.status === "claimed") {
      // The reserved attempt can finish even when no unreserved credits remain.
      await finishPlanningAttempt({ runId: result.plan.id, householdId: result.plan.household_id, token: result.token }, db);
    }
  });

  it("reserves projected page storage and pauses immediately after a successful hundredth attempt", async () => {
    await resetPlanning();
    await admin.query("update ops.execution_capacity set remaining_attempts=100,remaining_storage_bytes=819199");
    expect(await claimPlanningAttempt(checkpoint(0), db)).toMatchObject({ status: "paused", reason: "capacity" });
    expect((await admin.query("select remaining_attempts::text from ops.execution_capacity")).rows[0].remaining_attempts).toBe("100");
    await expect(resume()).rejects.toThrow();
    await admin.query("update ops.execution_capacity set remaining_storage_bytes=819200");
    await resume();
    await admin.query("update ops.calculation_budget set window_attempts=99,total_attempts=1099 where run_id=$1", [plan.id]);
    const reserved = await claim();
    const result = await finishPlanningAttempt(attempt(reserved.token), db);
    expect(result).toMatchObject({ page: 1, state: "planning" });
    expect(await budget()).toMatchObject({ window_attempts: 100, total_attempts: "1100", state: "paused", reason: "window_limit" });
    expect((await admin.query("select remaining_storage_bytes::text from ops.execution_capacity")).rows[0].remaining_storage_bytes).toBe("0");
  });

}
