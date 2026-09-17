import { schemaIsCompatible } from "@/lib/config/policy";
import Link from "next/link";
import { AccessLayout, DataQualityIndicator } from "@/components/ui/primitives";
import { requireActor } from "@/lib/auth/runtime";
import { inspectEnvironment } from "@/lib/config/environment";
export const dynamic = "force-dynamic";
export default async function StatusPage() {
  const { actor } = await requireActor("admin", true); const environment = inspectEnvironment();
  return <AccessLayout title="Installation status"><p>Signed in as a household owner. Identity schema version: {actor.schemaVersion}.</p>{!schemaIsCompatible(actor.schemaVersion) && <p role="alert">This application and database version do not match. Ask the deployment administrator to apply the reviewed upgrade. Financial operations are blocked.</p>}<DataQualityIndicator state="paused">Financial imports and recalculation are not enabled yet.</DataQualityIndicator><p>{environment.missing.length || environment.invalid.length ? `Check server settings: ${[...environment.missing, ...environment.invalid].join(", ")}.` : "Required configuration is present. Workflow readiness still needs verification."}</p><Link className="button secondary" href="/dashboard/settings">Back to settings</Link></AccessLayout>;
}
