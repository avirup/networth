import { NextRequest } from "next/server";
import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { receiveImport, resumeCalculation } from "@/inngest/functions";
import { inspectEnvironment } from "@/lib/config/environment";
import { canServeWorkflows } from "@/lib/config/policy";
import { boundedBody } from "@/lib/auth/runtime";
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
const handlers = serve({ client: inngest, functions: [receiveImport, resumeCalculation] });
function guarded(handler: typeof handlers.GET) {
  return async (request: NextRequest, ...rest: Parameters<typeof handlers.GET> extends [unknown, ...infer R] ? R : never) => {
    const env = inspectEnvironment();
    if (!canServeWorkflows(env) || !env.values.DATABASE_WORKER_URL) return Response.json({ error: "Workflow endpoint unavailable" }, { status: 503 });
    // SDK verifies production request signatures, including fallback-key rotation.
    // Preview contexts never reach it. Local unsigned access requires explicit INNGEST_DEV.
    let bounded = request;
    if (request.method === "POST" || request.method === "PUT") {
      try { const body = await boundedBody(request, 262144); bounded = new NextRequest(request.url, { method: request.method, headers: request.headers, body }); }
      catch { return Response.json({ error: "Workflow request is too large" }, { status: 413 }); }
    }
    return handler(bounded, ...rest);
  };
}
export const GET = guarded(handlers.GET);
export const POST = guarded(handlers.POST);
export const PUT = guarded(handlers.PUT);
