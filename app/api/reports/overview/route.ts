import { z } from "zod";
import { identity, checkRequest, sessionReference, json, failure } from "@/lib/auth/runtime";
import { readBankOverview } from "@/db/reports/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    checkRequest(request);
    const query = new URL(request.url).searchParams;
    const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).safeParse(query.get("month"));
    if (!month.success) return json({ error: "Choose a valid report month." }, 400);
    const service = identity(), reference = await sessionReference(request.headers), actor = await service.resolve(reference);
    return json(await service.scoped(reference, actor.householdId, "read", (tx, active) => readBankOverview(tx, active, month.data, query.get("release"))));
  } catch (error) { return failure(error); }
}
