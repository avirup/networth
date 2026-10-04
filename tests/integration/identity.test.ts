import { bankBalanceWorkerCases } from "../support/bank-balance-worker-cases";
import { reportReleaseCases } from "../support/report-release-cases";
import { bankCandidateCases } from "../support/bank-candidate-cases";
import { bankBalanceCases } from "../support/bank-balance-cases";
import { bankCalculationCases } from "../support/bank-calculation-cases";
import { planningCases } from "../support/planning-cases";
import { backupRestoreCases } from "../support/backup-restore-cases";
import { workflowCases } from "../support/workflow-cases";
import { importCases } from "../support/import-cases";
import { financialCases } from "../support/financial-cases";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { recoverSoleOwner } from "@/db/auth/admin";
import { hashPassword } from "@/lib/auth/passwords";
import { migrateIdentity } from "@/db/auth/migrate";
import { sql } from "drizzle-orm";
import { createIdentityService } from "@/db/auth/service";

const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const runtimeUrl = new URL(process.env.TEST_DATABASE_URL!);
runtimeUrl.username = "networth_test_app";
runtimeUrl.password = "synthetic-runtime-test-only";
const runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 3 });
const adminUrl = new URL(process.env.TEST_DATABASE_URL!);
adminUrl.username = "networth_test_admin"; adminUrl.password = "synthetic-admin-test-only";
const setupAdmin = new Pool({ connectionString: adminUrl.toString(), max: 2 });
const bootstrapSecret = "synthetic-bootstrap-secret-for-tests-only";
const password = "synthetic owner password";
const service = createIdentityService({ admin: drizzle(setupAdmin), db: drizzle(runtime), runtimeRole: "networth_test_app", secret: "synthetic-auth-secret-for-tests-only", bootstrapSecret });
let reference: string;
let codes: string[];
let ownerId: string;
let householdId: string;

