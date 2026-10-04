import { expect, it } from "vitest";
import { reviewCardConfirmation, validateCardConfirmation } from "@/lib/imports/card-review";
const id = "00000000-0000-4000-8000-000000000001";
function input() {
  return {
    idempotencyKey: id, expectedRevision: 0,
    manifest: { schemaVersion: "card-v1", accountId: id, currency: "INR", coverageStart: "2026-09-01", coverageEnd: "2026-09-30",
      completeness: "complete", openingOutstanding: "100", statementOutstanding: "150", historyReason: "", paymentDueDate: null, minimumDue: null },
    rows: [{ schema_version: "card-v1", row_id: "x", transaction_ref: "", transaction_date: "2026-09-05", description: "Synthetic purchase",
      direction: "debit", amount: "50", currency: "INR", event_type: "card_purchase", category: "", related_row_id: "" }],
    decisions: { x: { action: "new", note: "" } }, acknowledgements: [], openingDecision: { action: "observe", note: "" },
    facility: { id, newFacility: { name: "Synthetic facility" }, limitInr: "10000" },
  };
}
it("reviews card statements without assuming opening equity consent", () => {
  const result = reviewCardConfirmation(input());
  expect(result.reconciliation.status).toBe("matched");
  expect(result.warnings.map(w => w.code)).toEqual(["uncategorized"]);
  expect(result.data.openingDecision.action).toBe("observe");
});
it("requires explicit opening consent and preserves unknown opening amounts", () => {
  expect(() => validateCardConfirmation({ ...input(), openingDecision: { action: "establish", note: "" } })).toThrow();
  expect(() => validateCardConfirmation({ ...input(), manifest: { ...input().manifest, openingOutstanding: null, historyReason: "Not supplied" },
    openingDecision: { action: "establish", note: "Reviewed" } })).toThrow();
  expect(reviewCardConfirmation({ ...input(), openingDecision: { action: "establish", note: "Reviewed starting debt" } }).warnings.map(w => w.code)).toContain("equity");
});
it("requires repayment bank selection except when linking an existing event", () => {
  const data = input();
  data.rows[0]!.event_type = "card_repayment"; data.rows[0]!.direction = "credit";
  expect(() => validateCardConfirmation(data)).toThrow(/bank/);
  expect(validateCardConfirmation({ ...data, decisions: { x: { action: "new", offsetAccountId: id } } }).rows).toHaveLength(1);
  expect(validateCardConfirmation({ ...data, decisions: { x: { action: "link", eventId: id, note: "Other side of bank payment" } } }).rows).toHaveLength(1);
});
it("rejects unsupported resolution and prevents correction files claiming complete reconciliation", () => {
  expect(() => validateCardConfirmation({ ...input(), decisions: { x: { action: "new", resolutionObservationId: id } } })).toThrow();
  expect(reviewCardConfirmation({ ...input(), decisions: { x: { action: "replace", eventId: id, note: "Correct category" } } }).reconciliation.status).toBe("unknown");
});
it("requires all decisions and rejects contradictory links and replacements", () => {
  expect(() => validateCardConfirmation({ ...input(), decisions: {} })).toThrow();
  const data = input(); data.rows.push({ ...data.rows[0]!, row_id: "y" });
  expect(() => validateCardConfirmation({ ...data, decisions: {
    x: { action: "replace", eventId: id, note: "Correction" }, y: { action: "link", eventId: id, note: "Duplicate" },
  } })).toThrow();
});
