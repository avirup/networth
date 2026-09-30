import { dispatchPending } from "@/db/workflows/dispatch";
import { logSafeEvent } from "@/lib/config/logging";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { identity, checkRequest, boundedBody, sessionReference, json, failure } from "@/lib/auth/runtime";
import { AccessError } from "@/lib/auth/errors";
import { confirmImport, importStatus, reviewImport } from "@/db/imports/service";
import { canServeWorkflows } from "@/lib/config/policy";
import { inspectEnvironment } from "@/lib/config/environment";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request, context: { params: Promise<{ action: string }> }) {
  try {
    checkRequest(request);
    const action = (await context.params).action;
    if (!["status", "records", "observations"].includes(action)) throw new AccessError(404, "Not found.");
    const service = identity(), reference = await sessionReference(request.headers), actor = await service.resolve(reference);
    if (action === "records" || action === "observations") {
      const url = new URL(request.url), account = z.uuid().safeParse(url.searchParams.get("account"));
      const page = Number(url.searchParams.get("page") ?? 0);
      if (!account.success || !Number.isInteger(page) || page < 0 || page > 10000) throw new AccessError(400, "Choose an account and valid page.");
      if (action === "observations") return json(await service.scoped(reference, actor.householdId, "read", async tx => (await tx.execute(sql`
        select o.id,o.as_of::text as "asOf",o.balance::text,r.status,r.difference::text,r.explanation
        from core.fact_statement_observation o left join lateral
        (select status,difference,explanation from core.reconciliation_result r where r.household_id=o.household_id and r.observation_id=o.id order by revision desc limit 1) r on true
        where o.household_id=${actor.householdId} and o.account_id=${account.data} and o.kind='closing'
        order by o.as_of desc,o.id limit 100 offset ${page * 100}`)).rows));
      return json(await service.scoped(reference, actor.householdId, "read", async tx => (await tx.execute(sql`
        select e.id,e.effective_date::text as "effectiveDate",e.kind,p.native_amount::text as amount,
        (select c.code from core.fact_posting q join core.dim_category c on c.id=q.category_id and c.household_id=q.household_id where q.event_id=e.id and q.household_id=e.household_id limit 1) category
        from core.transaction_event e join core.fact_posting p on p.event_id=e.id and p.household_id=e.household_id
        join core.ledger_account a on a.id=p.ledger_account_id and a.household_id=p.household_id
        where e.household_id=${actor.householdId} and a.account_id=${account.data} and e.state='confirmed' and e.kind<>'reversal'
        and not exists(select from core.transaction_event r where r.household_id=e.household_id and r.reverses_id=e.id)
        order by e.effective_date desc,e.id limit 100 offset ${page * 100}`)).rows));
    }
    const status = await service.scoped(reference, actor.householdId, "read", importStatus);
    return json(withWorkflowStatus(status));
  } catch (error) { return failure(error); }
}
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  try {
    checkRequest(request, true);
    const action = (await context.params).action;
    if (!["review", "confirm"].includes(action)) throw new AccessError(404, "Not found.");
    const service = identity(), reference = await sessionReference(request.headers), actor = await service.resolve(reference, "import");
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new AccessError(415, "JSON is required.");
    const raw = await boundedBody(request, 3_000_000);
    let input: unknown;
    try { input = JSON.parse(raw); } catch { throw new AccessError(400, "Invalid confirmation JSON."); }
    if (action === "review") return json(withWorkflowStatus(await service.scoped(reference, actor.householdId, "import", (tx, active) => reviewImport(tx, active, input))));
    const confirmed = await service.scoped(reference, actor.householdId, "import", (tx, active) => confirmImport(tx, active, input, Buffer.byteLength(raw), canServeWorkflows(inspectEnvironment()) && !!inspectEnvironment().values.DATABASE_WORKER_URL));
    // Financial commit has finished. Delivery failure must never turn it into a failed import.
    if (inspectEnvironment().values.DATABASE_WORKER_URL) {
      try { await dispatchPending({ householdId: actor.householdId, maximum: 1 }); }
      catch { logSafeEvent({ event: "workflow_unavailable" }); }
    }
    return json(confirmed);
  } catch (error) {
    const cause = error && typeof error === "object" && "cause" in error ? error.cause : error;
    if (cause && typeof cause === "object" && "code" in cause) {
      if (cause.code === "P0001") return json({ error: "Confirmation paused. Workflow verification or available capacity has expired. No records were saved." }, 503);
      if (["23514", "23503", "23505"].includes(String(cause.code))) return json({ error: "The reviewed records conflict with an accounting rule or changed record. No records were saved; review the statement again." }, 409);
    }
    return failure(error);
  }
}

function withWorkflowStatus<T extends { ready: boolean; reason: string }>(value: T): T {
  return canServeWorkflows(inspectEnvironment()) && !!inspectEnvironment().values.DATABASE_WORKER_URL ? value : { ...value, ready: false, reason: "Confirmation paused. Configure and verify the calculation workflow first." };
}