beforeAll(async () => {
  await admin.query("drop schema if exists reporting cascade; drop schema if exists ops cascade");
  await admin.query("drop schema if exists core cascade");
  await admin.query("do $$ begin if not exists(select from pg_roles where rolname='networth_test_admin') then create role networth_test_admin login password 'synthetic-admin-test-only' nosuperuser nocreatedb createrole noinherit nobypassrls; end if; end $$");
  await admin.query("grant create on database networth_test to networth_test_admin");
  await admin.query("do $$ declare r text; begin foreach r in array array['networth_auth','networth_member','networth_worker'] loop if not exists(select from pg_roles where rolname=r) then execute format('create role %I nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls',r); end if; end loop; end $$");
  await admin.query("grant networth_auth,networth_member,networth_worker to networth_test_admin with admin true, inherit false, set true");
  await admin.query("do $$ begin if not exists(select from pg_roles where rolname='networth_test_app') then create role networth_test_app login password 'synthetic-runtime-test-only' noinherit; end if; end $$");
});
afterAll(async () => { await runtime.end(); await setupAdmin.end(); await admin.end(); });
describe("installation and identity", () => {
  it("rejects bootstrap before creating any schema", async () => {
    await expect(service.setup({ setupCode: "wrong" })).rejects.toMatchObject({ status: 400 });
    expect((await admin.query("select to_regclass('core.system_installation') as name")).rows[0].name).toBeNull();
  });
  it("rolls failed authorized migrations back completely", async () => {
    const broken = createIdentityService({ admin: drizzle(setupAdmin), db: drizzle(runtime), runtimeRole: "missing_runtime_role", secret: "synthetic-test-secret", bootstrapSecret });
    await expect(broken.setup({ setupCode: bootstrapSecret, email: "owner@example.test", name: "Synthetic", password })).rejects.toThrow();
    expect((await admin.query("select to_regclass('core.system_installation') as name")).rows[0].name).toBeNull();
  });
  it("serializes setup and irreversibly creates one owner", async () => {
    const input = { setupCode: bootstrapSecret, email: " OWNER@example.test ", name: "Synthetic owner", password };
    const results = await Promise.allSettled([service.setup(input), service.setup(input)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const success = results.find(r => r.status === "fulfilled");
    if (success?.status !== "fulfilled") throw new Error("Setup failed", { cause: results });
    codes = success.value.recoveryCodes;
    expect(codes).toHaveLength(8);
    expect((await admin.query("select count(*)::int as n from core.auth_user")).rows[0].n).toBe(1);
    await expect(admin.query("delete from core.system_installation")).rejects.toMatchObject({ code: "23514" });
  });
  it("signs in, returns generic failures, and restricts unconfirmed security actions", async () => {
    expect(await service.login("missing@example.test", password, "tests")).toBeNull();
    expect(await service.login("owner@example.test", "wrong long password", "tests")).toBeNull();
    const login = await service.login("OWNER@example.test", password, "tests");
    expect(login).not.toBeNull(); reference = login!.reference;
    const actor = await service.resolve(reference); ownerId = actor.userId; householdId = actor.householdId;
    await expect(service.invite(reference, { email: "viewer@example.test", role: "viewer" })).rejects.toMatchObject({ status: 403 });
    await service.confirmPassword(reference, password, "tests");
    await expect(service.changeMember(reference, ownerId, "viewer", "active")).rejects.toMatchObject({ cause: { code: "23514" } });
    expect((await service.resolve(reference)).role).toBe("owner");
  });
  it("consumes invitations once and enforces role boundaries", async () => {
    const token = await service.invite(reference, { email: "viewer@example.test", role: "viewer" });
    const input = { token, email: "viewer@example.test", name: "Synthetic viewer", password: "synthetic viewer password" };
    const results = await Promise.allSettled([service.acceptInvitation(input, "tests"), service.acceptInvitation(input, "tests")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const login = await service.login(input.email, input.password, "tests");
    await expect(service.resolve(login!.reference, "import")).rejects.toMatchObject({ status: 403 });
    await expect(service.members(login!.reference)).rejects.toMatchObject({ status: 403 });
    await expect(service.scoped(login!.reference, householdId, "read", tx => tx.execute(sql`update core.household set name='forbidden' returning id`))).resolves.toMatchObject({ rowCount: 0 });
    await service.scoped(reference, householdId, "read", async tx => {
      expect((await tx.execute(sql`select id from core.household`)).rows).toHaveLength(1);
    });
    await expect(runtime.query("select * from core.household")).rejects.toMatchObject({ code: "42501" });
    await expect(service.resolve(reference, "read", "00000000-0000-0000-0000-000000000001")).rejects.toMatchObject({ status: 401 });
  });
  it("expires credentials, revokes removed members, and consumes reset tokens once", async () => {
    const login = await service.login("viewer@example.test", "synthetic viewer password", "tests");
    const viewer = await service.resolve(login!.reference);
    const expired = await service.invite(reference, { email: "expired@example.test", role: "editor" });
    await admin.query("update core.auth_invitation set expires_at=now()-interval '1 second' where email='expired@example.test'");
    await expect(service.acceptInvitation({ token: expired, email: "expired@example.test", name: "Expired", password }, "tests")).rejects.toMatchObject({ status: 400 });
    const token = await service.issueReset(reference, viewer.userId);
    const input = { email: viewer.email, code: token, password: "new synthetic viewer password", method: "reset" };
    const results = await Promise.allSettled([service.recover(input, "tests"), service.recover(input, "tests")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await expect(service.resolve(login!.reference)).rejects.toMatchObject({ status: 401 });
    await service.changeMember(reference, viewer.userId, "viewer", "disabled");
    expect(await service.login(viewer.email, input.password, "tests")).toBeNull();
  });
  it("isolates a second household and rejects cross-household relationships", async () => {
    const client = await admin.connect();
    let otherHousehold: string, otherUser: string;
    try {
      await client.query("begin");
      otherUser = (await client.query("insert into core.auth_user(email,name) values('other@example.test','Other synthetic owner') returning id")).rows[0].id;
      otherHousehold = (await client.query("insert into core.household(name) values('Other household') returning id")).rows[0].id;
      await client.query("insert into core.household_membership(household_id,user_id,role) values($1,$2,'owner')", [otherHousehold, otherUser]);
      await client.query("commit");
    } finally { client.release(); }
    await service.scoped(reference, householdId, "read", async tx => {
      expect((await tx.execute(sql`select id from core.household`)).rows).toEqual([{ id: householdId }]);
      expect((await tx.execute(sql`update core.household set name='forbidden' where id=${otherHousehold} returning id`)).rows).toHaveLength(0);
    });
    await expect(admin.query("insert into core.auth_invitation(household_id,email,role,token_hash,created_by,expires_at) values($1,'test@example.test','viewer','synthetic',$2,now())", [otherHousehold, ownerId])).rejects.toMatchObject({ code: "23503" });
    const client2 = await runtime.connect();
    try {
      await client2.query("begin"); await client2.query("set local role networth_member");
      expect((await client2.query("select id from core.household")).rows).toHaveLength(0);
      await client2.query("rollback");
      await client2.query("begin"); await client2.query("set local role networth_worker");
      throw new Error("Runtime must not assume worker role");
    } catch (error) { expect(error).toMatchObject({ code: "42501" }); await client2.query("rollback"); }
    finally { client2.release(); }
  });
  it("retains an owner under direct SQL concurrent demotion", async () => {
    const id = (await admin.query("select user_id from core.household_membership where household_id=$1 and user_id<>$2 limit 1", [householdId, ownerId])).rows[0].user_id;
    await admin.query("update core.household_membership set role='owner',state='active' where user_id=$1", [id]);
    const results = await Promise.allSettled([
      admin.query("update core.household_membership set role='viewer' where user_id=$1", [id]),
      admin.query("update core.household_membership set role='viewer' where user_id=$1", [ownerId]),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await admin.query("select count(*)::int as n from core.household_membership where household_id=$1 and role='owner' and state='active'", [householdId])).rows[0].n).toBe(1);
    await admin.query("update core.household_membership set role='owner' where user_id=$1", [ownerId]);
  });
  it("keeps authenticated owner status available while incompatible operations fail closed", async () => {
    await admin.query("update core.system_installation set schema_version=14");
    await expect(service.resolve(reference)).rejects.toMatchObject({ status: 503 });
    expect((await service.resolveStatus(reference)).schemaVersion).toBe(14);
    await admin.query("update core.system_installation set schema_version=13");
  });
  it("replays checksummed migrations and rejects modified history", async () => {
    await drizzle(admin).transaction(tx => migrateIdentity(tx, "networth_test_app"));
    await admin.query("update core.schema_migration set checksum='tampered' where name='0000_identity'");
    await expect(drizzle(admin).transaction(tx => migrateIdentity(tx, "networth_test_app"))).rejects.toThrow("checksum");
    const { readFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const checksum = createHash("sha256").update(await readFile("db/migrations/0000_identity.sql")).digest("hex");
    await admin.query("update core.schema_migration set checksum=$1 where name='0000_identity'", [checksum]);
  });
  it("consumes recovery once and revokes every existing session", async () => {
    const input = { email: "owner@example.test", code: codes[0], password: "replacement synthetic password", method: "code" };
    const results = await Promise.allSettled([service.recover(input, "tests"), service.recover(input, "tests")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await expect(service.resolve(reference)).rejects.toMatchObject({ status: 401 });
    expect(await service.login(input.email, password, "tests")).toBeNull();
    expect(await service.login(input.email, input.password, "tests")).not.toBeNull();
  });
  it("requires the exact sole owner for local recovery and audits revocation", async () => {
    const installationId = (await admin.query("select id from core.system_installation")).rows[0].id;
    const hash = await hashPassword("local recovered synthetic password");
    await expect(recoverSoleOwner(drizzle(admin), "00000000-0000-0000-0000-000000000000", "owner@example.test", hash)).rejects.toThrow("Installation");
    await admin.query("update core.household_membership set role='owner',state='active' where household_id=$1", [householdId]);
    await expect(recoverSoleOwner(drizzle(admin), installationId, "owner@example.test", hash)).rejects.toThrow("sole");
    await admin.query("update core.household_membership set role='viewer' where household_id=$1 and user_id<>$2", [householdId, ownerId]);
    await recoverSoleOwner(drizzle(admin), installationId, "owner@example.test", hash);
    expect((await admin.query("select count(*)::int as n from core.auth_recovery_code where user_id=$1", [ownerId])).rows[0].n).toBe(0);
    expect((await admin.query("select count(*)::int as n from core.security_audit_event where kind='local_owner_recovery'")).rows[0].n).toBe(1);
    expect(await service.login("owner@example.test", "local recovered synthetic password", "tests")).not.toBeNull();
  });
  it("bounds repeated authentication work with persistent buckets", async () => {
    for (let i = 0; i < 10; i++) expect(await service.login("throttled@example.test", password, "throttle-test")).toBeNull();
    await expect(service.login("throttled@example.test", password, "throttle-test")).rejects.toMatchObject({ status: 429 });
  });

  financialCases(admin, service, () => householdId, () => ownerId);
  importCases(admin, service, () => householdId);
  workflowCases(admin, service, () => householdId);
  planningCases(admin, service, () => householdId);
  const calculationSession = bankCalculationCases(admin, service, () => householdId);
  bankCandidateCases(admin, service, () => householdId, calculationSession);
  bankBalanceCases(admin, service, () => householdId, calculationSession);
  const completedBankRun = bankBalanceWorkerCases(admin, service, () => householdId, calculationSession);
  reportReleaseCases(admin, service, () => householdId, calculationSession, completedBankRun);
  backupRestoreCases(admin, service, () => householdId, calculationSession);
});
