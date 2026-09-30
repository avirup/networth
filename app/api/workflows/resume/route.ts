import { z } from "zod";
import { sql } from "drizzle-orm";
import { identity, checkRequest, boundedBody, sessionReference, json, failure } from "@/lib/auth/runtime";
import { AccessError } from "@/lib/auth/errors";
import { sendResumeIntent } from "@/lib/workflows/send";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    checkRequest(request, true);
    const service = identity(), reference = await sessionReference(request.headers), actor = await service.resolve(reference, "admin");
    if (!actor.reauthenticated) throw new AccessError(403, "Confirm your password before resuming calculation.");
    let value: unknown;
    try { value = JSON.parse(await boundedBody(request)); }
    catch (error) { if (error instanceof AccessError) throw error; throw new AccessError(400, "Invalid request."); }
    const parsed = z.object({ runId: z.uuid() }).strict().safeParse(value);
    if (!parsed.success) throw new AccessError(400, "Check the calculation identifier.");
    const resumed = await service.scoped(reference, actor.householdId, "admin", async tx => {
      const reason = (await tx.execute<{ reason: "capacity" | "retry_limit" | "window_limit" }>(sql`select reason from ops.calculation_budget where run_id=${parsed.data.runId}::uuid`)).rows[0]?.reason;
      if (!reason) throw new AccessError(409, "Calculation is not paused.");
      await tx.execute(sql`select ops.resume_calculation_budget(${parsed.data.runId}::uuid)`);
      return reason;
    });
    try { await sendResumeIntent({ runId: parsed.data.runId, householdId: actor.householdId }); }
    catch {
      try { await service.scoped(reference, actor.householdId, "admin", tx => tx.execute(sql`select ops.restore_calculation_pause(${parsed.data.runId}::uuid,${resumed})`)); } catch { /* A concurrent claim owns the now-ready checkpoint. */ }
      throw new AccessError(503, "Workflow scheduling failed. The preserved calculation can be resumed again.");
    }
    return json({ state: "ready", scheduled: true });
  } catch (error) { return failure(error); }
}
