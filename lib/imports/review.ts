import { z } from "zod";
import { bankManifestSchema, bankRowSchema, validateBankBatch, type BankRow } from "./bank-v1";
import { decimal } from "@/lib/finance/decimal";
import { reconcile } from "@/lib/finance/bank-posting";
export const MAX_IMPORT_BYTES = 3_000_000;
export const MAX_EVIDENCE_ROWS = 5000;
export const decisionSchema = z.object({
  action: z.enum(["new", "link", "replace"]), eventId: z.uuid().optional(),
  offsetAccountId: z.uuid().optional(), note: z.string().trim().max(500).default(""),
  resolutionObservationId: z.uuid().optional(),
}).strict();
export const confirmationSchema = z.object({
  idempotencyKey: z.uuid(), expectedRevision: z.number().int().nonnegative(),
  manifest: bankManifestSchema, rows: z.array(bankRowSchema).max(MAX_EVIDENCE_ROWS),
  newAccount: z.object({ name: z.string().trim().min(1).max(100), maskedReference: z.string().regex(/^[*]{4}[A-Za-z0-9]{0,4}$/).nullable() }).strict().optional(),
  decisions: z.record(z.string(), decisionSchema), acknowledgements: z.array(z.string().max(100)).max(20),
}).strict();
export type Confirmation = z.infer<typeof confirmationSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type Warning = { code: string; message: string };
export function encodedBytes(value: unknown) { return new TextEncoder().encode(JSON.stringify(value)).length; }
export function categoryKind(row: BankRow) { return ["income", "income_reversal"].includes(row.event_type) ? "income" : ["expense", "expense_refund"].includes(row.event_type) ? "expense" : null; }
export function validateConfirmation(input: unknown) {
  if (encodedBytes(input) > MAX_IMPORT_BYTES) throw new Error("The full confirmation exceeds 3,000,000 bytes. Split the file into separately reviewed batches.");
  const data = confirmationSchema.parse(input);
  const { manifest, rows } = validateBankBatch(data.manifest, data.rows);
  // Retain both opening and closing observations, including explicit unknowns.
  if (rows.length + 2 > MAX_EVIDENCE_ROWS) throw new Error("Allow two rows for statement observations: import at most 4,998 transactions per batch.");
  for (const value of [manifest.openingBalance, manifest.closingBalance]) {
    const digits = { INR: 2, USD: 2, EUR: 2, GBP: 2, JPY: 0 }[manifest.currency];
    if (digits === undefined || (value !== null && !decimal(value).eq(decimal(value).toDecimalPlaces(digits)))) throw new Error("Statement balances must use the account currency's settlement precision.");
  }
  if (Object.keys(data.decisions).length !== rows.length) throw new Error("Every row needs exactly one review decision.");
  const targets = new Set<string>();
  const resolutions = new Set<string>();
  for (const row of rows) {
    const decision = data.decisions[row.row_id];
    if (!decision) throw new Error(`Row ${row.row_id} needs a review decision.`);
    if ((decision.action !== "new") !== !!decision.eventId) throw new Error(`Row ${row.row_id}: select an existing event for link or replacement only.`);
    if (decision.action !== "new" && !decision.note) throw new Error(`Row ${row.row_id}: explain the link or correction.`);
    if (decision.action === "replace") {
      if (targets.has(decision.eventId!)) throw new Error("An event cannot be replaced twice in one batch.");
      targets.add(decision.eventId!);
    }
    if (row.event_type === "opening_balance" && (row.transaction_date !== manifest.coverageStart || (manifest.openingBalance !== null && !decimal(row.amount).mul(row.direction === "credit" ? 1 : -1).eq(manifest.openingBalance)))) throw new Error("Opening ledger rows must agree with the statement opening balance and coverage start.");
    if (["opening_balance", "unresolved_reconciliation"].includes(row.event_type) && !decision.note) throw new Error(`Row ${row.row_id}: explain this explicit equity adjustment.`);
    if (decision.resolutionObservationId) {
      if (resolutions.has(decision.resolutionObservationId)) throw new Error("Resolve an observation only once per batch.");
      resolutions.add(decision.resolutionObservationId);
    }
    if (decision.resolutionObservationId && (row.event_type !== "unresolved_reconciliation" || decision.action !== "new")) throw new Error("Reconciliation resolution requires a new, explicitly reviewed unresolved equity adjustment.");
  }
  if (rows.some(row => data.decisions[row.row_id]!.action === "link" && targets.has(data.decisions[row.row_id]!.eventId!))) throw new Error("Cannot link to an event being replaced in this batch.");
  return { ...data, manifest, rows };
}
export function statementReconciliation(data: Confirmation) {
  // A replacement file is correction evidence, not a complete statement history.
  return reconcile(data.manifest.openingBalance, data.rows.filter(row => row.event_type !== "opening_balance").map(row => decimal(row.amount).mul(row.direction === "credit" ? 1 : -1).toFixed()), data.manifest.closingBalance,
    data.manifest.completeness === "complete" && !data.rows.some(row => data.decisions[row.row_id]?.action === "replace"));
}
export function localWarnings(data: Confirmation): Warning[] {
  const result: Warning[] = [];
  if (data.manifest.completeness !== "complete" || !data.manifest.openingKnown) result.push({ code: "incomplete", message: "History is incomplete. Missing opening history will remain unknown." });
  if (data.rows.some(row => categoryKind(row) && !row.category)) result.push({ code: "uncategorized", message: "Some income or expenses will remain Uncategorized." });
  if (data.rows.some(row => ["opening_balance", "unresolved_reconciliation"].includes(row.event_type))) result.push({ code: "equity", message: "Explicit equity adjustments do not prove earlier history or resolve missing evidence." });
  if (data.rows.some(row => data.decisions[row.row_id]?.action === "replace")) result.push({ code: "correction", message: "Corrections append an exact reversal and a replacement. Original records remain visible." });
  const reconciliation = statementReconciliation(data);
  if (reconciliation.status !== "matched") result.push({ code: "reconciliation", message: reconciliation.reason! });
  const fingerprints = data.rows.map(row => JSON.stringify([row.transaction_date, row.description, row.direction, row.amount, row.currency]));
  if (new Set(fingerprints).size !== fingerprints.length) result.push({ code: "identical_rows", message: "This file contains identical-looking rows. Confirm each is a separate legitimate transaction." });
  return result;
}
