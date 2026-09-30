import { describe, expect, it } from "vitest";
import { calculateBankBalance, type BankBalanceInput } from "@/lib/finance/bank-balance";
import type { AccountMovement } from "@/lib/finance/bank-calculation";

const row = (date: string, amount: string): AccountMovement => ({ accountId: "bank", currency: "INR", ledgerKind: "asset", date, nativeDelta: amount, bookDeltaInr: amount, cashDelta: amount, openingDelta: "0", unresolvedDelta: "0", postingCount: 1, incompleteEvidence: false });
function fixture(): BankBalanceInput {
  return {
    scope: { householdId: "household", accountId: "bank", currency: "INR", sourceRevision: 7, start: "2026-09-01", asOf: "2026-09-30" },
    opening: { kind: "checkpoint", evidenceId: "prior-checkpoint", date: "2026-08-31", balance: "100", history: "unknown" },
    movements: [row("2026-09-02", "-20.10"), row("2026-09-30", "0.20")],
    coverage: [{ evidenceId: "statement", start: "2026-09-01", end: "2026-09-30", completeness: "complete" }],
    closing: [{ evidenceId: "closing", date: "2026-09-30", balance: "80.10" }],
    unresolvedEventCount: 0,
  };
}
describe("bank balance checkpoint rules", () => {
  it("reconciles native balances exactly without claiming complete earlier history", () => {
    const input = fixture(), before = JSON.stringify(input);
    expect(calculateBankBalance(input)).toMatchObject({ calculatedBalance: "80.100000000000", observedBalance: "80.100000000000", reconciledBalance: "80.100000000000", difference: "0.000000000000", history: "unknown", reasons: [] });
    expect(JSON.stringify(input)).toBe(before);
    expect(calculateBankBalance(input)).not.toHaveProperty("netWorth");
  });
  it("counts a reviewed opening once, including ordinary same-day cash movements", () => {
    const input = fixture();
    input.opening = { kind: "reviewed_opening", evidenceId: "opening-event", date: input.scope.start, balance: "100", history: "unknown" };
    input.movements.unshift({ ...row(input.scope.start, "110"), cashDelta: "10", openingDelta: "100", incompleteEvidence: true, postingCount: 2 });
    input.closing[0]!.balance = "90.10";
    expect(calculateBankBalance(input).reconciledBalance).toBe("90.100000000000");
    input.opening.balance = "200";
    expect(() => calculateBankBalance(input)).toThrow("match its ledger");
  });
  it("does not turn statement-only evidence or an absent starting balance into an asset", () => {
    const input = fixture(); input.opening = null; input.movements = [];
    input.coverage[0]!.completeness = "balance_only";
    expect(calculateBankBalance(input)).toMatchObject({ calculatedBalance: null, reconciledBalance: null, difference: null, reasons: ["missing_opening", "coverage_gap"] });
    input.movements = [{ ...row(input.scope.start, "100"), cashDelta: "0", openingDelta: "100", incompleteEvidence: true }];
    expect(calculateBankBalance(input).calculatedBalance).toBeNull();
  });
  it("merges overlapping and adjacent coverage but exposes even a one-day gap", () => {
    const input = fixture();
    input.coverage = [
      { evidenceId: "second", start: "2026-09-15", end: "2026-09-30", completeness: "complete" },
      { evidenceId: "first", start: "2026-08-15", end: "2026-09-14", completeness: "complete" },
    ];
    expect(calculateBankBalance(input).status).toBe("reconciled");
    input.coverage[1]!.end = "2026-09-13";
    expect(calculateBankBalance(input)).toMatchObject({ calculatedBalance: "80.100000000000", reconciledBalance: null, difference: null, reasons: ["coverage_gap"] });
    input.coverage.push({ evidenceId: "partial", start: "2026-09-14", end: "2026-09-14", completeness: "partial" });
    expect(calculateBankBalance(input).reasons).toContain("coverage_gap");
    input.coverage[2]!.completeness = "complete";
    expect(calculateBankBalance(input).status).toBe("reconciled");
  });
  it("retains mismatch and conflicting observations without choosing a convenient balance", () => {
    const input = fixture(); input.closing[0]!.balance = "85.10";
    expect(calculateBankBalance(input)).toMatchObject({ reconciledBalance: null, difference: "5.000000000000", reasons: ["balance_mismatch"] });
    input.closing.push({ evidenceId: "other", date: input.scope.asOf, balance: "80.10" });
    expect(calculateBankBalance(input)).toMatchObject({ observedBalance: null, difference: null, reasons: ["conflicting_closing"] });
    input.closing[0]!.balance = "80.100";
    expect(calculateBankBalance(input).status).toBe("reconciled");
  });
  it("does not carry an older observation forward or treat unknown as zero", () => {
    const input = fixture(); input.closing[0]!.date = "2026-09-29";
    input.closing.push({ evidenceId: "unknown", date: input.scope.asOf, balance: null });
    expect(calculateBankBalance(input)).toMatchObject({ observedBalance: null, reconciledBalance: null, reasons: ["missing_closing"] });
  });
  it("keeps unresolved evidence incomplete even when corrections net to zero beside an opening", () => {
    const input = fixture();
    input.opening = { kind: "reviewed_opening", evidenceId: "opening", date: input.scope.start, balance: "100", history: "unknown" };
    input.movements.unshift({ ...row(input.scope.start, "100"), cashDelta: "0", openingDelta: "100", incompleteEvidence: true, postingCount: 3 });
    input.unresolvedEventCount = 2;
    expect(calculateBankBalance(input)).toMatchObject({ difference: "0.000000000000", reconciledBalance: null, reasons: ["unresolved_evidence"] });
  });
  it("preserves foreign native balances without substituting historical INR book values", () => {
    const input = fixture(); input.scope.currency = "USD";
    input.movements = input.movements.map(value => ({ ...value, currency: "USD", bookDeltaInr: "8300" }));
    expect(calculateBankBalance(input).reconciledBalance).toBe("80.100000000000");
    expect(calculateBankBalance(input)).not.toHaveProperty("valueInr");
  });
  it("retains exact large sums and supports zero or negative balances", () => {
    const input = fixture(); input.opening!.balance = "9999999999999999999999999999";
    input.movements = [row("2026-09-10", "0.10")]; input.closing[0]!.balance = "9999999999999999999999999999.10";
    expect(calculateBankBalance(input).reconciledBalance).toBe("9999999999999999999999999999.100000000000");
    input.opening!.balance = "0"; input.movements = []; input.closing[0]!.balance = "0";
    expect(calculateBankBalance(input).reconciledBalance).toBe("0.000000000000");
    input.movements = [row("2026-09-10", "-10")]; input.closing[0]!.balance = "-10";
    expect(calculateBankBalance(input).reconciledBalance).toBe("-10.000000000000");
  });
  it("requires adjacent checkpoints and rebuilds when an opening changes mid-window", () => {
    const input = fixture(); input.opening!.date = "2026-08-30";
    expect(() => calculateBankBalance(input)).toThrow("immediately precede");
    input.opening!.date = "2026-08-31";
    input.movements.push({ ...row("2026-09-15", "10"), cashDelta: "0", openingDelta: "10", incompleteEvidence: true });
    expect(() => calculateBankBalance(input)).toThrow("rebuilding");
  });
  it("rejects invalid scopes, monetary inputs, future evidence, duplicate grains and oversized windows", () => {
    for (const patch of [{ accountId: "other" }, { ledgerKind: "liability" as const }, { currency: "USD" }, { date: "2026-10-01" }, { nativeDelta: "1e2" }, { cashDelta: "10" }, { nativeDelta: 1 as unknown as string }]) {
      const input = fixture(); Object.assign(input.movements[0]!, patch);
      expect(() => calculateBankBalance(input)).toThrow();
    }
    const input = fixture(); input.movements.push(input.movements[0]!);
    expect(() => calculateBankBalance(input)).toThrow("repeats");
    input.movements = []; input.closing[0]!.date = "2026-10-01";
    expect(() => calculateBankBalance(input)).toThrow("future");
    input.closing = []; input.coverage = Array(1001).fill(input.coverage[0]!);
    expect(() => calculateBankBalance(input)).toThrow("bounded");
  });
});
