import { expect, it } from "vitest";
import { bankBalanceMovements, type BankBalancePosting } from "@/lib/finance/bank-balance-source";

const scope = { accountId: "bank", currency: "INR", start: "2026-09-01" };
function posting(id: string, kind = "income", amount = "10"): BankBalancePosting {
  return { id, eventId: id, date: scope.start, kind, originalKind: null, quality: kind === "opening_balance" ? "opening_history_unknown" : kind === "unresolved_reconciliation" ? "unresolved" : "complete", native: amount, book: amount, currency: "INR", reversed: false, reviewed: kind === "opening_balance" };
}
it("retains a corrected opening once and unresolved event provenance even after exact cancellation", () => {
  const original = { ...posting("old", "opening_balance", "100"), reversed: true };
  const reverse = { ...posting("reverse", "reversal", "-100"), originalKind: "opening_balance", quality: "opening_history_unknown" };
  const unresolved = { ...posting("uncertain", "unresolved_reconciliation", "20"), reversed: true };
  const undo = { ...posting("undo", "reversal", "-20"), originalKind: "unresolved_reconciliation", quality: "unresolved" };
  const result = bankBalanceMovements(scope, [original, reverse, posting("new", "opening_balance", "120"), unresolved, undo, posting("cash", "expense", "-5")]);
  expect(result.opening).toMatchObject({ evidenceId: "new", balance: "120", history: "unknown" });
  expect(result.unresolvedEventCount).toBe(2);
  expect(result.movements[0]).toMatchObject({ nativeDelta: "115.000000000000", openingDelta: "120.000000000000", unresolvedDelta: "0.000000000000", postingCount: 6, incompleteEvidence: true });
});
it("leaves ambiguous, unreviewed and later openings unanchored", () => {
  expect(bankBalanceMovements(scope, [posting("a", "opening_balance"), posting("b", "opening_balance")]).opening).toBeNull();
  expect(bankBalanceMovements(scope, [{ ...posting("a", "opening_balance"), reviewed: false }]).opening).toBeNull();
  expect(bankBalanceMovements(scope, [{ ...posting("a", "opening_balance"), date: "2026-09-02" }]).opening).toBeNull();
});
it("fails closed before returning a truncated posting or daily window", () => {
  expect(() => bankBalanceMovements(scope, Array.from({ length: 5001 }, (_, i) => posting(String(i))))).toThrow("posting limit");
  const dated = Array.from({ length: 1001 }, (_, i) => ({ ...posting(String(i)), date: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10) }));
  expect(() => bankBalanceMovements(scope, dated)).toThrow("checkpoint boundaries");
});
it("rejects duplicate events, floating-point money and unsupported posting provenance", () => {
  const valid = posting("id");
  expect(() => bankBalanceMovements(scope, [valid, { ...valid, id: "different-posting" }])).toThrow("posting shape");
  for (const patch of [{ native: 10 as unknown as string }, { currency: "USD" }, { kind: "fx_conversion" }, { quality: "invented" }, { date: "2026-02-30" }]) {
    expect(() => bankBalanceMovements(scope, [{ ...valid, ...patch }])).toThrow();
  }
});
