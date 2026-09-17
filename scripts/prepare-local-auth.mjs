import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import pg from "pg";
if (process.env.VERCEL || process.env.NODE_ENV === "production") throw new Error("Local preparation only.");
const path = new URL("../.env.local", import.meta.url);
const source = await readFile(path, "utf8");
const values = parseEnv(source);
const knownAdmin = "postgresql://networth_local:local-development-only@127.0.0.1:15432/networth_local";
const knownRuntime = "postgresql://networth_app:local-runtime-only@127.0.0.1:15432/networth_local";
if ((values.DATABASE_ADMIN_URL ?? values.DATABASE_URL) !== knownAdmin || ![knownAdmin, knownRuntime].includes(values.DATABASE_URL)) throw new Error("This helper only supports the supplied local Compose configuration. Configure external roles manually.");
const pool = new pg.Pool({ connectionString: knownAdmin, max: 1 });
try {
  await pool.query("do $$ begin if not exists(select from pg_roles where rolname='networth_app') then create role networth_app login password 'local-runtime-only' nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$");
  if (values.DATABASE_URL === knownAdmin) {
    let next = source.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${knownRuntime}`);
    if (!values.DATABASE_ADMIN_URL) next += `\nDATABASE_ADMIN_URL=${knownAdmin}\n`;
    await writeFile(path, next, { mode: 0o600 });
  }
  console.info("Local restricted runtime role is ready; existing secrets were preserved. No application tables or accounts were created.");
} finally { await pool.end(); }
