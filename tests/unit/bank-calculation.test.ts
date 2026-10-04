import { describe, expect, it } from "vitest";
import { calculateBankPage, type BankCalculationEvent } from "@/lib/finance/bank-calculation";
import { D } from "@/lib/finance/decimal";
const context = { householdId: "household", sourceRevision: 10, asOf: "2026-12-31" };
function event(id: string, kind: BankCalculationEvent["kind"], amount: string, categoryId: string | null = null): BankCalculationEvent {
  const offset = ["income", "income_reversal"].includes(kind) ? "income" : ["expense", "expense_refund"].includes(kind) ? "expense" : kind === "transfer" ? "asset" : kind === "card_repayment" ? "liability" : "equity";
  return { id, householdId: "household", revision: 1, effectiveDate: "2026-09-10", kind, reversedKind: null,
    quality: kind === "opening_balance" ? "opening_history_unknown" : kind === "unresolved_reconciliation" ? "unresolved" : "complete",
    legs: [
      { id: `${id}-cash`, ledgerAccountId: "cash", accountId: "bank", kind: "asset", currency: "INR", nativeAmount: amount, bookAmountInr: amount, categoryId: null },
      { id: `${id}-offset`, ledgerAccountId: offset, accountId: offset === "asset" ? "other-bank" : offset === "liability" ? "card" : null, kind: offset, currency: "INR", nativeAmount: new D(amount).neg().toFixed(2), bookAmountInr: new D(amount).neg().toFixed(2), categoryId },
    ] };
}
function reversal(original: BankCalculationEvent): BankCalculationEvent {
  return { ...original, id: `${original.id}-reversal`, revision: 2, kind: "reversal", reversedKind: original.kind as BankCalculationEvent["reversedKind"], legs: original.legs.map(l => ({ ...l, id: `${l.id}-reversal`, nativeAmount: new D(l.nativeAmount).neg().toFixed(12), bookAmountInr: new D(l.bookAmountInr).neg().toFixed(12) })) };
}
describe("bank movement calculation rules", () => {
  it("calculates known income/spending while separating principal and reviewed equity", () => {
    const result = calculateBankPage(context, [event("salary", "income", "1000", "salary"), event("spend", "expense", "-200", "grocery"), event("refund", "expense_refund", "25", "grocery"), event("income-return", "income_reversal", "-50", "salary"), event("transfer", "transfer", "-300"), event("repayment", "card_repayment", "-100"), event("opening", "opening_balance", "500"), event("unresolved", "unresolved_reconciliation", "40")]);
    expect(result.categoryMovements).toEqual([
      { accountId: "bank", month: "2026-09-01", kind: "expense", categoryId: "grocery", amountInr: "175.000000000000", postingCount: 2 },
      { accountId: "bank", month: "2026-09-01", kind: "income", categoryId: "salary", amountInr: "950.000000000000", postingCount: 2 },
    ]);
    expect(result.accountMovements.find(r => r.accountId === "bank")).toMatchObject({ nativeDelta: "915.000000000000", bookDeltaInr: "915.000000000000", cashDelta: "375.000000000000", openingDelta: "500.000000000000", unresolvedDelta: "40.000000000000", postingCount: 8, incompleteEvidence: true });
    expect(result.accountMovements.find(r => r.accountId === "other-bank")).toMatchObject({ cashDelta: "300.000000000000" });
    expect(result.accountMovements.find(r => r.accountId === "card")).toMatchObject({ nativeDelta: "100.000000000000", cashDelta: "0.000000000000", ledgerKind: "liability" });
    expect(result).not.toHaveProperty("netWorth");
    expect(result.accountMovements[0]).not.toHaveProperty("balance");
  });
  it("tracks card spending on the liability while keeping repayments out of expenses", () => {
    const purchase = event("card-purchase", "expense", "-200", "grocery");
    purchase.legs = [
      { ...purchase.legs[0]!, ledgerAccountId: "card-ledger", accountId: "card", kind: "liability", nativeAmount: "-200", bookAmountInr: "-200" },
      { ...purchase.legs[1]!, ledgerAccountId: "grocery-ledger", accountId: null, kind: "expense", nativeAmount: "200", bookAmountInr: "200" },
    ];
    const refund = event("card-refund", "expense_refund", "20", "grocery");
    refund.legs = [
      { ...refund.legs[0]!, ledgerAccountId: "card-ledger", accountId: "card", kind: "liability", nativeAmount: "20", bookAmountInr: "20" },
      { ...refund.legs[1]!, ledgerAccountId: "grocery-ledger", accountId: null, kind: "expense", nativeAmount: "-20", bookAmountInr: "-20" },
    ];
    const repayment = event("repayment", "card_repayment", "-100");
    const result = calculateBankPage(context, [purchase, refund, repayment]);
    expect(result.categoryMovements).toEqual([
      { accountId: "card", month: "2026-09-01", kind: "expense", categoryId: "grocery", amountInr: "180.000000000000", postingCount: 2 },
    ]);
    expect(result.accountMovements.find(row => row.accountId === "card")).toMatchObject({ ledgerKind: "liability", nativeDelta: "-80.000000000000", cashDelta: "0.000000000000" });
    expect(result.accountMovements.find(row => row.accountId === "bank")).toMatchObject({ ledgerKind: "asset", nativeDelta: "-100.000000000000", cashDelta: "-100.000000000000" });
  });
  it("applies exact reversals once and preserves correction audit counts", () => {
    const original = event("old", "expense", "-200", "grocery");
    const corrected = event("new", "expense", "-150", "fees"); corrected.revision = 2;
    const result = calculateBankPage(context, [original, reversal(original), corrected]);
    expect(result.categoryMovements).toEqual([
      { accountId: "bank", month: "2026-09-01", kind: "expense", categoryId: "fees", amountInr: "150.000000000000", postingCount: 1 },
      { accountId: "bank", month: "2026-09-01", kind: "expense", categoryId: "grocery", amountInr: "0.000000000000", postingCount: 2 },
    ]);
    expect(result.accountMovements[0]!.nativeDelta).toBe("-150.000000000000");
    const opening = event("opening", "opening_balance", "100");
    expect(calculateBankPage(context, [opening, reversal(opening)]).accountMovements[0]).toMatchObject({ openingDelta: "0.000000000000", cashDelta: "0.000000000000", incompleteEvidence: true });
  });
  it("retains native currency and evidenced INR book amounts without inventing a valuation", () => {
    const foreign = event("foreign", "income", "8300", "salary");
    foreign.legs[0] = { ...foreign.legs[0]!, currency: "USD", nativeAmount: "100" };
    const result = calculateBankPage(context, [foreign]);
    expect(result.accountMovements[0]).toMatchObject({ currency: "USD", nativeDelta: "100.000000000000", bookDeltaInr: "8300.000000000000" });
    expect(result.categoryMovements[0]!.amountInr).toBe("8300.000000000000");
    expect(result).not.toHaveProperty("ownership");
  });
  it("preserves exact decimals beyond JavaScript integer precision and input magnitude", () => {
    const rows = Array.from({ length: 100 }, (_, i) => event(`large-${i}`, "income", "99999999999999999999999999.99", "salary"));
    expect(calculateBankPage(context, rows).categoryMovements[0]!.amountInr).toBe("9999999999999999999999999999.000000000000");
    expect(calculateBankPage(context, [event("a", "income", "0.10"), event("b", "income", "0.20")]).categoryMovements[0]!.amountInr).toBe("0.300000000000");
  });
  it("is deterministic across input order and yields additive page contributions", () => {
    const rows = [event("a", "expense", "-10.10"), event("b", "expense_refund", "0.10"), event("c", "expense", "-20")];
    const before = JSON.stringify(rows), whole = calculateBankPage(context, rows);
    expect(calculateBankPage(context, [...rows].reverse())).toEqual(whole);
    const split = [calculateBankPage(context, rows.slice(0, 1)), calculateBankPage(context, rows.slice(1))];
    expect(split.reduce((sum, page) => sum.plus(page.categoryMovements[0]!.amountInr), new D(0)).toFixed(12)).toBe(whole.categoryMovements[0]!.amountInr);
    expect(whole.categoryMovements[0]).toMatchObject({ categoryId: null, amountInr: "30.000000000000", postingCount: 3 });
    expect(JSON.stringify(rows)).toBe(before);
  });
  it("separates months and accounts and leaves empty input empty", () => {
    const first = event("first", "income", "10"); first.effectiveDate = "2026-01-31";
    const second = event("second", "income", "20"); second.effectiveDate = "2026-02-01";
    second.legs[0]!.accountId = "another-bank";
    const result = calculateBankPage(context, [first, second]);
    expect(result.categoryMovements.map(r => [r.accountId, r.month, r.amountInr])).toEqual([["another-bank", "2026-02-01", "20.000000000000"], ["bank", "2026-01-01", "10.000000000000"]]);
    expect(calculateBankPage(context, [])).toMatchObject({ eventCount: 0, accountMovements: [], categoryMovements: [] });
  });
  it("rejects mixed snapshots, future dates, duplicate evidence and oversized pages", () => {
    const valid = event("valid", "income", "100");
    for (const bad of [{ ...valid, householdId: "other" }, { ...valid, revision: 11 }, { ...valid, revision: 0 }, { ...valid, effectiveDate: "2027-01-01" }]) expect(() => calculateBankPage(context, [bad])).toThrow();
    expect(() => calculateBankPage(context, [valid, valid])).toThrow("duplicate");
    expect(() => calculateBankPage(context, Array.from({ length: 101 }, (_, i) => event(`${i}`, "income", "1")))).toThrow("oversized");
    expect(() => calculateBankPage(context, [valid, { ...valid, id: "another-id" }])).toThrow("Duplicate posting");
  });
  it("fails closed for unsupported or invalid financial evidence", () => {
    const valid = event("valid", "income", "100");
    const withLeg = (patch: Partial<BankCalculationEvent["legs"][number]>) => ({ ...valid, legs: [{ ...valid.legs[0]!, ...patch }, valid.legs[1]!] });
    for (const bad of [withLeg({ bookAmountInr: "101", nativeAmount: "101" }), withLeg({ nativeAmount: 0.1 as unknown as string }), withLeg({ bookAmountInr: "1e2" }), withLeg({ categoryId: "fees" }), withLeg({ accountId: null }), { ...valid, kind: "fx_conversion" as const }, { ...valid, kind: "reversal" as const }]) expect(() => calculateBankPage(context, [bad])).toThrow();
    expect(() => calculateBankPage(context, [{ ...event("opening", "opening_balance", "100"), quality: "complete" }])).toThrow("complete history");
  });
});
