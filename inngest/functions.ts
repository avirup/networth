import { inngest } from "./client";
import { NonRetriableError, type GetStepTools } from "inngest";
import { acceptDelivery } from "@/db/workflows/dispatch";
import { advanceCalculationPlan, beginCalculationPlan } from "@/db/workflows/planning";
import { advanceBankCandidate, beginBankCandidate } from "@/db/calculations/bank-worker";
import { advanceBalanceCandidate } from "@/db/calculations/bank-balance-worker";
import { publishBankRelease, readWorkflowSnapshot } from "@/db/calculations/publish";
import { AccessError } from "@/lib/auth/errors";
import { RESUME_EVENT, resumeIntentSchema, WORK_EVENT, workIntentSchema } from "@/lib/workflows/events";

type DurableStep = GetStepTools<typeof inngest>;
function paused(error: unknown) { return error instanceof AccessError && error.status === 503 && error.message.includes("paused:"); }
async function calculateAndPublish(step: DurableStep, runId: string, householdId: string) {
  const prefix = runId.slice(0, 12);
  let snapshot = await step.run(`${prefix}-read-workflow-checkpoint`, () => readWorkflowSnapshot({ runId, householdId }));
  try {
    for (let attempt = 0; snapshot.plan.state !== "prepared" && attempt < 101; attempt++) {
      const plan = await step.run(`${prefix}-plan-${snapshot.plan.page}`, () => advanceCalculationPlan({ runId, householdId, page: snapshot.plan.page }));
      snapshot = { ...snapshot, plan };
    }
    if (snapshot.plan.state !== "prepared") return { state: "paused" as const, stage: "planning" as const, runId };
    if (!snapshot.bank) {
      const bank = await step.run(`${prefix}-begin-bank-candidate`, () => beginBankCandidate({ runId, householdId, asOf: snapshot.asOf }));
      snapshot = { ...snapshot, bank };
    }
    for (let attempt = 0; snapshot.bank?.state !== "calculated" && attempt < 101; attempt++) {
      const bank = await step.run(`${prefix}-bank-${snapshot.bank!.page}`, () => advanceBankCandidate({ runId, householdId, page: snapshot.bank!.page }));
      snapshot = { ...snapshot, bank };
    }
    if (snapshot.bank?.state !== "calculated") return { state: "paused" as const, stage: "bank" as const, runId };
    for (let attempt = 0; snapshot.balance?.state !== "calculated" && attempt < 101; attempt++) {
      const page = snapshot.balance?.page ?? 0;
      const balance = await step.run(`${prefix}-balance-${page}`, () => advanceBalanceCandidate({ runId, householdId, page }));
      snapshot = { ...snapshot, balance };
    }
    if (snapshot.balance?.state !== "calculated") return { state: "paused" as const, stage: "balance" as const, runId };
  } catch (error) {
    if (paused(error)) return { state: "paused" as const, stage: "capacity" as const, runId };
    throw error;
  }
  const releaseId = await step.run(`${prefix}-publish-report-release`, () => publishBankRelease({ runId, householdId }));
  return releaseId ? { state: "published" as const, runId, releaseId } : { state: "superseded" as const, runId };
}

export const receiveImport = inngest.createFunction({
  id: "receive-import-v1", triggers: { event: WORK_EVENT }, retries: 3,
  concurrency: { limit: 1, key: "event.data.householdId" },
}, async ({ event, step }) => {
  const parsed = workIntentSchema.safeParse(event.data);
  if (!parsed.success) throw new NonRetriableError("Invalid work intent identifiers.");
  await step.run("record-durable-receipt", async () => {
    try { return await acceptDelivery(parsed.data); }
    catch { throw new Error("Workflow receipt could not be recorded."); }
  });
  let plan = await step.run("begin-calculation-plan", () => beginCalculationPlan(parsed.data));
  let result = await calculateAndPublish(step, plan.id, parsed.data.householdId);
  if (result.state === "superseded") {
    plan = await step.run(`refresh-calculation-plan-${plan.id.slice(0, 12)}`, () => beginCalculationPlan(parsed.data));
    result = await calculateAndPublish(step, plan.id, parsed.data.householdId);
  }
  return result;
});

export const resumeCalculation = inngest.createFunction({
  id: "resume-calculation-v1", triggers: { event: RESUME_EVENT }, retries: 3,
  concurrency: { limit: 1, key: "event.data.householdId" },
}, async ({ event, step }) => {
  const parsed = resumeIntentSchema.safeParse(event.data);
  if (!parsed.success) throw new NonRetriableError("Invalid calculation resume identifiers.");
  return calculateAndPublish(step, parsed.data.runId, parsed.data.householdId);
});
