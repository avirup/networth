import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { createIdentityService } from "@/db/auth/service";
import { readCardEvidence } from "@/db/cards/evidence";
import { exportHouseholdBackup, restoreHouseholdBackup } from "@/db/backup/service";
import { migrateIdentity } from "@/db/auth/migrate";
import { confirmCardImport, reviewCardImport } from "@/db/imports/card-service";
import { readBankOverview } from "@/db/reports/service";

const sourceUrl = new URL(process.env.TEST_DATABASE_URL!);
const database = `networth_card_${randomUUID().replaceAll("-", "")}`;
const maintenanceUrl = new URL(sourceUrl); maintenanceUrl.pathname = "/postgres";
const maintenance = new Pool({ connectionString: maintenanceUrl.toString(), max: 1 });
const targetUrl = new URL(sourceUrl); targetUrl.pathname = `/${database}`;
const admin = new Pool({ connectionString: targetUrl.toString(), max: 2 });
const runtimeUrl = new URL(targetUrl); runtimeUrl.username = "networth_card_test_app"; runtimeUrl.password = "synthetic-card-test-only";
const runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 2 });
const secret = "synthetic-card-evidence-auth-secret-only";
const service = createIdentityService({ db: drizzle(runtime), admin: drizzle(admin), secret, bootstrapSecret: secret, runtimeRole: "networth_card_test_app" });
let household: string, owner: string, reference: string, card: string, facility: string, sourceId: string, observationId: string, revision = 0;

beforeAll(async () => {
  await maintenance.query("do $$ begin if not exists(select from pg_roles where rolname='networth_card_test_app') then create role networth_card_test_app login password 'synthetic-card-test-only' noinherit nosuperuser nocreatedb nocreaterole nobypassrls; end if; end $$");
  await maintenance.query(`create database "${database}"`);
  await service.setup({ setupCode: secret, name: "Synthetic card owner", email: "card@example.test", password: "synthetic card owner password" });
  const login = await service.login("card@example.test", "synthetic card owner password", "card-tests");
  reference = login!.reference;
  const actor = await service.resolve(reference); household = actor.householdId; owner = actor.userId;
  card = (await admin.query("insert into core.dim_account(household_id,name,kind,currency) values($1,'Synthetic card','credit_card','INR') returning id", [household])).rows[0].id;
  facility = (await admin.query("insert into core.credit_facility(household_id,name) values($1,'Synthetic shared facility') returning id", [household])).rows[0].id;
}, 30_000);
afterAll(async () => {
  await runtime.end(); await admin.end();
  for (let i = 0; i < 100; i++) {
    if ((await maintenance.query("select count(*)::int n from pg_stat_activity where datname=$1", [database])).rows[0].n === 0) break;
    await delay(50);
  }
  await maintenance.query(`drop database if exists "${database}"`); await maintenance.end();
});

