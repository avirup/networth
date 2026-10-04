import nextEnv from "@next/env";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import path from "node:path";
import { exportHouseholdBackup, restoreHouseholdBackup, verifyHouseholdBackup } from "@/db/backup/service";
import { migrateIdentity } from "@/db/auth/migrate";
import { inspectEnvironment } from "@/lib/config/environment";

nextEnv.loadEnvConfig(process.cwd());

async function prompts() {
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!hidden) process.stdout.write(chunk, encoding); callback(); } });
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  return {
    question: (label: string) => terminal.question(label),
    async secret(label: string) { process.stdout.write(label); hidden = true; try { return await terminal.question(""); } finally { hidden = false; process.stdout.write("\n"); } },
    close() { hidden = false; terminal.close(); },
  };
}

async function main() {
  if (process.env.VERCEL || !process.stdin.isTTY) throw new Error("Run backup commands in an interactive local terminal.");
  const mode = process.argv[2]; const requested = process.argv[3];
  if (!requested || !["export", "verify", "restore"].includes(mode ?? "")) throw new Error("Choose export, verify or restore and provide a backup directory.");
  const directory = path.resolve(requested);
  const terminal = await prompts(); const passphrase = await terminal.secret("Backup passphrase (hidden): ");
  if (mode === "verify") {
    try { const manifest = await verifyHouseholdBackup(directory, passphrase); console.info(`Verified backup ${manifest.exportId}: ${manifest.parts.length} encrypted parts, source revision ${manifest.sourceRevision}.`); }
    finally { terminal.close(); }
    return;
  }
  const env = inspectEnvironment();
  if (!env.values.DATABASE_ADMIN_URL || !env.values.DATABASE_URL || !env.values.AUTH_SECRET || env.invalid.some(key => ["DATABASE_ADMIN_URL", "DATABASE_URL", "AUTH_SECRET"].includes(key))) { terminal.close(); throw new Error("Configure the admin/runtime database URLs and AUTH_SECRET."); }
  const ownerEmail = (await terminal.question(mode === "export" ? "Active owner email: " : "Restored active owner email: ")).trim().toLowerCase();
  const ownerPassword = await terminal.secret(mode === "export" ? "Current owner password (hidden): " : "New owner password (hidden): ");
  if (mode === "export") {
    const confirmation = await terminal.secret("Repeat backup passphrase (hidden): "); terminal.close();
    if (confirmation !== passphrase) throw new Error("Backup passphrases do not match.");
    const pool = new Pool({ connectionString: env.values.DATABASE_ADMIN_URL, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 30_000, allowExitOnIdle: true });
    try {
      const result = await exportHouseholdBackup({ pool, directory, ownerEmail, ownerPassword, passphrase });
      console.info(`Encrypted backup ${result.manifest.exportId} written to ${directory}.`);
      console.info(`${result.manifest.parts.length} bounded parts contain ${result.manifest.controls.sourceRecordCount} retained source records.`);
    } finally { await pool.end(); }
    return;
  }
  const confirmation = await terminal.secret("Repeat new owner password (hidden): "); terminal.close();
  if (confirmation !== ownerPassword) throw new Error("Owner passwords do not match.");
  const pool = new Pool({ connectionString: env.values.DATABASE_ADMIN_URL, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 30_000, allowExitOnIdle: true });
  try {
    await drizzle(pool).transaction(tx => migrateIdentity(tx, decodeURIComponent(new URL(env.values.DATABASE_URL!).username)));
    const result = await restoreHouseholdBackup({ pool, directory, passphrase, ownerEmail, ownerPassword, authSecret: env.values.AUTH_SECRET });
    console.info(`Restored backup ${result.manifest.exportId}. Reports remain unavailable until reviewed workflow capacity is enabled and the queued rebuild completes.`);
    console.info("New one-time recovery codes:"); for (const code of result.recoveryCodes) console.info(code);
  } finally { await pool.end(); }
}

try { await main(); }
catch { console.error("Backup command failed. Verify the directory, credentials, passphrase, empty target and database configuration. No secret was logged."); process.exitCode = 1; }
