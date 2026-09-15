import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { inspectEnvironment } from "@/lib/config/environment";
import { canUseDatabase } from "@/lib/config/policy";
import { logSafeEvent } from "@/lib/config/logging";

let pool: Pool | undefined;

export function getDatabase() {
  const environment = inspectEnvironment();
  if (!canUseDatabase(environment)) throw new Error("Database access is unavailable.");
  pool ??= new Pool({
    connectionString: environment.values.DATABASE_URL,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 3_000,
    allowExitOnIdle: true,
  });
  // A Pool error without a listener can otherwise terminate the process.
  if (pool.listenerCount("error") === 0) pool.on("error", () => logSafeEvent({ event: "database_unavailable" }));
  return drizzle(pool);
}