async function batch(limit: string | null, options: { effective?: string; unlink?: boolean; due?: string; minimum?: string; invalid?: (client: PoolClient, source: string, observation: string) => Promise<unknown> } = {}) {
  const client = await admin.connect();
  try {
    await client.query("begin");
    const next = (await client.query("update ops.source_revision set revision=revision+1 where household_id=$1 returning revision", [household])).rows[0].revision;
    const id = (await client.query("insert into core.import_batch(household_id,account_id,schema_version,idempotency_key,content_hash,coverage_start,coverage_end,completeness,row_count,request_bytes,revision,reviewed_by) values($1,$2,'card-v1',$3,$4,'2026-09-01','2026-10-31','balance_only',1,500,$5,$6) returning id", [household,card,randomUUID(),"c".repeat(64),next,owner])).rows[0].id;
    const source = (await client.query("insert into core.source_record(household_id,batch_id,row_number,row_hash,payload) values($1,$2,1,$3,'{}') returning id", [household,id,"d".repeat(64)])).rows[0].id;
    const observation = (await client.query("insert into core.fact_statement_observation(household_id,source_id,account_id,as_of,kind,balance,currency) values($1,$2,$3,'2026-10-31','closing',5000,'INR') returning id", [household,source,card])).rows[0].id;
    await client.query("insert into core.card_statement(household_id,observation_id,payment_due_date,minimum_due) values($1,$2,$3,$4)", [household,observation,options.due ?? "2026-11-20",options.minimum ?? "500"]);
    await client.query("insert into core.credit_facility_term(household_id,facility_id,source_id,effective_date,limit_inr) values($1,$2,$3,$4,$5)", [household,facility,source,options.effective ?? "2026-09-01",limit]);
    await client.query("insert into core.account_facility_link(household_id,account_id,facility_id,source_id,effective_date) values($1,$2,$3,$4,$5)", [household,card,options.unlink ? null : facility,source,options.effective ?? "2026-09-01"]);
    await client.query("insert into ops.outbox_event(household_id,batch_id,revision) values($1,$2,$3)", [household,id,next]);
    await client.query("insert into ops.rebuild_request(household_id,batch_id,account_id,earliest_date,revision) values($1,$2,$3,'2026-09-01',$4)", [household,id,card,next]);
    await options.invalid?.(client, source, observation);
    await client.query("commit"); revision = next; sourceId = source; observationId = observation;
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}
const evidence = (date: string, watermark = revision) => service.scoped(reference, household, "read", (tx, actor) => readCardEvidence(tx, actor, date, watermark));

describe("card evidence database contracts", () => {
  it("commits facility, link and due metadata with source evidence", async () => {
    await batch("10000");
    const result = await evidence("2026-10-31");
    expect(result.terms).toMatchObject([{ facilityId: facility, limitInr: "10000", revision: 1 }]);
    expect(result.links).toMatchObject([{ accountId: card, facilityId: facility }]);
    expect(result.statements).toMatchObject([{ outstandingInr: "5000", minimumDue: "500", paymentDueDate: "2026-11-20" }]);
  });
  it("selects historical effective dates and captured revisions, including unknown limits and unlink evidence", async () => {
    await batch("20000", { effective: "2026-10-01" });
    expect((await evidence("2026-09-30")).terms[0]?.limitInr).toBe("10000");
    expect((await evidence("2026-10-31", 1)).terms[0]?.limitInr).toBe("10000");
    expect((await evidence("2026-10-31")).terms[0]?.limitInr).toBe("20000");
    await batch(null, { effective: "2026-10-01", unlink: true });
    expect((await evidence("2026-10-31")).terms[0]?.limitInr).toBeNull();
    expect((await evidence("2026-10-31")).links[0]?.facilityId).toBeNull();
    expect((await evidence("2026-10-31", 2)).links[0]?.facilityId).toBe(facility);
    await expect(evidence("2026-10-31", 4)).rejects.toMatchObject({ status: 400 });
  });
  it("rejects invalid limits and due amounts with whole-batch rollback", async () => {
    for (const limit of ["-1", "1.001", "NaN", "Infinity"]) await expect(batch(limit)).rejects.toMatchObject({ code: "23514" });
    for (const minimum of ["-1", "0.001", "5001"])
      await expect(batch("10000", { minimum })).rejects.toMatchObject({ code: "23514" });
    await expect(batch("10000", { due: "2026-10-30" })).rejects.toMatchObject({ code: "23514" });
    await expect(batch("10000", { invalid: async (client, _source, observation) => {
      await client.query("delete from core.card_statement where observation_id=$1", [observation]);
    } })).rejects.toMatchObject({ code: "23514" });
    expect((await admin.query("select revision from ops.source_revision where household_id=$1", [household])).rows[0].revision).toBe(3);
  });
  it("rejects later mutation, detached evidence and ambiguous limits in the same batch", async () => {
    await expect(admin.query("update core.credit_facility_term set limit_inr=1 where household_id=$1", [household])).rejects.toMatchObject({ code: "23514" });
    await expect(admin.query("insert into core.credit_facility_term(household_id,facility_id,source_id,effective_date,limit_inr) values($1,$2,$3,'2026-09-01',1)", [household,facility,sourceId])).rejects.toMatchObject({ code: "23514" });
    await expect(batch("10000", { invalid: async (client, source) => {
      await client.query("insert into core.credit_facility_term(household_id,facility_id,source_id,effective_date,limit_inr) values($1,$2,$3,'2026-09-01',5)", [household,facility,source]);
    } })).rejects.toMatchObject({ code: "23514" });
    expect((await admin.query("select count(*)::int n from core.import_batch")).rows[0].n).toBe(3);
  });
  it("enforces household isolation and rejects anonymous direct reads", async () => {
    const other = await drizzle(admin).transaction(async tx => {
      const user = (await tx.execute<{ id: string }>(sql`insert into core.auth_user(name,email) values('Synthetic other owner','other-card@example.test') returning id`)).rows[0]!.id;
      const household = (await tx.execute<{ id: string }>(sql`insert into core.household(name) values('Synthetic other household') returning id`)).rows[0]!.id;
      await tx.execute(sql`insert into core.household_membership(household_id,user_id,role) values(${household},${user},'owner')`);
      return household;
    });
    await admin.query("insert into core.credit_facility(household_id,name) values($1,'Other private facility')", [other]);
    const result = await service.scoped(reference, household, "read", tx => tx.execute(sql`select name from core.credit_facility`));
    expect(result.rows).toEqual([{ name: "Synthetic shared facility" }]);
    await expect(runtime.query("select * from core.credit_facility")).rejects.toMatchObject({ code: "42501" });
    await expect(batch("10000", { invalid: async client => {
      await client.query("insert into core.card_statement(household_id,observation_id) values($1,$2)", [other,observationId]);
    } })).rejects.toMatchObject({ code: "23514" });
  });
});

it("atomically confirms card activity and serves liabilities from the same release", async () => {
  const bank = (await admin.query("insert into core.dim_account(household_id,name,kind,currency) values($1,'Synthetic repayment bank','bank','INR') returning id", [household])).rows[0].id;
  await admin.query("insert into ops.import_admission(singleton,verified_until,workflow_verified,remaining_imports,remaining_storage_bytes,reason) values(true,now()+interval '1 hour',true,100,300000000,'synthetic card test') on conflict(singleton) do update set verified_until=excluded.verified_until,workflow_verified=true,remaining_imports=excluded.remaining_imports,remaining_storage_bytes=excluded.remaining_storage_bytes,reason=excluded.reason");
  const rows = [
    { schema_version: "card-v1", row_id: "purchase", transaction_ref: "p-1", transaction_date: "2026-11-05", description: "Synthetic grocery", direction: "debit", amount: "200", currency: "INR", event_type: "card_purchase", category: "grocery", related_row_id: "" },
    { schema_version: "card-v1", row_id: "refund", transaction_ref: "r-1", transaction_date: "2026-11-08", description: "Synthetic refund", direction: "credit", amount: "20", currency: "INR", event_type: "card_refund", category: "grocery", related_row_id: "purchase" },
    { schema_version: "card-v1", row_id: "interest", transaction_ref: "i-1", transaction_date: "2026-11-20", description: "Synthetic interest", direction: "debit", amount: "10", currency: "INR", event_type: "card_interest", category: "fees", related_row_id: "" },
    { schema_version: "card-v1", row_id: "repayment", transaction_ref: "pay-1", transaction_date: "2026-11-25", description: "Synthetic repayment", direction: "credit", amount: "100", currency: "INR", event_type: "card_repayment", category: "", related_row_id: "" },
  ];
  const input = {
    idempotencyKey: randomUUID(), expectedRevision: revision,
    manifest: { schemaVersion: "card-v1", accountId: card, currency: "INR", coverageStart: "2026-11-01", coverageEnd: "2026-11-30", completeness: "complete", openingOutstanding: "1000", statementOutstanding: "1090", historyReason: "", paymentDueDate: "2026-12-20", minimumDue: "100" },
    facility: { id: facility, limitInr: "2000" }, newAccount: undefined,
    rows, decisions: { purchase: { action: "new", note: "" }, refund: { action: "new", note: "" }, interest: { action: "new", note: "" }, repayment: { action: "new", note: "", offsetAccountId: bank } },
    acknowledgements: ["equity"], openingDecision: { action: "establish", note: "Reviewed synthetic opening debt" },
  };
  const reviewed = await service.scoped(reference, household, "import", (tx, actor) => reviewCardImport(tx, actor, input));
  expect(reviewed.reconciliation.status).toBe("matched");
  expect(reviewed.warnings.map(item => item.code)).toEqual(["equity"]);
  const requestBytes = Buffer.byteLength(JSON.stringify(input));
  const confirmed = await service.scoped(reference, household, "import", (tx, actor) => confirmCardImport(tx, actor, input, requestBytes, true));
  revision = confirmed.revision;
  expect(confirmed).toMatchObject({ revision: 4, retry: false, state: "committed" });
  expect((await admin.query("select count(*)::int n from core.transaction_event where batch_id=$1 and state='confirmed'", [confirmed.batchId])).rows[0].n).toBe(5);
  expect((await admin.query("select coalesce(sum(p.book_amount_inr),0)::text amount from core.fact_posting p join core.transaction_event e on e.id=p.event_id where e.batch_id=$1", [confirmed.batchId])).rows[0].amount).toBe("0.000000000000");
  expect((await admin.query("select count(*)::int n from ops.rebuild_request where batch_id=$1", [confirmed.batchId])).rows[0].n).toBe(2);

  const run = (await admin.query("insert into ops.calculation_run(household_id,source_revision,rule_version,state) values($1,$2,'bank-plan-v1','prepared') returning id", [household, revision])).rows[0].id;
  const generation = (await admin.query("insert into ops.bank_candidate(run_id,household_id,as_of,state) values($1,$2,'2026-11-30','calculated') returning generation_id", [run, household])).rows[0].generation_id;
  await admin.query("insert into ops.bank_balance_candidate(run_id,household_id,generation_id,state) values($1,$2,$3,'calculated')", [run, household, generation]);
  const release = (await admin.query("insert into ops.report_release(household_id,run_id,source_revision,as_of) values($1,$2,$3,'2026-11-30') returning id", [household, run, revision])).rows[0].id;
  await admin.query("insert into ops.current_report_release(household_id,release_id) values($1,$2)", [household, release]);
  const report = await service.scoped(reference, household, "read", (tx, actor) => readBankOverview(tx, actor, "2026-11"));
  expect(report?.summary).toMatchObject({ knownLiabilitiesInr: "1090.000000000000", netWorthInr: "-1090", monthlyExpenseInr: "190" });
  expect(report?.liabilities.cards[0]).toMatchObject({ accountId: card, statementOutstandingInr: "1090", currentOutstandingInr: "1090", minimumDueInr: "100" });
  expect(report?.liabilities.facilities[0]).toMatchObject({ facilityId: facility, limitInr: "2000.000000000000", drawnInr: "1090.000000000000", availableCreditInr: "910.000000000000", utilizationPercent: "54.500000" });
  expect(report?.categories).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "expense", category: "Grocery", amountInr: "180" }), expect.objectContaining({ kind: "expense", category: "Fees & charges", amountInr: "10" })]));
});


