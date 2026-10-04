import { z } from "zod";
import { cardManifestSchema, cardRowSchema, validateCardBatch } from "./card-v1";
import { confirmationSchema, decisionSchema, encodedBytes, MAX_IMPORT_BYTES, type Warning } from "./review";
import { reconcileCardStatement } from "@/lib/finance/card-posting";

export const cardConfirmationSchema = z.object({
  idempotencyKey: z.uuid(), expectedRevision: z.number().int().nonnegative(),
  manifest: cardManifestSchema, rows: z.array(cardRowSchema).max(4998),
  newAccount: confirmationSchema.shape.newAccount,
  facility: z.object({
    id: z.uuid(),
    newFacility: z.object({ name: z.string().trim().min(1).max(100) }).strict().optional(),
    limitInr: z.string().nullable(),
  }).strict(),
  decisions: z.record(z.string(), decisionSchema),
  acknowledgements: z.array(z.string().max(100)).max(20),
  openingDecision: z.object({
    action: z.enum(["observe", "establish"]),
    note: z.string().trim().max(500).default(""),
  }).strict(),
}).strict();
export type CardConfirmation = z.infer<typeof cardConfirmationSchema>;

export function validateCardConfirmation(input: unknown): CardConfirmation {
  if (encodedBytes(input) > MAX_IMPORT_BYTES) throw new Error("The full card confirmation exceeds 3,000,000 bytes.");
  const data = cardConfirmationSchema.parse(input);
  const { manifest, rows } = validateCardBatch(data.manifest, data.rows);
  if (data.facility.limitInr !== null) {
    const limit = data.facility.limitInr;
    if (!/^(0|[1-9][0-9]{0,25})(\.[0-9]{1,2})?$/.test(limit)) throw new Error("Credit limit must be a non-negative INR amount with at most two decimals.");
  }
  if (Object.keys(data.decisions).length !== rows.length) throw new Error("Every card row needs exactly one review decision.");
  if (data.openingDecision.action === "establish" && (manifest.openingOutstanding === null || !data.openingDecision.note))
    throw new Error("Establishing opening debt requires a known amount and an explicit review note.");
  const replacements = new Set<string>();
  for (const row of rows) {
    const decision = data.decisions[row.row_id];
    if (!decision || (decision.action !== "new") !== !!decision.eventId)
      throw new Error(`Row ${row.row_id}: select an existing event for links and replacements only.`);
    if (decision.action !== "new" && !decision.note) throw new Error("Explain each link or replacement.");
    if (decision.resolutionObservationId) throw new Error("Card reconciliation adjustments are not supported; correct the source events.");
    if (row.event_type === "card_repayment" && decision.action !== "link" && !decision.offsetAccountId)
      throw new Error("A new or replacement repayment requires its bank account.");
    if (row.event_type !== "card_repayment" && decision.offsetAccountId)
      throw new Error("Only repayments can select a bank offset.");
    if (decision.action === "replace") {
      if (replacements.has(decision.eventId!)) throw new Error("An event cannot be replaced twice in one batch.");
      replacements.add(decision.eventId!);
    }
  }
  if (rows.some(row => data.decisions[row.row_id]!.action === "link" && replacements.has(data.decisions[row.row_id]!.eventId!)))
    throw new Error("Cannot link to an event being replaced in this batch.");
  return { ...data, manifest, rows };
}

export function reviewCardConfirmation(input: unknown) {
  const data = validateCardConfirmation(input);
  const correction = data.rows.some(row => data.decisions[row.row_id]!.action === "replace");
  const reconciliation = reconcileCardStatement(correction ? { ...data.manifest, completeness: "partial" } : data.manifest, data.rows);
  const warnings: Warning[] = [];
  if (data.manifest.completeness !== "complete" || data.manifest.openingOutstanding === null)
    warnings.push({ code: "incomplete", message: "Incomplete card history remains unknown." });
  if (data.rows.some(row => row.event_type !== "card_repayment" && !row.category))
    warnings.push({ code: "uncategorized", message: "Some card expenses will remain Uncategorized." });
  if (data.openingDecision.action === "establish")
    warnings.push({ code: "equity", message: "Opening debt is an explicit equity entry and does not prove earlier history." });
  if (correction) warnings.push({ code: "correction", message: "Corrections require exact reversals and replacements. This file does not prove complete statement history." });
  if (reconciliation.status !== "matched") warnings.push({ code: "reconciliation", message: reconciliation.reason! });
  const keys = data.rows.map(row => JSON.stringify([row.transaction_date,row.description,row.direction,row.amount,row.currency]));
  if (new Set(keys).size !== keys.length)
    warnings.push({ code: "identical_rows", message: "Identical-looking card rows require explicit review as separate transactions." });
  return { data, reconciliation, warnings };
}
