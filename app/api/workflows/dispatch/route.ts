import { z } from "zod";
import { sql } from "drizzle-orm";
import { identity, checkRequest, boundedBody, sessionReference, json, failure } from "@/lib/auth/runtime";
import { AccessError } from "@/lib/auth/errors";
import { dispatchPending } from "@/db/workflows/dispatch";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    checkRequest(request, true);
    const service = identity(), reference = await sessionReference(request.headers), actor = await service.resolve(reference, "admin");
    if (!actor.reauthenticated) throw new AccessError(403, "Confirm your password before resuming workflow delivery.");
    let value: unknown;
    try { value = JSON.parse(await boundedBody(request)); } catch (e) { if (e instanceof AccessError) throw e; throw new AccessError(400, "Invalid request."); }
    const parsed = z.object({ resumeOutboxId: z.uuid().optional() }).strict().safeParse(value);
    if (!parsed.success) throw new AccessError(400, "Check the delivery identifier.");
    await service.scoped(reference, actor.householdId, "admin", async tx => {
      if (parsed.data.resumeOutboxId) await tx.execute(sql`select ops.resume_delivery(${parsed.data.resumeOutboxId}::uuid)`);
    });
    return json(await dispatchPending({ householdId: actor.householdId }));
  } catch (error) { return failure(error); }
}
