import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Transaction } from "./connection";

export const MIGRATIONS = ["0000_identity", "0001_security", "0002_financial_foundation", "0003_financial_guards", "0004_import_admission", "0005_workflow_delivery", "0006_calculation_planning", "0007_planning_execution", "0008_bank_candidates", "0009_bank_balance_checkpoints", "0010_report_releases"] as const;
export async function migrationLock(tx: Transaction) { await tx.execute(sql`select pg_advisory_xact_lock(716284913)`); }
export async function migrateIdentity(tx: Transaction, runtimeRole: string) {
  await migrationLock(tx);
  await tx.execute(sql`create schema if not exists core`);
  await tx.execute(sql`create table if not exists core.schema_migration (name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
  const existing = await tx.execute<{ name: string; checksum: string }>(sql`select name, checksum from core.schema_migration order by name`);
  if (existing.rows.some(row => !MIGRATIONS.includes(row.name as typeof MIGRATIONS[number]))) throw new Error("Database migrations are newer than this application.");
  for (const name of MIGRATIONS) {
    const source = await readFile(join(process.cwd(), "db/migrations", `${name}.sql`), "utf8");
    const checksum = createHash("sha256").update(source).digest("hex");
    const applied = existing.rows.find(row => row.name === name);
    if (applied) { if (applied.checksum !== checksum) throw new Error("Applied migration checksum mismatch."); continue; }
    for (const statement of source.split("--> statement-breakpoint")) if (statement.trim()) await tx.execute(sql.raw(statement));
    await tx.execute(sql`insert into core.schema_migration(name,checksum) values(${name},${checksum})`);
  }
  const valid = await tx.execute<{ safe: boolean }>(sql`select not rolsuper and not rolbypassrls and not rolcreaterole and not rolcreatedb and rolname<>current_user as safe from pg_roles where rolname=${runtimeRole}`);
  if (!valid.rows[0]?.safe) throw new Error("A separate restricted runtime role is required.");
  await tx.execute(sql`grant usage on schema core to ${sql.identifier(runtimeRole)}`);
  await tx.execute(sql`grant networth_auth, networth_member to ${sql.identifier(runtimeRole)} with inherit false`);
  await tx.execute(sql`revoke all on core.schema_migration from public, networth_auth, networth_member`);
}
