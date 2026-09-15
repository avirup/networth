import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

// Next intentionally ignores .env.local in NODE_ENV=test. Read only the explicit
// test URL here, without loading application credentials into the test process.
if (!process.env.TEST_DATABASE_URL && existsSync(".env.local")) {
  const value = parseEnv(readFileSync(".env.local", "utf8")).TEST_DATABASE_URL;
  if (value) process.env.TEST_DATABASE_URL = value;
}
const raw = process.env.TEST_DATABASE_URL;
if (!raw) throw new Error("TEST_DATABASE_URL is required. Run npm run local:setup and npm run db:up.");
let valid = false;
try {
  const url = new URL(raw);
  valid = ["postgres:", "postgresql:"].includes(url.protocol)
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    && url.pathname === "/networth_test"
    && !process.env.VERCEL;
} catch { /* Never print a malformed connection string. */ }
if (!valid) throw new Error("Integration tests require a local disposable database named networth_test.");
