import { D, decimal, economicDate } from "./decimal";
import { BANK_BALANCE_WINDOW_LIMIT, type BankBalanceInput } from "./bank-balance";
import type { AccountMovement } from "./bank-calculation";

export const BANK_BALANCE_POSTING_LIMIT = 5000;
export type BankBalancePosting = {
  id: string; eventId: string; date: string; kind: string; originalKind: string | null;
  quality: string; native: string; book: string; currency: string;
  reversed: boolean; reviewed: boolean;
};

// Source provenance must already be scoped to the captured household/revision.
// Aggregate authoritative postings independently of potentially repeated source links.
export function bankBalanceMovements(scope: Pick<BankBalanceInput["scope"], "accountId" | "currency" | "start">, postings: BankBalancePosting[]) {
  if (postings.length > BANK_BALANCE_POSTING_LIMIT) throw new Error("Balance posting limit exceeded.");
  const daily = new Map<string, AccountMovement>(), eventIds = new Set<string>();
  let unresolvedEventCount = 0;
  for (const p of postings) {
    economicDate(p.date);
    if (!p.id || !p.eventId || p.date < scope.start || typeof p.reversed !== "boolean" || typeof p.reviewed !== "boolean" || !["complete", "opening_history_unknown", "unresolved"].includes(p.quality)) throw new Error("Invalid bank balance provenance.");
    const kind = p.kind === "reversal" ? p.originalKind : p.kind;
    if (eventIds.has(p.eventId) || p.currency !== scope.currency || !kind || !["income", "expense", "expense_refund", "income_reversal", "transfer", "card_repayment", "opening_balance", "unresolved_reconciliation"].includes(kind)) throw new Error("Unsupported bank balance posting shape.");
    eventIds.add(p.eventId);
    const row = daily.get(p.date) ?? { accountId: scope.accountId, currency: scope.currency, ledgerKind: "asset", date: p.date, nativeDelta: "0", bookDeltaInr: "0", cashDelta: "0", openingDelta: "0", unresolvedDelta: "0", postingCount: 0, incompleteEvidence: false };
    row.nativeDelta = new D(row.nativeDelta).plus(decimal(p.native)).toFixed(12);
    row.bookDeltaInr = new D(row.bookDeltaInr).plus(decimal(p.book)).toFixed(12);
    const bucket = kind === "opening_balance" ? "openingDelta" : kind === "unresolved_reconciliation" ? "unresolvedDelta" : "cashDelta";
    row[bucket] = new D(row[bucket]).plus(p.native).toFixed(12);
    row.postingCount++; row.incompleteEvidence ||= p.quality !== "complete";
    if (kind === "unresolved_reconciliation" || p.quality === "unresolved") unresolvedEventCount++;
    daily.set(p.date, row);
  }
  if (daily.size > BANK_BALANCE_WINDOW_LIMIT) throw new Error("Balance movements require persisted checkpoint boundaries.");
  const openings = postings.filter(p => p.kind === "opening_balance" && !p.reversed);
  const opening = openings.length === 1 && openings[0]!.date === scope.start && openings[0]!.reviewed && openings[0]!.quality === "opening_history_unknown"
    && new D(daily.get(scope.start)!.openingDelta).eq(openings[0]!.native)
    && [...daily.values()].every(row => row.date === scope.start || new D(row.openingDelta).isZero())
    ? { kind: "reviewed_opening" as const, evidenceId: openings[0]!.eventId, date: scope.start, balance: openings[0]!.native, history: "unknown" as const } : null;
  return { opening, movements: [...daily.values()], unresolvedEventCount };
}
