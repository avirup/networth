import "server-only";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type { Database, Transaction } from "@/db/auth/connection";
import { inspectEnvironment } from "@/lib/config/environment";
import { canServeWorkflows } from "@/lib/config/policy";
import { AccessError } from "@/lib/auth/errors";
let pool: Pool | undefined;
export function workerDatabase(): Database {
  const env = inspectEnvironment();
  if (!canServeWorkflows(env) || !env.values.DATABASE_WORKER_URL) throw new AccessError(503, "The restricted workflow connection is not configured.");
  if (!pool) {
    pool = new Pool({ connectionString: env.values.DATABASE_WORKER_URL, max: 2, connectionTimeoutMillis: 3000, statement_timeout: 5000, idleTimeoutMillis: 10000, allowExitOnIdle: true });
    pool.on("error", () => {});
  }
  return drizzle(pool);
}
export async function workerTransaction<T>(work: (tx: Transaction) => Promise<T>, db = workerDatabase()) {
  return db.transaction(async tx => {
    const role = await tx.execute<{ safe: boolean }>(sql`select not rolsuper and not rolbypassrls and not rolcreaterole and not rolcreatedb
      and not pg_has_role(current_user,'networth_member','MEMBER') and not pg_has_role(current_user,'networth_auth','MEMBER')
      and pg_has_role(current_user,'networth_worker','MEMBER')
      and not exists(select from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relowner=pg_roles.oid and n.nspname in ('core','ops','reporting')) as safe
      from pg_roles where rolname=current_user`);
    if (role.rows[0]?.safe !== true) throw new AccessError(503, "Use a separate least-privilege workflow database role.");
    await tx.execute(sql`set local role networth_worker`);
    return work(tx);
  });
}
export async function closeWorkerPool() { await pool?.end(); pool = undefined; }
