import Papa from "papaparse";
import { z } from "zod";
import { decimal, economicDate, money } from "@/lib/finance/decimal";
import { categoryFor } from "@/lib/finance/categories";

export const CARD_COLUMNS = ["schema_version", "row_id", "transaction_ref", "transaction_date", "description", "direction", "amount", "currency", "event_type", "category", "related_row_id"] as const;
export const CARD_MAX_TRANSACTIONS = 4998; // Reserve two rows for statement evidence.
export const CARD_MAX_BYTES = 3_000_000;

export const cardRowSchema = z.object({
  schema_version: z.literal("card-v1"), row_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  transaction_ref: z.string().max(200), transaction_date: z.string(), description: z.string().trim().min(1).max(500),
  direction: z.enum(["debit", "credit"]), amount: z.string(), currency: z.literal("INR"),
  event_type: z.enum(["card_purchase", "card_refund", "card_interest", "card_fee", "card_repayment"]),
  category: z.string().max(64), related_row_id: z.string().max(64),
}).strict();
export type CardRow = z.infer<typeof cardRowSchema>;

export const cardManifestSchema = z.object({
  schemaVersion: z.literal("card-v1"), accountId: z.uuid(), currency: z.literal("INR"),
  coverageStart: z.string(), coverageEnd: z.string(), completeness: z.enum(["complete", "partial", "balance_only"]),
  openingOutstanding: z.string().nullable(), statementOutstanding: z.string().nullable(),
  historyReason: z.string().max(500), paymentDueDate: z.string().nullable(), minimumDue: z.string().nullable(),
}).strict();
export type CardManifest = z.infer<typeof cardManifestSchema>;

export function cardMoney(value: string) {
  const amount = decimal(value);
  if (!amount.eq(amount.toDecimalPlaces(2))) throw new Error("Card amounts must be settled to INR paise.");
  return money(value);
}

export function normalizeCardRow(input: unknown): CardRow {
  const row = cardRowSchema.parse(input);
  economicDate(row.transaction_date);
  const amount = cardMoney(row.amount);
  if (!decimal(amount).gt(0)) throw new Error("Amount must be positive; direction indicates the change in debt.");
  const credit = row.event_type === "card_refund" || row.event_type === "card_repayment";
  if (row.direction !== (credit ? "credit" : "debit")) throw new Error("Card direction does not match the economic event.");
  if (row.event_type === "card_repayment") {
    if (row.category) throw new Error("Card repayments cannot have expense or income categories.");
  } else categoryFor(row.category, "expense");
  return { ...row, amount, transaction_ref: row.transaction_ref.trim() };
}

export function validateCardBatch(manifestInput: unknown, rowInputs: unknown[]) {
  if (rowInputs.length > CARD_MAX_TRANSACTIONS) throw new Error("At most 4,998 transactions fit with two statement observations.");
  if (new TextEncoder().encode(JSON.stringify({ manifest: manifestInput, rows: rowInputs })).length > CARD_MAX_BYTES)
    throw new Error("Card confirmation exceeds 3,000,000 bytes.");
  const manifest = cardManifestSchema.parse(manifestInput);
  economicDate(manifest.coverageStart); economicDate(manifest.coverageEnd);
  if (manifest.coverageStart > manifest.coverageEnd) throw new Error("Coverage dates are reversed.");
  if (manifest.openingOutstanding === null && !manifest.historyReason.trim()) throw new Error("Unknown opening history needs an explicit reason.");
  for (const value of [manifest.openingOutstanding, manifest.statementOutstanding, manifest.minimumDue])
    if (value !== null) cardMoney(value);
  if (manifest.minimumDue !== null && decimal(manifest.minimumDue).lt(0)) throw new Error("Minimum due cannot be negative.");
  if (manifest.paymentDueDate !== null) {
    economicDate(manifest.paymentDueDate);
    if (manifest.paymentDueDate < manifest.coverageEnd) throw new Error("Payment due date precedes the statement date.");
  }
  if (manifest.minimumDue !== null && manifest.statementOutstanding !== null
    && decimal(manifest.minimumDue).gt(decimal(manifest.statementOutstanding).gt(0) ? manifest.statementOutstanding : "0"))
    throw new Error("Minimum due exceeds positive statement outstanding.");
  const rows = rowInputs.map(normalizeCardRow);
  const ids = new Set(rows.map(row => row.row_id));
  if (ids.size !== rows.length) throw new Error("Row IDs must be unique within the file.");
  if (manifest.completeness === "balance_only" && rows.length) throw new Error("Balance-only evidence cannot assert transactions.");
  for (const row of rows) {
    if (row.transaction_date < manifest.coverageStart || row.transaction_date > manifest.coverageEnd)
      throw new Error("Card transaction is outside statement coverage.");
    if (row.related_row_id && (row.related_row_id === row.row_id || !ids.has(row.related_row_id)))
      throw new Error("Related row is missing or self-referential. Earlier imports require reviewed event links.");
  }
  return { manifest, rows };
}

export function parseCardCsv(text: string): CardRow[] {
  if (new TextEncoder().encode(text).length > CARD_MAX_BYTES) throw new Error("CSV exceeds 3,000,000 bytes.");
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), { delimiter: ",", dynamicTyping: false, skipEmptyLines: true });
  if (result.errors.length) throw new Error("Card CSV could not be read.");
  const [header, ...records] = result.data;
  if (!header || header.length !== CARD_COLUMNS.length || header.some((cell, index) => cell !== CARD_COLUMNS[index]))
    throw new Error("Use the exact card-v1 template headers in order.");
  if (records.length > CARD_MAX_TRANSACTIONS) throw new Error("At most 4,998 card transactions are allowed.");
  return records.map((values, index) => {
    if (values.length !== CARD_COLUMNS.length) throw new Error(`CSV row ${index + 2} has the wrong number of columns.`);
    return normalizeCardRow(Object.fromEntries(header.map((key, column) => [key, values[column]])));
  });
}
