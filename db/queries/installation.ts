import "server-only";
import { sql } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import type { InstallationState } from "@/lib/config/policy";

export async function readInstallationState(): Promise<InstallationState> {
  const db = getDatabase();
  const exists = await db.execute<{ table_name: string | null }>(sql`select to_regclass('core.system_installation')::text as table_name`);
  if (!exists.rows[0]?.table_name) return null;
  // Step 3 owns this schema and its singleton constraint. Fail closed on ambiguity.
  const result = await db.execute<{ schema_version: number; setup_completed_at: Date | null }>(sql`
    select schema_version, setup_completed_at from core.system_installation limit 2
  `);
  if (result.rows.length !== 1) return null;
  const row = result.rows[0]!;
  return { schemaVersion: row.schema_version, setupCompleted: row.setup_completed_at !== null };
}
