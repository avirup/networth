import { randomBytes } from "node:crypto";
import { access, rename, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { migrateIdentity } from "@/db/auth/migrate";
import {
  DEPLOYMENT_CONFIG_FILE,
  RUNTIME_ROLE,
  WORKER_ROLE,
  deploymentEnvironment,
  hostedDatabaseUrl,
  productionOrigin,
} from "@/lib/deployment/config";

const rotate = process.argv.slice(2).includes("--rotate");
const pending = `${DEPLOYMENT_CONFIG_FILE}.pending`;
let hidden = false;
const output = new Writable({
  write(chunk, encoding, callback) {
    if (!hidden) process.stdout.write(chunk, encoding);
    callback();
  },
});

async function ensureAbsent(path: string) {
  try {
    await access(path);
    throw new Error("A private deployment configuration already exists. Preserve it, or move it before preparing a new installation.");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function main() {
  if (process.env.VERCEL || process.env.NODE_ENV === "production" || !process.stdin.isTTY) {
    throw new Error("Run the guided preparation command in an interactive terminal on a trusted computer.");
  }
  await ensureAbsent(DEPLOYMENT_CONFIG_FILE);
  await rm(pending, { force: true });

  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  let databaseAdminUrl = "";
  let appUrl = "";
  try {
    process.stdout.write("Neon administrator URL (hidden): ");
    hidden = true;
    databaseAdminUrl = hostedDatabaseUrl(await terminal.question(""));
    hidden = false;
    process.stdout.write("\n");
    appUrl = productionOrigin(await terminal.question("Production app URL (for example https://my-networth.vercel.app): "));
  } finally {
    hidden = false;
    terminal.close();
  }

  const adminIdentity = decodeURIComponent(new URL(databaseAdminUrl).username);
  if ([RUNTIME_ROLE, WORKER_ROLE].includes(adminIdentity)) {
    throw new Error("The administrator URL must not use either restricted application role.");
  }

  const runtimePassword = randomBytes(32).toString("hex");
  const workerPassword = randomBytes(32).toString("hex");
  const contents = deploymentEnvironment({
    databaseAdminUrl,
    runtimePassword,
    workerPassword,
    authSecret: randomBytes(32).toString("hex"),
    bootstrapSecret: randomBytes(32).toString("hex"),
    cronSecret: randomBytes(32).toString("hex"),
    appUrl,
  });
  await writeFile(pending, contents, { flag: "wx", mode: 0o600 });

  const pool = new Pool({ connectionString: databaseAdminUrl, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
  try {
    const database = drizzle(pool);
    await database.transaction(async tx => {
      const roles = await tx.execute<{ rolname: string; safe: boolean }>(sql`
        select rolname,
          rolcanlogin and not rolsuper and not rolbypassrls and not rolcreaterole and not rolcreatedb and not rolinherit
          and not exists(
            select from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where c.relowner=pg_roles.oid and n.nspname in ('core','ops','reporting')
          ) as safe
        from pg_roles where rolname in (${RUNTIME_ROLE},${WORKER_ROLE})
      `);
      if (roles.rows.some(role => !role.safe)) throw new Error("An existing deployment role is privileged or owns application objects.");
      if (roles.rows.length && !rotate) throw new Error("Deployment roles already exist. Re-run with --rotate only when intentionally replacing their passwords.");

      const existing = new Set(roles.rows.map(role => role.rolname));
      const runtimePasswordSql = `'${runtimePassword}'`;
      const workerPasswordSql = `'${workerPassword}'`;
      await tx.execute(sql.raw(existing.has(RUNTIME_ROLE)
        ? `alter role ${RUNTIME_ROLE} with login password ${runtimePasswordSql} nosuperuser nocreatedb nocreaterole noinherit nobypassrls`
        : `create role ${RUNTIME_ROLE} login password ${runtimePasswordSql} nosuperuser nocreatedb nocreaterole noinherit nobypassrls`));
      await tx.execute(sql.raw(existing.has(WORKER_ROLE)
        ? `alter role ${WORKER_ROLE} with login password ${workerPasswordSql} nosuperuser nocreatedb nocreaterole noinherit nobypassrls`
        : `create role ${WORKER_ROLE} login password ${workerPasswordSql} nosuperuser nocreatedb nocreaterole noinherit nobypassrls`));

      await migrateIdentity(tx, RUNTIME_ROLE);
      await tx.execute(sql`grant networth_worker to ${sql.identifier(WORKER_ROLE)} with inherit false`);
    });
    await rename(pending, DEPLOYMENT_CONFIG_FILE);
  } catch (error) {
    await rm(pending, { force: true });
    throw error;
  } finally {
    await pool.end();
  }

  console.info(`\nPrepared the database, restricted roles and private ${DEPLOYMENT_CONFIG_FILE}.`);
  console.info("Next: add that file's values to Vercel Production, deploy, and create the first owner at /setup.");
  console.info("After connecting Inngest, run: npm run deploy:enable -- personal");
}

try {
  await main();
} catch {
  console.error("Deployment preparation failed. Check the URL, database privileges, existing role state and private configuration file. No credential was logged.");
  process.exitCode = 1;
}
