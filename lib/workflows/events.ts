import { z } from "zod";
export const workIntentSchema = z.object({ outboxId: z.uuid(), householdId: z.uuid(), batchId: z.uuid(), revision: z.number().int().positive() }).strict();
export type WorkIntent = z.infer<typeof workIntentSchema>;
export const WORK_EVENT = "networth/import.confirmed";
export const RESUME_EVENT = "networth/calculation.resume";
export const resumeIntentSchema = z.object({ runId: z.uuid(), householdId: z.uuid() }).strict();
export type ResumeIntent = z.infer<typeof resumeIntentSchema>;
export function workEvent(input: WorkIntent) {
  const data = workIntentSchema.parse(input);
  return { id: `networth-import:${data.outboxId}`, name: WORK_EVENT, data };
}
export function resumeEvent(input: ResumeIntent) {
  const data = resumeIntentSchema.parse(input);
  return { id: `networth-resume:${data.runId}:${crypto.randomUUID()}`, name: RESUME_EVENT, data };
}
