import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseBankCsv } from "@/lib/imports/csv";
import { encodedBytes, localWarnings, validateConfirmation } from "@/lib/imports/review";
const rows = parseBankCsv(readFileSync("public/templates/bank-v1-example.csv", "utf8"));
const input = () => ({ idempotencyKey: "00000000-0000-4000-8000-000000000001", expectedRevision: 0, manifest: { schemaVersion: "bank-v1", accountId: "00000000-0000-4000-8000-000000000002", currency: "INR", coverageStart: "2026-09-01", coverageEnd: "2026-09-30", completeness: "complete", openingBalance: "1000", closingBalance: "74024.50", openingKnown: true, historyReason: "" }, rows, decisions: Object.fromEntries(rows.map(r => [r.row_id, { action: "new", note: "" }])), acknowledgements: [] });
it("parses quoted CSV without coercing amounts and rejects malformed or duplicate headers", () => {
  expect(typeof rows[0]!.amount).toBe("string");
  const text = readFileSync("public/templates/bank-v1-example.csv", "utf8");
  expect(() => parseBankCsv(text.replace("row_id", "schema_version"))).toThrow("headers");
  expect(() => parseBankCsv(text + "bad,row\n")).toThrow("columns");
});
it("bounds full UTF-8 request including decisions and observations", () => {
  expect(encodedBytes({ value: "₹" })).toBeGreaterThan(JSON.stringify({ value: "₹" }).length);
  expect(() => validateConfirmation({ ...input(), padding: "₹".repeat(1_000_000) })).toThrow("3,000,000");
  expect(() => validateConfirmation({ ...input(), rows: Array.from({ length: 4999 }, (_, i) => ({ ...rows[0], row_id: String(i) })) })).toThrow("4,998");
});
it("requires decisions and explicit adjustment notes; preserves known zero", () => {
  const base = input();
  // Fixture dates are independent of the synthetic example's chosen month.
  base.manifest.coverageStart = rows.map(r => r.transaction_date).sort()[0]!;
  base.manifest.coverageEnd = rows.map(r => r.transaction_date).sort().at(-1)!;
  expect(() => validateConfirmation({ ...base, decisions: {} })).toThrow("decision");
  const validated = validateConfirmation(base);
  expect(validated.manifest.openingKnown).toBe(true);
  expect(localWarnings({ ...validated, manifest: { ...validated.manifest, openingBalance: null, openingKnown: false } }).map(w => w.code)).toContain("incomplete");
});
it("does not add an explicit opening ledger row to period movements twice", () => {
  const base = input();
  base.rows = [{ ...rows[0]!, row_id: "opening", transaction_date: "2026-09-01", amount: "100", category: "", event_type: "opening_balance", related_row_id: "" }];
  base.decisions = { opening: { action: "new", note: "Reviewed initial ledger equity" } };
  base.manifest.openingBalance = "100"; base.manifest.closingBalance = "100";
  const validated = validateConfirmation(base);
  expect(localWarnings(validated).map(w => w.code)).toEqual(["equity"]);
  expect(() => validateConfirmation({ ...base, manifest: { ...base.manifest, openingBalance: "90" } })).toThrow("agree");
});
it("accepts exactly 3,000,000 encoded bytes and rejects the next byte", () => {
  const base = input();
  base.rows = Array.from({ length: 4998 }, (_, i) => ({ ...rows[0]!, row_id: `row${i}`, transaction_date: "2026-09-01", related_row_id: "" }));
  base.decisions = Object.fromEntries(base.rows.map(row => [row.row_id, { action: "new", note: "" }]));
  let remaining = 3_000_000 - encodedBytes(base);
  for (const decision of Object.values(base.decisions)) {
    const added = Math.min(500, remaining); decision.note = "x".repeat(added); remaining -= added;
  }
  expect(remaining).toBe(0); expect(encodedBytes(base)).toBe(3_000_000);
  expect(validateConfirmation(base).rows).toHaveLength(4998);
  Object.values(base.decisions).find(d => d.note.length < 500)!.note += "x";
  expect(encodedBytes(base)).toBe(3_000_001);
  expect(() => validateConfirmation(base)).toThrow("3,000,000");
});
