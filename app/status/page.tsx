import { schemaIsCompatible } from "@/lib/config/policy";
import Link from "next/link";
import { AccessLayout, DataQualityIndicator } from "@/components/ui/primitives";
import { identity, requireActor } from "@/lib/auth/runtime";
import { inspectEnvironment } from "@/lib/config/environment";
import { capacityStatus, formatStorage, storageState } from "@/lib/operations/status";
export const dynamic = "force-dynamic";
export default async function StatusPage() {
  const { actor, reference } = await requireActor("admin", true); const environment = inspectEnvironment();
  const compatible = schemaIsCompatible(actor.schemaVersion); const status = compatible ? await identity().operationsStatus(reference) : null;
  const capacity = status ? capacityStatus(status) : null;
  const active = capacity?.active ?? false;
  return <AccessLayout title="Installation status">
    <p>Signed in as a household owner. Database schema version: {actor.schemaVersion}.</p>
    {!compatible && <p role="alert">This application and database version do not match. Apply the reviewed migration before importing or exporting data.</p>}
    {status && <>
      <DataQualityIndicator state={active ? storageState(status) : "paused"} label={active ? "Capacity current" : "Capacity review required"}>{capacity?.reason}</DataQualityIndicator>
      <dl className="status-list">
        <div><dt>Database storage</dt><dd>{formatStorage(status.databaseBytes)} of the 400 MB application pause threshold</dd></div>
        <div><dt>Source revision</dt><dd>{status.sourceRevision}</dd></div>
        <div><dt>Import capacity</dt><dd>{status.imports ? `${status.imports.remainingImports} imports · ${formatStorage(status.imports.remainingStorageBytes)} reserved headroom` : "Not verified"}</dd></div>
        <div><dt>Calculation capacity</dt><dd>{status.execution ? `${status.execution.remainingAttempts} attempts · ${formatStorage(status.execution.remainingStorageBytes)} reserved headroom` : "Not verified"}</dd></div>
        <div><dt>Queued or paused work</dt><dd>{status.pendingDeliveries} queued · {status.pausedDeliveries + status.pausedCalculations} paused</dd></div>
        <div><dt>Last completed local backup</dt><dd>{status.lastBackupAt ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(status.lastBackupAt)) : "No completed export recorded"}</dd></div>
      </dl>
      <p>After a material import, run <code>npm run backup:export -- backups/DATE</code> on the trusted administration computer. Verify it with <code>npm run backup:verify -- backups/DATE</code>.</p>
    </>}
    <p>{environment.missing.length || environment.invalid.length ? `Check server settings: ${[...environment.missing, ...environment.invalid].join(", ")}.` : "Required application configuration is present. Provider usage still requires a manual review before renewing capacity."}</p>
    <Link className="button secondary" href="/dashboard/settings">Back to settings</Link>
  </AccessLayout>;
}
