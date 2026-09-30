import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import pg from "pg";
const raw = process.env.TEST_DATABASE_URL ?? parseEnv(readFileSync(".env.local", "utf8")).TEST_DATABASE_URL;
const url = new URL(raw);
if (process.env.VERCEL || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/networth_test") throw new Error("Browser auth tests require the disposable local networth_test database.");
const pool = new pg.Pool({ connectionString: raw });
try {
  await pool.query("drop schema if exists reporting cascade; drop schema if exists ops cascade");
  await pool.query("drop schema if exists core cascade");
  await pool.query("do $$ begin if not exists(select from pg_roles where rolname='networth_test_app') then create role networth_test_app login password 'synthetic-runtime-test-only' noinherit; end if; end $$");
} finally { await pool.end(); }
url.username = "networth_test_app"; url.password = "synthetic-runtime-test-only";
// An unreachable synthetic worker proves post-commit dispatch failure does not undo imports.
const workerUrl = new URL(url); workerUrl.port = "1"; workerUrl.username = "synthetic_worker";
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3102"], { stdio: "inherit", env: {
  ...process.env, DATABASE_WORKER_URL: workerUrl.toString(), CRON_SECRET: "", NODE_ENV: "production", VERCEL: "", VERCEL_ENV: "", LOCAL_RUNTIME: "1", LOCAL_UI_PREVIEW: "",
  APP_URL: "http://127.0.0.1:3102", DATABASE_URL: url.toString(), DATABASE_ADMIN_URL: raw,
  AUTH_SECRET: "synthetic-browser-auth-secret-for-tests-only", BOOTSTRAP_SECRET: "synthetic-browser-bootstrap-secret-for-tests-only",
  INNGEST_EVENT_KEY: "", INNGEST_SIGNING_KEY: "", INNGEST_SIGNING_KEY_FALLBACK: "", INNGEST_DEV: "1",
} });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", code => { process.exitCode = code ?? 1; });
