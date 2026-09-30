import { z } from "zod";
import { identity, checkRequest, sessionReference, json, failure } from "@/lib/auth/runtime";
import { readBankActivity } from "@/db/reports/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const querySchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), release: z.uuid(), cursor: z.string().max(256).optional(), limit: z.coerce.number().int().min(1).max(1000).default(25) });
export async function GET(request: Request) {
  try {
    checkRequest(request);
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return json({ error: "Choose a valid report month, release, and page size." }, 400);
    const service = identity(), reference = await sessionReference(request.headers), actor = await service.resolve(reference);
    return json(await service.scoped(reference, actor.householdId, "read", (tx, active) => readBankActivity(tx, active, { month: parsed.data.month, releaseId: parsed.data.release, cursor: parsed.data.cursor, limit: parsed.data.limit })));
  } catch (error) { return failure(error); }
}
