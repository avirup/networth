import { describe, expect, it } from "vitest";
import { capacityStatus, type OperationsStatus } from "@/lib/operations/status";

const now = Date.parse("2026-10-04T00:00:00Z");
function available(): OperationsStatus {
  return { databaseBytes: "20000000", storageWarningBytes: 300000000, storagePauseBytes: 400000000, sourceRevision: 1,
    imports: { verifiedUntil: "2026-10-05T00:00:00Z", workflowVerified: true, remainingImports: 1, remainingStorageBytes: "1000000", reason: "Synthetic review" },
    execution: { verifiedUntil: "2026-10-05T00:00:00Z", remainingAttempts: "1", remainingStorageBytes: "819200" },
    pendingDeliveries: 0, pausedDeliveries: 0, pausedCalculations: 0, lastBackupAt: null };
}
describe("installation capacity", () => {
  it("reports capacity only when both leases and counters permit work", () => {
    expect(capacityStatus(available(), now).active).toBe(true);
  });
  it.each(["missing imports", "expired imports", "unverified", "imports exhausted", "import storage", "missing execution", "expired execution", "attempts exhausted", "execution storage", "database full", "database headroom"])("pauses for %s", condition => {
    const status = available();
    switch (condition) {
      case "missing imports": status.imports = null; break;
      case "expired imports": status.imports!.verifiedUntil = new Date(now).toISOString(); break;
      case "unverified": status.imports!.workflowVerified = false; break;
      case "imports exhausted": status.imports!.remainingImports = 0; break;
      case "import storage": status.imports!.remainingStorageBytes = "8207"; break;
      case "missing execution": status.execution = null; break;
      case "expired execution": status.execution!.verifiedUntil = new Date(now).toISOString(); break;
      case "attempts exhausted": status.execution!.remainingAttempts = "0"; break;
      case "execution storage": status.execution!.remainingStorageBytes = "819199"; break;
      case "database headroom": status.databaseBytes = "399180800"; break;
      case "database full": status.databaseBytes = "400000000"; break;
    }
    expect(capacityStatus(status, now).active).toBe(false);
  });
});
