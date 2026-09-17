import "server-only";
import { identity } from "@/lib/auth/runtime";
import type { InstallationState } from "@/lib/config/policy";
export async function readInstallationState(): Promise<InstallationState> {
  const row = await identity().installationState();
  return row ? { schemaVersion: row.schemaVersion, setupCompleted: !!row.setupCompletedAt } : null;
}
