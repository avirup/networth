import { recoverSoleOwner } from "@/db/auth/admin";
import nextEnv from "@next/env";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { sql } from "drizzle-orm";
import { authDatabase, closeAuthPools } from "@/db/auth/connection";
import { migrateIdentity, migrationLock } from "@/db/auth/migrate";
import { hashPassword } from "@/lib/auth/passwords";
import { inspectEnvironment } from "@/lib/config/environment";
import { canServeWorkflows } from "@/lib/config/policy";
nextEnv.loadEnvConfig(process.cwd());
async function main() {
  if (process.env.VERCEL) throw new Error("Run this command locally as the deployment administrator.");
  const env = inspectEnvironment();
  const mode = process.argv[2];
  if (!["migrate", "recover-owner", "prepare-worker", "verify-capacity"].includes(mode ?? "") || !env.values.DATABASE_URL || !env.values.DATABASE_ADMIN_URL || env.invalid.length) throw new Error("Configure the runtime and admin connections, then choose migrate, prepare-worker, verify-capacity or recover-owner.");
  const admin = authDatabase(true);
  if (mode === "verify-capacity") {
    if (!canServeWorkflows(env) || !env.values.DATABASE_WORKER_URL) throw new Error("Configure the signed workflow endpoint and restricted worker before verification.");
    const [importsRaw, attemptsRaw, storageRaw, minutesRaw, ...reasonParts] = process.argv.slice(3);
    const imports = Number(importsRaw), attempts = Number(attemptsRaw), storage = Number(storageRaw), minutes = Number(minutesRaw), reason = reasonParts.join(" ").trim();
    if (!Number.isSafeInteger(imports) || imports < 0 || imports > 1000 || !Number.isSafeInteger(attempts) || attempts < 0 || attempts > 1_000_000
      || !Number.isSafeInteger(storage) || storage < 0 || storage > 400_000_000 || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440
      || reason.length < 1 || reason.length > 500) throw new Error("Provide reviewed import, calculation-attempt and storage budgets, lease minutes, and a short verification reason.");
    await admin.transaction(async tx => {
      await migrationLock(tx);
      const state = await tx.execute<{ schema_version: number; size: string }>(sql`select schema_version,pg_database_size(current_database())::text size from core.system_installation`);
      if (state.rows[0]?.schema_version !== 9 || BigInt(state.rows[0].size) + BigInt(storage) > 400_000_000n) throw new Error("Schema or database storage headroom is insufficient.");
      await tx.execute(sql`insert into ops.import_admission(singleton,verified_until,workflow_verified,remaining_imports,remaining_storage_bytes,reason)
        values(true,clock_timestamp()+make_interval(mins=>${minutes}),true,${imports},${storage},${reason})
        on conflict(singleton) do update set verified_until=excluded.verified_until,workflow_verified=true,remaining_imports=excluded.remaining_imports,remaining_storage_bytes=excluded.remaining_storage_bytes,reason=excluded.reason`);
      await tx.execute(sql`insert into ops.execution_capacity(singleton,verified_until,remaining_attempts,remaining_storage_bytes)
        values(true,clock_timestamp()+make_interval(mins=>${minutes}),${attempts},${storage})
        on conflict(singleton) do update set verified_until=excluded.verified_until,remaining_attempts=excluded.remaining_attempts,remaining_storage_bytes=excluded.remaining_storage_bytes`);
    });
    console.info("Reviewed workflow capacity lease recorded. Confirmation and calculation remain bounded by these counters."); return;
  }
  if (mode === "prepare-worker") {
    if (!env.values.DATABASE_WORKER_URL) throw new Error("Configure the separate worker connection.");
    const role = decodeURIComponent(new URL(env.values.DATABASE_WORKER_URL).username);
    await admin.transaction(async tx => {
      const valid = await tx.execute<{ safe: boolean }>(sql`select rolcanlogin and not rolsuper and not rolbypassrls and not rolcreaterole and not rolcreatedb
        and not pg_has_role(rolname,'networth_auth','MEMBER') and not pg_has_role(rolname,'networth_member','MEMBER')
        and not exists(select from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relowner=pg_roles.oid and n.nspname in ('core','ops','reporting')) as safe from pg_roles where rolname=${role}`);
      if (valid.rows[0]?.safe !== true) throw new Error("Create a separate restricted login first.");
      await tx.execute(sql`grant networth_worker to ${sql.identifier(role)} with inherit false`);
    });
    console.info("Restricted worker role prepared. This does not enable financial confirmation."); return;
  }
  if (mode === "migrate") {
    await admin.transaction(async tx => {
      await migrationLock(tx);
      const state = await tx.execute(sql`select id from core.system_installation`);
      if (state.rows.length !== 1) throw new Error("Complete authorized owner setup first.");
      await migrateIdentity(tx, decodeURIComponent(new URL(env.values.DATABASE_URL!).username));
    });
    console.info("Reviewed migrations applied."); return;
  }
  if (!process.stdin.isTTY) throw new Error("Owner recovery requires an interactive local terminal.");
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!hidden) process.stdout.write(chunk, encoding); callback(); } });
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  let installationId: string, email: string, password: string;
  try {
    installationId = await terminal.question("Installation UUID (from your database): ");
    email = (await terminal.question("Sole owner's email: ")).trim().toLowerCase();
    process.stdout.write("New password (hidden, at least 12 characters): "); hidden = true;
    password = await terminal.question(""); hidden = false; process.stdout.write("\n");
  } finally { hidden = false; terminal.close(); }
  const passwordHash = await hashPassword(password);
  await recoverSoleOwner(admin, installationId, email, passwordHash);
  console.info("Owner password replaced; sessions and recovery codes revoked. Sign in and generate new recovery codes.");
}
try { await main(); } catch { console.error("Administration failed. Verify configuration, installation identity and command prerequisites. No credentials were logged."); process.exitCode = 1; } finally { await closeAuthPools(); }