it("round-trips card evidence and its captured history through encrypted backup", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "networth-card-backup-"));
  const directory = path.join(parent, "backup");
  const restoredDatabase = `${database}_restored`;
  const restoredUrl = new URL(targetUrl); restoredUrl.pathname = `/${restoredDatabase}`;
  const restoredAdmin = new Pool({ connectionString: restoredUrl.toString(), max: 1 });
  const restoredRuntimeUrl = new URL(runtimeUrl); restoredRuntimeUrl.pathname = `/${restoredDatabase}`;
  const restoredRuntime = new Pool({ connectionString: restoredRuntimeUrl.toString(), max: 1 });
  try {
    const expected = await evidence("2026-10-31");
    const oldExpected = await evidence("2026-10-31", 1);
    await exportHouseholdBackup({ pool: admin, directory, ownerEmail: "card@example.test", ownerPassword: "synthetic card owner password", passphrase: "synthetic card backup passphrase" });
    await maintenance.query(`create database "${restoredDatabase}"`);
    await drizzle(restoredAdmin).transaction(tx => migrateIdentity(tx, "networth_card_test_app"));
    await restoreHouseholdBackup({ pool: restoredAdmin, directory, ownerEmail: "card@example.test", ownerPassword: "restored synthetic card password", passphrase: "synthetic card backup passphrase", authSecret: secret });
    const restored = createIdentityService({ db: drizzle(restoredRuntime), admin: drizzle(restoredAdmin), secret, runtimeRole: "networth_card_test_app" });
    const login = await restored.login("card@example.test", "restored synthetic card password", "restored-card-test");
    expect(login).not.toBeNull();
    const actual = await restored.scoped(login!.reference, household, "read", (tx, actor) => readCardEvidence(tx, actor, "2026-10-31", revision));
    expect(actual).toEqual(expected);
    expect(await restored.scoped(login!.reference, household, "read", (tx, actor) => readCardEvidence(tx, actor, "2026-10-31", 1))).toEqual(oldExpected);
  } finally {
    await restoredRuntime.end(); await restoredAdmin.end();
    for (let i = 0; i < 100; i++) {
      if ((await maintenance.query("select count(*)::int n from pg_stat_activity where datname=$1", [restoredDatabase])).rows[0].n === 0) break;
      await delay(50);
    }
    await maintenance.query(`drop database if exists "${restoredDatabase}"`);
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);
