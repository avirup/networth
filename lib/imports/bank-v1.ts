import { z } from "zod";
import { decimal, economicDate } from "@/lib/finance/decimal";
import { categoryFor } from "@/lib/finance/categories";
export const BANK_COLUMNS = ["schema_version", "row_id", "transaction_ref", "transaction_date", "description", "direction", "amount", "currency", "event_type", "category", "book_amount_inr", "fx_rate", "related_row_id"] as const;
export const bankRowSchema = z.object({
  schema_version: z.literal("bank-v1"), row_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  transaction_ref: z.string().max(200), transaction_date: z.string(), description: z.string().trim().min(1).max(500),
  direction: z.enum(["credit", "debit"]), amount: z.string(), currency: z.string().regex(/^[A-Z]{3}$/),
  event_type: z.enum(["income", "expense", "expense_refund", "income_reversal", "transfer", "card_repayment", "opening_balance", "unresolved_reconciliation"]),
  category: z.string().max(64), book_amount_inr: z.string(), fx_rate: z.string(), related_row_id: z.string().max(64),
}).strict();
export type BankRow = z.infer<typeof bankRowSchema>;
export const bankManifestSchema = z.object({
  schemaVersion: z.literal("bank-v1"), accountId: z.uuid(), currency: z.string().regex(/^[A-Z]{3}$/),
  coverageStart: z.string(), coverageEnd: z.string(), completeness: z.enum(["complete", "partial", "balance_only"]),
  openingBalance: z.string().nullable(), closingBalance: z.string().nullable(),
  openingKnown: z.boolean(), historyReason: z.string().max(500),
}).strict();
export type BankManifest = z.infer<typeof bankManifestSchema>;
export function normalizeBankRow(input: unknown): BankRow {
  const row = bankRowSchema.parse(input);
  economicDate(row.transaction_date);
  const settlementDigits = { INR: 2, USD: 2, EUR: 2, GBP: 2, JPY: 0 }[row.currency];
  if (settlementDigits === undefined || !decimal(row.amount).eq(decimal(row.amount).toDecimalPlaces(settlementDigits))) throw new Error("Unsupported currency or unsettled native amount.");
  if (row.book_amount_inr && !decimal(row.book_amount_inr).eq(decimal(row.book_amount_inr).toDecimalPlaces(2))) throw new Error("Explicit INR book values must be settled to paise.");
  if (!decimal(row.amount).gt(0)) throw new Error("Amount must be positive; use direction for cash movement.");
  if (["income", "expense_refund"].includes(row.event_type) && row.direction !== "credit") throw new Error("This event requires a credit.");
  if (["expense", "income_reversal", "card_repayment"].includes(row.event_type) && row.direction !== "debit") throw new Error("This event requires a debit.");
  const kind = ["income", "income_reversal"].includes(row.event_type) ? "income" : ["expense", "expense_refund"].includes(row.event_type) ? "expense" : null;
  if (kind) categoryFor(row.category, kind); else if (row.category) throw new Error("Transfers, principal and opening adjustments cannot have spending categories.");
  if (row.book_amount_inr && !decimal(row.book_amount_inr).gt(0)) throw new Error("INR book amount must be positive.");
  if (row.fx_rate && !decimal(row.fx_rate, 18).gt(0)) throw new Error("FX rate must be positive.");
  if (row.currency !== "INR" && !row.book_amount_inr && !row.fx_rate) throw new Error("Foreign currency requires an evidenced INR book amount or FX rate.");
  if (row.currency === "INR" && ((row.book_amount_inr && !decimal(row.book_amount_inr).eq(row.amount)) || (row.fx_rate && !decimal(row.fx_rate, 18).eq(1)))) throw new Error("INR conversion must agree with the native amount.");
  if (row.currency !== "INR" && row.book_amount_inr && row.fx_rate && !decimal(row.amount).mul(decimal(row.fx_rate, 18)).toDecimalPlaces(2).eq(decimal(row.book_amount_inr))) throw new Error("Book amount and FX evidence disagree.");
  return { ...row, transaction_ref: row.transaction_ref.trim(), amount: decimal(row.amount).toFixed(12) };
}
export function validateBankBatch(manifestInput: unknown, rowInputs: unknown[]) {
  const manifest = bankManifestSchema.parse(manifestInput);
  economicDate(manifest.coverageStart); economicDate(manifest.coverageEnd);
  if (manifest.coverageStart > manifest.coverageEnd) throw new Error("Coverage dates are reversed.");
  if (rowInputs.length > 5000) throw new Error("Split imports into at most 5,000 rows.");
  if (new TextEncoder().encode(JSON.stringify({ manifest: manifestInput, rows: rowInputs })).length > 3_000_000) throw new Error("Confirmation payload exceeds 3,000,000 bytes.");
  if (manifest.openingKnown !== (manifest.openingBalance !== null) || (!manifest.openingKnown && !manifest.historyReason.trim())) throw new Error("Unknown opening history needs an explicit reason.");
  if (manifest.openingBalance !== null) decimal(manifest.openingBalance);
  if (manifest.closingBalance !== null) decimal(manifest.closingBalance);
  const rows = rowInputs.map(normalizeBankRow);
  if (new Set(rows.map(row => row.row_id)).size !== rows.length) throw new Error("Row IDs must be unique within the file.");
  if (manifest.completeness === "balance_only" && rows.length) throw new Error("Balance-only evidence cannot assert transaction history.");
  for (const row of rows) {
    if (row.currency !== manifest.currency || row.transaction_date < manifest.coverageStart || row.transaction_date > manifest.coverageEnd) throw new Error("Row is outside its account currency or coverage.");
    if (row.related_row_id && !rows.some(other => other.row_id === row.related_row_id && other.row_id !== row.row_id)) throw new Error("Related row is missing or self-referential; use reviewed external event links for earlier imports.");
  }
  return { manifest, rows };
}
// CSV parsing belongs to Phase 5 (PapaParse). This phase validates parsed string cells.
