import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { inspectEnvironment } from "@/lib/config/environment";
import { canServeWorkflows } from "@/lib/config/policy";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const handlers = serve({ client: inngest, functions: [] });

// Step 1 registers no jobs. Hosted registration remains closed until Step 6
// supplies signed-handler integration tests and the real financial workflows.
function localOnly(handler: typeof handlers.GET) {
  return async (...args: Parameters<typeof handlers.GET>) => {
    const report = inspectEnvironment();
    if (report.deployment !== "local" || !canServeWorkflows(report)) {
      return Response.json({ error: "Workflow endpoint unavailable" }, { status: 503 });
    }
    return handler(...args);
  };
}

export const GET = localOnly(handlers.GET);
export const POST = localOnly(handlers.POST);
export const PUT = localOnly(handlers.PUT);
