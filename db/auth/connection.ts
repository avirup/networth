import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { inspectEnvironment } from "@/lib/config/environment";
import { canUseDatabase } from "@/lib/config/policy";
import { AccessError } from "@/lib/auth/errors";

const pools = new Map<string, Pool>();
export type Database = NodePgDatabase;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export function authDatabase(admin = false): Database {
  const environment = inspectEnvironment();
  if (!canUseDatabase(environment) || !environment.values.AUTH_SECRET) throw new AccessError(503, "Authentication is not configured.");
  const url = admin ? environment.values.DATABASE_ADMIN_URL : environment.values.DATABASE_URL;
  if (!url) throw new AccessError(503, "Setup requires the migration connection.");
  let pool = pools.get(url);
  if (!pool) {
    pool = new Pool({ connectionString: url, max: admin ? 1 : 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: admin ? 15000 : 8000, allowExitOnIdle: true });
    pool.on("error", () => {}); pools.set(url, pool);
  }
  return drizzle(pool);
}
export async function serviceTransaction<T>(work: (tx: Transaction) => Promise<T>, db = authDatabase()) {
  return db.transaction(async tx => {
    const role = await tx.execute<{ unsafe: boolean }>(sql`select rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or oid=(select relowner from pg_class where oid=to_regclass('core.auth_user')) as unsafe from pg_roles where rolname=current_user`);
    if (role.rows[0]?.unsafe !== false) throw new AccessError(503, "Use a restricted runtime database role.");
    await tx.execute(sql`set local role networth_auth`);
    return work(tx);
  });
}
export async function closeAuthPools() { await Promise.all([...pools.values()].map(pool => pool.end())); pools.clear(); }
