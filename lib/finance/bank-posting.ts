import { D, decimal, money } from "./decimal";
import { normalizeBankRow, type BankRow } from "@/lib/imports/bank-v1";
export type Leg = { account: string; kind: "asset" | "liability" | "equity" | "income" | "expense"; currency: string; nativeAmount: string; bookAmountInr: string; category: string | null };
export type PostingContext = { cashAccount: string; offsetAccount: string; offsetKind: Leg["kind"]; reviewedAdjustment?: boolean };
export function bankPostings(input: BankRow, context: PostingContext): { legs: Leg[]; quality: "complete" | "opening_history_unknown" | "unresolved" } {
  const row = normalizeBankRow(input);
  if (!context.cashAccount || !context.offsetAccount || context.cashAccount === context.offsetAccount) throw new Error("Two distinct ledger accounts are required.");
  const expected = ["income", "income_reversal"].includes(row.event_type) ? "income" : ["expense", "expense_refund"].includes(row.event_type) ? "expense" : row.event_type === "card_repayment" ? "liability" : row.event_type === "transfer" ? "asset" : "equity";
  if (context.offsetKind !== expected) throw new Error("Offset account does not match the economic event.");
  if (expected === "equity" && !context.reviewedAdjustment) throw new Error("Opening or unresolved equity requires explicit review.");
  const sign = row.direction === "credit" ? "1" : "-1";
  const amount = decimal(row.amount).mul(sign);
  const book = (row.book_amount_inr ? decimal(row.book_amount_inr) : row.currency === "INR" ? decimal(row.amount) : decimal(row.amount).mul(decimal(row.fx_rate, 18))).toDecimalPlaces(2).mul(sign);
  if (book.isZero()) throw new Error("Amount rounds to zero at INR settlement precision.");
  const legs: Leg[] = [
    { account: context.cashAccount, kind: "asset", currency: row.currency, nativeAmount: money(amount.toFixed()), bookAmountInr: money(book.toFixed()), category: null },
    { account: context.offsetAccount, kind: context.offsetKind, currency: "INR", nativeAmount: money(book.neg().toFixed()), bookAmountInr: money(book.neg().toFixed()), category: row.category || null },
  ];
  assertBalanced(legs);
  return { legs, quality: row.event_type === "opening_balance" ? "opening_history_unknown" : row.event_type === "unresolved_reconciliation" ? "unresolved" : "complete" };
}
export function assertBalanced(legs: Leg[]) {
  if (legs.length < 2 || !legs.reduce((sum, leg) => sum.plus(decimal(leg.bookAmountInr)), new D(0)).isZero()) throw new Error("An event requires at least two exactly balanced postings.");
}
export function reversePostings(legs: Leg[]) { assertBalanced(legs); return legs.map(leg => ({ ...leg, nativeAmount: money(decimal(leg.nativeAmount).neg().toFixed()), bookAmountInr: money(decimal(leg.bookAmountInr).neg().toFixed()) })); }
export function reconcile(opening: string | null, movements: string[], closing: string | null, complete: boolean) {
  if (opening === null || closing === null || !complete) return { status: "unknown" as const, calculated: null, difference: null, reason: "Opening balance, closing evidence or complete transaction coverage is missing." };
  const calculated = movements.reduce((sum, value) => sum.plus(decimal(value)), decimal(opening));
  const difference = decimal(closing).minus(calculated);
  return { status: difference.isZero() ? "matched" as const : "mismatch" as const, calculated: money(calculated.toFixed()), difference: money(difference.toFixed()), reason: difference.isZero() ? null : "Review missing, duplicate or incorrectly classified records; no balancing expense is created." };
}

// Reviewed conversion: source carrying value is evidence, never inferred cost basis.
// FX P&L is separate from ordinary income/spending; fees are an explicit expense leg.
export function fxConversion(input: { sourceAccount: string; destinationAccount: string; gainAccount: string; feeAccount: string; sourceCurrency: string; sourceAmount: string; carryingInr: string | null; grossProceedsInr: string; feeInr: string }): { status: "unknown"; reason: string } | { status: "complete"; legs: Leg[] } {
  if (input.carryingInr === null) return { status: "unknown", reason: "The source carrying value is unknown; realized FX cannot be invented." };
  const native = decimal(input.sourceAmount), carrying = decimal(input.carryingInr), proceeds = decimal(input.grossProceedsInr), fee = decimal(input.feeInr);
  if (!native.gt(0) || !carrying.gt(0) || !proceeds.gt(0) || fee.lt(0) || fee.gte(proceeds)) throw new Error("Invalid reviewed conversion amounts.");
  if ([carrying,proceeds,fee].some(value => !value.eq(value.toDecimalPlaces(2)))) throw new Error("Conversion book values must be settled to INR paise.");
  if (new Set([input.sourceAccount,input.destinationAccount,input.gainAccount,input.feeAccount]).size!==4) throw new Error("Conversion accounts must be distinct.");
  const make = (account: string, kind: Leg["kind"], amount: DecimalValue, category: string | null = null): Leg => ({ account,kind,currency:"INR",nativeAmount:money(amount.toFixed()),bookAmountInr:money(amount.toFixed()),category });
  const gain = proceeds.minus(carrying);
  const legs: Leg[] = [{ account:input.sourceAccount,kind:"asset",currency:input.sourceCurrency,nativeAmount:money(native.neg().toFixed()),bookAmountInr:money(carrying.neg().toFixed()),category:null },make(input.destinationAccount,"asset",proceeds.minus(fee))];
  if (!gain.isZero()) legs.push(make(input.gainAccount,gain.gt(0)?"income":"expense",gain.neg()));
  if (!fee.isZero()) legs.push(make(input.feeAccount,"expense",fee,"fees"));
  assertBalanced(legs); return { status:"complete", legs };
}
type DecimalValue = InstanceType<typeof D>;
