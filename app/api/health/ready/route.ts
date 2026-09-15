import { inspectEnvironment, environmentIsValid } from "@/lib/config/environment";
import { financialWriteStatus } from "@/lib/config/policy";
import { readInstallationState } from "@/db/queries/installation";
import { logSafeEvent } from "@/lib/config/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const report = inspectEnvironment();
  let ready = false;
  if (report.deployment !== "preview" && environmentIsValid(report)) {
    try {
      // Configuration is not a verified workflow connection. Step 6 supplies that check.
      ready = financialWriteStatus(report, await readInstallationState(), false) === "ready";
    } catch {
      logSafeEvent({ event: "database_unavailable" });
    }
  }
  // Public health discloses neither variable names nor installation/user details.
  return Response.json({ status: ready ? "ready" : "not_ready" }, {
    status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" },
  });
}
