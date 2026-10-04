import { D, decimal, economicDate } from "./decimal";

export const BANK_CALCULATION_RULE = "bank-movements-v1" as const;
export const BANK_CALCULATION_PAGE_SIZE = 100;
type BankKind = "income" | "expense" | "expense_refund" | "income_reversal" | "transfer" | "card_repayment" | "card_purchase" | "card_refund" | "card_interest" | "card_fee" | "opening_balance" | "unresolved_reconciliation";
export type BankCalculationLeg = {
  id: string; ledgerAccountId: string; accountId: string | null;
  kind: "asset" | "liability" | "equity" | "income" | "expense";
  currency: string; nativeAmount: string; bookAmountInr: string; categoryId: string | null;
};
export type BankCalculationEvent = {
  id: string; householdId: string; revision: number; effectiveDate: string;
  kind: BankKind | "reversal" | "fx_conversion"; reversedKind: BankKind | "fx_conversion" | null;
  quality: "complete" | "opening_history_unknown" | "unresolved";
  legs: BankCalculationLeg[];
};
export type BankCalculationContext = { householdId: string; sourceRevision: number; asOf: string };
export type AccountMovement = {
  accountId: string; currency: string; ledgerKind: "asset" | "liability"; date: string;
  nativeDelta: string; bookDeltaInr: string; cashDelta: string;
  openingDelta: string; unresolvedDelta: string; postingCount: number;
  incompleteEvidence: boolean;
};
export type CategoryMovement = {
  accountId: string; month: string; kind: "income" | "expense"; categoryId: string | null;
  amountInr: string; postingCount: number;
};

function validateEvent(event: BankCalculationEvent, context: BankCalculationContext) {
  if (!event.id || event.householdId !== context.householdId || !Number.isSafeInteger(event.revision) || event.revision < 1 || event.revision > context.sourceRevision) throw new Error("Event is outside the captured household revision.");
  economicDate(event.effectiveDate);
  if (event.effectiveDate > context.asOf) throw new Error("Event is after the requested date.");
  if (!["complete", "opening_history_unknown", "unresolved"].includes(event.quality)) throw new Error("Unknown evidence quality.");
  const kind = event.kind === "reversal" ? event.reversedKind : event.kind;
  if (!kind || !["income", "expense", "expense_refund", "income_reversal", "transfer", "card_repayment", "card_purchase", "card_refund", "card_interest", "card_fee", "opening_balance", "unresolved_reconciliation"].includes(kind)) throw new Error("Unsupported account calculation event; a matching financial rule is required.");
  if (event.kind !== "reversal" && event.reversedKind !== null) throw new Error("Unexpected reversal metadata.");
  if (event.legs.length !== 2 || new Set(event.legs.map(l => l.id)).size !== 2 || new Set(event.legs.map(l => l.ledgerAccountId)).size !== 2) throw new Error("A bank event requires two distinct posting legs.");
  const cardExpense = ["card_purchase", "card_refund", "card_interest", "card_fee"].includes(kind)
    || (["expense", "expense_refund"].includes(kind) && event.legs.some(leg => leg.kind === "liability"));
  const offset = ["income", "income_reversal"].includes(kind) ? "income" : ["expense", "expense_refund"].includes(kind) || cardExpense ? "expense" : kind === "transfer" ? "asset" : kind === "card_repayment" ? "liability" : "equity";
  const principal = event.legs.filter(l => l.kind === "asset" || l.kind === "liability");
  if (cardExpense ? (principal.length !== 1 || principal[0]!.kind !== "liability" || event.legs.some(l => !["liability", "expense"].includes(l.kind)))
    : ["opening_balance", "unresolved_reconciliation"].includes(kind) ? (principal.length !== 1 || event.legs.some(l => ![principal[0]!.kind, "equity"].includes(l.kind)))
    : event.legs.filter(l => l.kind === "asset").length !== (kind === "transfer" ? 2 : 1) || event.legs.some(l => l.kind !== "asset" && l.kind !== offset)) throw new Error("Posting shape does not match the account event.");
  let sum = new D(0);
  for (const leg of event.legs) {
    if (!leg.id || !leg.ledgerAccountId || !/^[A-Z]{3}$/.test(leg.currency)) throw new Error("Invalid posting identity or currency.");
    const native = decimal(leg.nativeAmount), book = decimal(leg.bookAmountInr);
    if (!book.eq(book.toDecimalPlaces(2)) || (leg.currency === "INR" && !native.eq(book))) throw new Error("Invalid INR settlement evidence.");
    if (native.isZero() || book.isZero() || native.isPositive() !== book.isPositive()) throw new Error("Posting signs must agree.");
    if (["asset", "liability"].includes(leg.kind) !== (leg.accountId !== null)) throw new Error("Bank account identity is missing or invalid.");
    if (leg.categoryId !== null && !["income", "expense"].includes(leg.kind)) throw new Error("Principal cannot have a spending category.");
    sum = sum.plus(book);
  }
  if (!sum.isZero()) throw new Error("Unbalanced bank event.");
  if (kind === "transfer" && event.legs[0]!.accountId === event.legs[1]!.accountId) throw new Error("Transfer accounts must differ.");
  const boundary = event.legs.find(l => l.kind === (cardExpense ? "liability" : "asset"))
    ?? event.legs.find(l => l.kind === "asset" || l.kind === "liability")!;
  if (!["transfer", "opening_balance", "unresolved_reconciliation"].includes(kind)) {
    const positive = (["income", "expense_refund", "card_refund"].includes(kind)) !== (event.kind === "reversal");
    if (decimal(boundary.bookAmountInr).isPositive() !== positive) throw new Error("Posting direction does not match the account event.");
  }
  if (["opening_balance", "unresolved_reconciliation"].includes(kind) && event.quality === "complete") throw new Error("Equity adjustments cannot establish complete history.");
  return kind;
}

