import Papa from "papaparse";
import { BANK_COLUMNS, bankRowSchema, type BankRow } from "./bank-v1";
import { MAX_IMPORT_BYTES } from "./review";
export function parseBankCsv(text: string): BankRow[] {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) throw new Error("CSV exceeds 3,000,000 bytes. Split it into separately reviewed batches.");
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), { delimiter: ",", dynamicTyping: false, skipEmptyLines: true });
  if (result.errors.length) throw new Error(`CSV could not be read: ${result.errors[0]!.message}`);
  const [header, ...cells] = result.data;
  if (!header || header.length !== BANK_COLUMNS.length || header.some((cell, i) => cell !== BANK_COLUMNS[i])) throw new Error("Use the exact bank-v1 template headers, in order, without duplicates.");
  if (cells.length > 4998) throw new Error("At most 4,998 transactions fit with the two statement observations. Split this file.");
  return cells.map((values, index) => {
    if (values.length !== header.length) throw new Error(`CSV row ${index + 2} has the wrong number of columns.`);
    const row = bankRowSchema.safeParse(Object.fromEntries(header.map((key, i) => [key, values[i]])));
    if (!row.success) throw new Error(`CSV row ${index + 2}: check ${row.error.issues[0]!.path.join(".")}.`);
    return row.data;
  });
}
