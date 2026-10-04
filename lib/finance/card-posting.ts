import { normalizeCardRow, validateCardBatch, cardMoney, type CardRow } from "@/lib/imports/card-v1";
import { assertBalanced, reconcile, type Leg } from "./bank-posting";
import { decimal, money } from "./decimal";

export const CARD_POSTING_RULE = "card-postings-v1" as const;
export function cardPostings(input: CardRow, context: { cardAccount: string; offsetAccount: string; offsetKind: "expense" | "asset" }) {
  const row = normalizeCardRow(input);
  if (!context.cardAccount || !context.offsetAccount || context.cardAccount === context.offsetAccount) throw new Error("Two distinct ledger accounts are required.");
  const repayment = row.event_type === "card_repayment";
  if (context.offsetKind !== (repayment ? "asset" : "expense")) throw new Error("Card offset account does not match the economic event.");
  // Card debits increase debt, so their liability posting is a negative credit.
  const liability = decimal(row.amount).mul(row.direction === "debit" ? -1 : 1);
  const leg = (account: string, kind: Leg["kind"], value: string, category: string | null): Leg =>
    ({ account, kind, currency: "INR", nativeAmount: money(value), bookAmountInr: money(value), category });
  const legs = [
    leg(context.cardAccount, "liability", liability.toFixed(), null),
    leg(context.offsetAccount, context.offsetKind, liability.neg().toFixed(), repayment ? null : row.category || null),
  ];
  assertBalanced(legs);
  return { ruleVersion: CARD_POSTING_RULE, legs };
}

/** Explicit opening equity, never inferred from a closing statement. Zero needs no event. */
export function cardOpeningPostings(outstanding: string, context: { cardAccount: string; equityAccount: string; reviewed: boolean }) {
  cardMoney(outstanding);
  if (!context.reviewed || !context.cardAccount || !context.equityAccount || context.cardAccount === context.equityAccount)
    throw new Error("Opening debt requires reviewed, distinct card and equity accounts.");
  const value = decimal(outstanding);
  const legs: Leg[] = value.isZero() ? [] : [
    { account: context.cardAccount, kind: "liability", currency: "INR", nativeAmount: money(value.neg().toFixed()), bookAmountInr: money(value.neg().toFixed()), category: null },
    { account: context.equityAccount, kind: "equity", currency: "INR", nativeAmount: money(value.toFixed()), bookAmountInr: money(value.toFixed()), category: null },
  ];
  if (legs.length) assertBalanced(legs);
  return { legs, quality: "opening_history_unknown" as const };
}

export function reconcileCardStatement(manifestInput: unknown, rowInputs: unknown[]) {
  const { manifest, rows } = validateCardBatch(manifestInput, rowInputs);
  const movements = rows.map(row => decimal(row.amount).mul(row.direction === "debit" ? 1 : -1).toFixed());
  return reconcile(manifest.openingOutstanding, movements, manifest.statementOutstanding, manifest.completeness === "complete");
}
