import { inspectEnvironment } from "@/lib/config/environment";
import { canServeWorkflows } from "@/lib/config/policy";
import { validCronAuthorization } from "@/lib/workflows/cron";
import { dispatchPending } from "@/db/workflows/dispatch";
import { cleanupDerivedReports } from "@/db/calculations/publish";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) {
  const env = inspectEnvironment();
  if (!canServeWorkflows(env) || !env.values.DATABASE_WORKER_URL || !env.values.CRON_SECRET) return Response.json({ error: "Recovery is not configured." }, { status: 503 });
  if (!validCronAuthorization(request.headers.get("authorization"), env.values.CRON_SECRET)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  try { const delivery = await dispatchPending(); const cleaned = await cleanupDerivedReports(); return Response.json({ ...delivery, cleaned }, { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ error: "Recovery is unavailable; durable work remains queued." }, { status: 503 }); }
}
