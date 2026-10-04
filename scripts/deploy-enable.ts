import { createInterface } from "node:readline/promises";
import { Pool } from "pg";
import { capacityPreset, hostedDatabaseUrl, productionOrigin, WORKER_ROLE } from "@/lib/deployment/config";
import { FINANCIAL_SCHEMA } from "@/lib/config/policy";

async function endpointAvailable(origin: string, path: string) {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(10_000), redirect: "error" });
  return response.ok;
}

async function main() {
  if (process.env.VERCEL || process.env.NODE_ENV === "production" || !process.stdin.isTTY) {
    throw new Error("Run capacity enablement in an interactive terminal on a trusted computer.");
  }
  const preset = capacityPreset(process.argv[2]);
  const adminUrl = hostedDatabaseUrl(process.env.DATABASE_ADMIN_URL ?? "");
  const appUrl = productionOrigin(process.env.APP_URL ?? "");

  if (!await endpointAvailable(appUrl, "/api/health")) throw new Error("The production health endpoint is unavailable.");
  if (!await endpointAvailable(appUrl, "/api/inngest")) throw new Error("The production Inngest endpoint is not registered yet.");

  console.info(`Preset: ${preset.name} — ${preset.description}`);
  console.info(`Limits for the next 24 hours: ${preset.imports} imports, ${preset.attempts} calculation attempts, ${preset.storageBytes} derived bytes.`);
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let confirmed = "";
  try {
    confirmed = (await terminal.question("Have you checked Neon, Vercel and Inngest usage and confirmed every account is below 80%? [y/N] ")).trim().toLowerCase();
  } finally {
    terminal.close();
  }
  if (confirmed !== "y" && confirmed !== "yes") throw new Error("Provider usage review was not confirmed.");

  const pool = new Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 15_000 });
  try {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(716284913)");
      const state = await client.query<{ schema_version: number; size: string; worker_safe: boolean }>(`
        select i.schema_version, pg_database_size(current_database())::text size,
          coalesce((select rolcanlogin and not rolsuper and not rolbypassrls and not rolcreaterole and not rolcreatedb
            and pg_has_role(rolname,'networth_worker','MEMBER')
            and not pg_has_role(rolname,'networth_auth','MEMBER') and not pg_has_role(rolname,'networth_member','MEMBER')
            from pg_roles where rolname=$1),false) worker_safe
        from core.system_installation i
      `, [WORKER_ROLE]);
      const row = state.rows[0];
      if (!row || row.schema_version !== FINANCIAL_SCHEMA || !row.worker_safe || BigInt(row.size) + BigInt(preset.storageBytes) > 400_000_000n) {
        throw new Error("The owner setup, worker restriction, schema or database headroom check failed.");
      }
      const reason = `${preset.name} preset after manual Neon, Vercel and Inngest dashboard review`;
      await client.query(`insert into ops.import_admission(singleton,verified_until,workflow_verified,remaining_imports,remaining_storage_bytes,reason)
        values(true,clock_timestamp()+make_interval(mins=>$1),true,$2,$3,$4)
        on conflict(singleton) do update set verified_until=excluded.verified_until,workflow_verified=true,remaining_imports=excluded.remaining_imports,remaining_storage_bytes=excluded.remaining_storage_bytes,reason=excluded.reason`,
      [preset.minutes, preset.imports, preset.storageBytes, reason]);
      await client.query(`insert into ops.execution_capacity(singleton,verified_until,remaining_attempts,remaining_storage_bytes)
        values(true,clock_timestamp()+make_interval(mins=>$1),$2,$3)
        on conflict(singleton) do update set verified_until=excluded.verified_until,remaining_attempts=excluded.remaining_attempts,remaining_storage_bytes=excluded.remaining_storage_bytes`,
      [preset.minutes, preset.attempts, preset.storageBytes]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  console.info(`The ${preset.name} import lease is active for 24 hours. Run npm run deploy:check to verify the installation.`);
}

try {
  await main();
} catch {
  console.error("Import enablement failed. Verify deployment, Inngest registration, owner setup, provider usage and database headroom. No credential was logged.");
  process.exitCode = 1;
}
