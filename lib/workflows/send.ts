import "server-only";
import { z } from "zod";
import { inspectEnvironment } from "@/lib/config/environment";
import { canServeWorkflows } from "@/lib/config/policy";
import { resumeEvent, workEvent, type ResumeIntent, type WorkIntent } from "./events";
// Exactly one HTTP attempt. SDK send retries would hide metered attempts from our ledger.
async function sendEvent(event: ReturnType<typeof workEvent> | ReturnType<typeof resumeEvent>) {
  const env = inspectEnvironment();
  if (!canServeWorkflows(env)) throw new Error("Workflow delivery unavailable.");
  const url = env.deployment === "local" ? "http://127.0.0.1:8288/e/local" : `https://inn.gs/e/${encodeURIComponent(env.values.INNGEST_EVENT_KEY!)}`;
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event), signal: AbortSignal.timeout(8000), redirect: "error" });
    if (!response.ok) throw new Error("Rejected event.");
    const reader = response.body?.getReader(); if (!reader) throw new Error("Missing receipt.");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 16384) { await reader.cancel(); throw new Error("Oversized receipt."); } chunks.push(value); }
    const receipt = z.object({ status: z.literal(200), ids: z.array(z.string().min(1)).length(1) }).safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!receipt.success) throw new Error("Invalid receipt.");
  } catch { throw new Error("Workflow event delivery failed."); }
}
export async function sendWorkIntent(intent: WorkIntent) { return sendEvent(workEvent(intent)); }
export async function sendResumeIntent(intent: ResumeIntent) { return sendEvent(resumeEvent(intent)); }