// Pure, bounded contributions. These are unallocated ledger movements, not balances,
// scope cash flows, market valuations or net worth. Statement observations are not inputs.
export function calculateBankPage(context: BankCalculationContext, events: BankCalculationEvent[]) {
  economicDate(context.asOf);
  if (!context.householdId || !Number.isSafeInteger(context.sourceRevision) || context.sourceRevision < 1) throw new Error("Invalid calculation context.");
  if (events.length > BANK_CALCULATION_PAGE_SIZE || new Set(events.map(e => e.id)).size !== events.length) throw new Error("Calculation page is oversized or contains duplicate events.");
  const accounts = new Map<string, AccountMovement>(), categories = new Map<string, CategoryMovement>();
  const postingIds = new Set<string>();
  for (const event of events) {
    const kind = validateEvent(event, context);
    for (const leg of event.legs) {
      if (postingIds.has(leg.id)) throw new Error("Duplicate posting in calculation page.");
      postingIds.add(leg.id);
      if (leg.kind === "asset" || leg.kind === "liability") {
        const key = JSON.stringify([leg.accountId, leg.currency, leg.kind, event.effectiveDate]);
        const row = accounts.get(key) ?? { accountId: leg.accountId!, currency: leg.currency, ledgerKind: leg.kind, date: event.effectiveDate, nativeDelta: "0.000000000000", bookDeltaInr: "0.000000000000", cashDelta: "0.000000000000", openingDelta: "0.000000000000", unresolvedDelta: "0.000000000000", postingCount: 0, incompleteEvidence: false };
        row.nativeDelta = new D(row.nativeDelta).plus(leg.nativeAmount).toFixed(12);
        row.bookDeltaInr = new D(row.bookDeltaInr).plus(leg.bookAmountInr).toFixed(12);
        const bucket = kind === "opening_balance" ? "openingDelta" : kind === "unresolved_reconciliation" ? "unresolvedDelta" : "cashDelta";
        // Liability postings change outstanding principal, not settled bank cash.
        if (bucket !== "cashDelta" || leg.kind === "asset") row[bucket] = new D(row[bucket]).plus(leg.nativeAmount).toFixed(12);
        row.postingCount++;
        row.incompleteEvidence ||= event.quality !== "complete";
        accounts.set(key, row);
      } else if (leg.kind === "income" || leg.kind === "expense") {
        const accountId = event.legs.find(l => l.kind === "asset" || l.kind === "liability")!.accountId!;
        const month = `${event.effectiveDate.slice(0, 7)}-01`;
        const key = JSON.stringify([accountId, month, leg.kind, leg.categoryId]);
        const row = categories.get(key) ?? { accountId, month, kind: leg.kind, categoryId: leg.categoryId, amountInr: "0", postingCount: 0 };
        row.amountInr = new D(row.amountInr).plus(new D(leg.bookAmountInr).mul(leg.kind === "income" ? -1 : 1)).toFixed(12);
        row.postingCount++;
        categories.set(key, row);
      }
    }
  }
  // Sort by stable identifiers rather than input order or locale-dependent collation.
  const ordered = <T>(rows: Map<string, T>) => [...rows].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
  return { ruleVersion: BANK_CALCULATION_RULE, ...context, eventCount: events.length, accountMovements: ordered(accounts), categoryMovements: ordered(categories) };
}
