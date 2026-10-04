import { z } from "zod";

const capacity = z.object({ verifiedUntil: z.string(), remainingStorageBytes: z.string() });
export const operationsStatusSchema = z.object({
  databaseBytes: z.string(), storageWarningBytes: z.number().int(), storagePauseBytes: z.number().int(), sourceRevision: z.number().int().nonnegative(),
  imports: capacity.extend({ workflowVerified: z.boolean(), remainingImports: z.number().int().nonnegative(), reason: z.string() }).nullable(),
  execution: capacity.extend({ remainingAttempts: z.string() }).nullable(),
  pendingDeliveries: z.number().int().nonnegative(), pausedDeliveries: z.number().int().nonnegative(), pausedCalculations: z.number().int().nonnegative(),
  lastBackupAt: z.string().nullable(),
});
export type OperationsStatus = z.infer<typeof operationsStatusSchema>;

export function storageState(status: OperationsStatus) {
  const bytes = BigInt(status.databaseBytes);
  return bytes >= BigInt(status.storagePauseBytes) ? "paused" : bytes >= BigInt(status.storageWarningBytes) ? "incomplete" : "complete";
}

export function formatStorage(value: string) {
  const bytes = BigInt(value); const tenthMb = bytes * 10n / 1_000_000n;
  return `${tenthMb / 10n}.${tenthMb % 10n} MB`;
}


// Import size is not known on this page; final admission still reserves its exact estimate.
export function capacityStatus(status: OperationsStatus, now = Date.now()) {
  const imports = status.imports, execution = status.execution;
  const paused = (reason: string) => ({ active: false, reason });
  if (BigInt(status.databaseBytes) + 819200n >= BigInt(status.storagePauseBytes))
    return paused("Database storage has insufficient headroom for calculation work.");
  if (!imports?.workflowVerified || !(Date.parse(imports.verifiedUntil) > now))
    return paused("Review and renew import capacity.");
  if (imports.remainingImports < 1 || BigInt(imports.remainingStorageBytes) < 8208n)
    return paused("Import capacity is exhausted. Review and renew the capacity allowance.");
  if (!execution || !(Date.parse(execution.verifiedUntil) > now))
    return paused("Review and renew calculation capacity.");
  if (BigInt(execution.remainingAttempts) < 1n || BigInt(execution.remainingStorageBytes) < 819200n)
    return paused("Calculation capacity is exhausted. Review and renew the capacity allowance.");
  return { active: true, reason: "Reviewed capacity is available. Each import still requires sufficient space for its size." };
}
