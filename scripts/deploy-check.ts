import { Pool } from "pg";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MIGRATIONS } from "@/db/auth/migrate";
import { hostedDatabaseUrl, productionOrigin, RUNTIME_ROLE, WORKER_ROLE } from "@/lib/deployment/config";
import { FINANCIAL_SCHEMA } from "@/lib/config/policy";

type Result = { status: "PASS" | "NEXT" | "FAIL"; label: string };
const results: Result[] = [];
function record(status: Result["status"], label: string) { results.push({ status, label }); }

async function endpoint(origin: string, path: string, label: string) {
  try {
    const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(10_000), redirect: "error" });
    record(response.ok ? "PASS" : "FAIL", `${label} returned HTTP ${response.status}`);
  } catch {
    record("FAIL", `${label} could not be reached`);
  }
}

async function queryIdentity(url: string, role: string, kind: "runtime" | "worker") {
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
  try {
    const response = await pool.query<{ current_user: string; safe: boolean }>(`
      select current_user, not rolsuper and not rolbypassrls and not rolcreaterole and not rolcreatedb
        and current_user=$1
        and case when $2='runtime' then pg_has_role(current_user,'networth_auth','MEMBER') and pg_has_role(current_user,'networth_member','MEMBER') and not pg_has_role(current_user,'networth_worker','MEMBER')
          else pg_has_role(current_user,'networth_worker','MEMBER') and not pg_has_role(current_user,'networth_auth','MEMBER') and not pg_has_role(current_user,'networth_member','MEMBER') end as safe
      from pg_roles where rolname=current_user
    `, [role, kind]);
    record(response.rows[0]?.safe ? "PASS" : "FAIL", `${kind} database identity is restricted and separated`);
  } catch {
    record("FAIL", `${kind} database connection or role check failed`);
  } finally {
    await pool.end();
  }
}

async function main() {
  const appUrl = productionOrigin(process.env.APP_URL ?? "");
  const adminUrl = hostedDatabaseUrl(process.env.DATABASE_ADMIN_URL ?? "");
  const runtimeUrl = hostedDatabaseUrl(process.env.DATABASE_URL ?? "");
  const workerUrl = hostedDatabaseUrl(process.env.DATABASE_WORKER_URL ?? "");

  await endpoint(appUrl, "/api/health", "Application health");
  await endpoint(appUrl, "/api/inngest", "Inngest endpoint");
  await queryIdentity(runtimeUrl, RUNTIME_ROLE, "runtime");
  await queryIdentity(workerUrl, WORKER_ROLE, "worker");

  const admin = new Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
  try {
    const migration = await admin.query<{ name: string; checksum: string }>("select name,checksum from core.schema_migration order by name");
    const expected = new Map<string, string>(await Promise.all(MIGRATIONS.map(async name => [
      name,
      createHash("sha256").update(await readFile(join(process.cwd(), "db/migrations", `${name}.sql`))).digest("hex"),
    ] as const)));
    const migrationsMatch = migration.rows.length === expected.size
      && migration.rows.every(row => expected.get(row.name) === row.checksum);
    record(migrationsMatch ? "PASS" : "FAIL", "all reviewed migrations and checksums are recorded");
    const installation = await admin.query<{ schema_version: number }>("select schema_version from core.system_installation");
    record(installation.rows[0]?.schema_version === FINANCIAL_SCHEMA ? "PASS" : "NEXT", `first owner setup and schema version ${FINANCIAL_SCHEMA}`);
    const capacity = await admin.query<{ active: boolean }>(`select coalesce((select workflow_verified and verified_until>clock_timestamp() and remaining_imports>0 and remaining_storage_bytes>0 from ops.import_admission where singleton),false)
      and coalesce((select verified_until>clock_timestamp() and remaining_attempts>0 and remaining_storage_bytes>0 from ops.execution_capacity where singleton),false) active`);
    record(capacity.rows[0]?.active ? "PASS" : "NEXT", "current reviewed import capacity lease");
  } catch {
    record("FAIL", "administrative schema verification failed");
  } finally {
    await admin.end();
  }

  for (const result of results) console.info(`${result.status.padEnd(4)}  ${result.label}`);
  console.info("\nManual final step: remove DATABASE_ADMIN_URL and BOOTSTRAP_SECRET from Vercel Production, then redeploy.");
  if (results.some(result => result.status === "FAIL")) process.exitCode = 1;
  else if (results.some(result => result.status === "NEXT")) process.exitCode = 2;
}

try {
  await main();
} catch {
  console.error("Deployment check failed before verification started. Run npm run deploy:prepare and keep the private deployment configuration. No credential was logged.");
  process.exitCode = 1;
}
