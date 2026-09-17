import { recoverSoleOwner } from "@/db/auth/admin";
import nextEnv from "@next/env";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { sql } from "drizzle-orm";
import { authDatabase, closeAuthPools } from "@/db/auth/connection";
import { migrateIdentity, migrationLock } from "@/db/auth/migrate";
import { hashPassword } from "@/lib/auth/passwords";
import { inspectEnvironment } from "@/lib/config/environment";
nextEnv.loadEnvConfig(process.cwd());
async function main() {
  if (process.env.VERCEL) throw new Error("Run this command locally as the deployment administrator.");
  const env = inspectEnvironment();
  const mode = process.argv[2];
  if (!["migrate", "recover-owner"].includes(mode ?? "") || !env.values.DATABASE_URL || !env.values.DATABASE_ADMIN_URL || env.invalid.length) throw new Error("Configure the runtime and admin connections, then choose migrate or recover-owner.");
  const admin = authDatabase(true);
  if (mode === "migrate") {
    await admin.transaction(async tx => {
      await migrationLock(tx);
      const state = await tx.execute(sql`select id from core.system_installation`);
      if (state.rows.length !== 1) throw new Error("Complete authorized owner setup first.");
      await migrateIdentity(tx, decodeURIComponent(new URL(env.values.DATABASE_URL!).username));
    });
    console.info("Reviewed migrations applied."); return;
  }
  if (!process.stdin.isTTY) throw new Error("Owner recovery requires an interactive local terminal.");
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!hidden) process.stdout.write(chunk, encoding); callback(); } });
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  let installationId: string, email: string, password: string;
  try {
    installationId = await terminal.question("Installation UUID (from your database): ");
    email = (await terminal.question("Sole owner's email: ")).trim().toLowerCase();
    process.stdout.write("New password (hidden, at least 12 characters): "); hidden = true;
    password = await terminal.question(""); hidden = false; process.stdout.write("\n");
  } finally { hidden = false; terminal.close(); }
  const passwordHash = await hashPassword(password);
  await recoverSoleOwner(admin, installationId, email, passwordHash);
  console.info("Owner password replaced; sessions and recovery codes revoked. Sign in and generate new recovery codes.");
}
try { await main(); } catch { console.error("Administration failed. Verify configuration, installation identity and command prerequisites. No credentials were logged."); process.exitCode = 1; } finally { await closeAuthPools(); }
