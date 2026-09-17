import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AccessLayout } from "@/components/ui/primitives";
import { AccessForm } from "@/components/auth/access-form";
import { identity, sessionReference } from "@/lib/auth/runtime";
import { inspectEnvironment } from "@/lib/config/environment";
export const dynamic = "force-dynamic";
export default async function SetupPage() {
  let completed = false;
  try { completed = !!await identity().installationState(); } catch { /* Setup API reports safe configuration failures. */ }
  if (completed) {
    let owner = false;
    try { await identity().resolveStatus(await sessionReference(await headers())); owner = true; } catch { /* No setup state is reopened. */ }
    redirect(owner ? "/dashboard/settings" : "/login");
  }
  const environment = inspectEnvironment();
  const missing = (["DATABASE_URL", "DATABASE_ADMIN_URL", "AUTH_SECRET", "BOOTSTRAP_SECRET", "APP_URL"] as const).filter(key => !environment.values[key]);
  return <AccessLayout title="Set up your private finance tracker"><p>Create the first owner account, then invite your household. Public registration stays closed.</p>{missing.length > 0 && <p role="status">Configure these server settings before setup: {missing.join(", ")}.</p>}<AccessForm mode="setup" /></AccessLayout>;
}
