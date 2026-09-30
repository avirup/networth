import { D, decimal, economicDate } from "./decimal";
import type { AccountMovement, BankCalculationContext } from "./bank-calculation";

export const BANK_BALANCE_RULE = "bank-balance-v1" as const;
export const BANK_BALANCE_WINDOW_LIMIT = 1000;
type Scope = BankCalculationContext & { accountId: string; currency: string; start: string };
type Opening = {
  // A reviewed opening is already included in the first day's openingDelta.
  // A checkpoint is the closing balance immediately before this window.
  kind: "reviewed_opening" | "checkpoint";
  evidenceId: string; date: string; balance: string;
  history: "unknown" | "complete";
};
type Coverage = { evidenceId: string; start: string; end: string; completeness: "complete" | "partial" | "balance_only" };
type Closing = { evidenceId: string; date: string; balance: string | null };
export type BankBalanceInput = {
  scope: Scope;
  opening: Opening | null;
  movements: AccountMovement[];
  coverage: Coverage[];
  closing: Closing[];
  // Count source events, including exact reversals; net deltas can conceal them.
  unresolvedEventCount: number;
};
export type BankBalanceReason = "missing_opening" | "coverage_gap" | "missing_closing" | "conflicting_closing" | "balance_mismatch" | "unresolved_evidence";
const day = (date: string) => Date.parse(`${economicDate(date)}T00:00:00Z`) / 86_400_000;
// Candidate aggregates can exceed an individual NUMERIC(38,12) posting.
const aggregate = (value: string) => decimal(value, 12, 62);

/** Pure account-window evaluation. Callers must supply all captured, deduplicated
 * ledger movements and verified evidence from the same authorized source revision.
 * This function neither authorizes evidence IDs nor publishes a reporting fact. */
export function calculateBankBalance(input: BankBalanceInput) {
  const { scope, opening, movements, coverage, closing } = input;
  const first = day(scope.start), last = day(scope.asOf);
  if (!scope.householdId || !scope.accountId || !/^[A-Z]{3}$/.test(scope.currency) || !Number.isSafeInteger(scope.sourceRevision) || scope.sourceRevision < 1 || first > last) throw new Error("Invalid bank balance scope.");
  if ([movements, coverage, closing].some(rows => rows.length > BANK_BALANCE_WINDOW_LIMIT)) throw new Error("Balance window exceeds its bounded input limit.");
  if (!Number.isSafeInteger(input.unresolvedEventCount) || input.unresolvedEventCount < 0) throw new Error("Invalid unresolved evidence count.");
  const reasons: BankBalanceReason[] = [];
  let total = new D(0), openingDelta = new D(0), unresolved = input.unresolvedEventCount > 0;
  const dates = new Set<string>();
  for (const row of movements) {
    const date = day(row.date);
    if (row.accountId !== scope.accountId || row.currency !== scope.currency || row.ledgerKind !== "asset" || date < first || date > last || dates.has(row.date)) throw new Error("Movement is outside the bank window or repeats a daily grain.");
    dates.add(row.date);
    if (!Number.isSafeInteger(row.postingCount) || row.postingCount < 1 || typeof row.incompleteEvidence !== "boolean") throw new Error("Invalid movement evidence.");
    const native = aggregate(row.nativeDelta), cash = aggregate(row.cashDelta), equity = aggregate(row.openingDelta), adjustment = aggregate(row.unresolvedDelta);
    const book = aggregate(row.bookDeltaInr);
    if (!native.eq(cash.plus(equity).plus(adjustment)) || (scope.currency === "INR" && !book.eq(native))) throw new Error("Movement buckets do not reconcile.");
    if (!equity.isZero() && opening !== null && (opening.kind !== "reviewed_opening" || date !== first)) throw new Error("Opening changes require rebuilding from their reviewed starting point.");
    total = total.plus(native); openingDelta = openingDelta.plus(equity);
    // Net-zero corrections still retain their evidence warning. A reviewed opening
    // itself has unknown prior history, which does not invalidate current balances.
    unresolved ||= !adjustment.isZero() || (row.incompleteEvidence && !(opening?.kind === "reviewed_opening" && date === first && !equity.isZero()));
  }
  let baseline: InstanceType<typeof D> | null = null;
  if (opening) {
    const openingDay = day(opening.date);
    if (!opening.evidenceId || !["unknown", "complete"].includes(opening.history) || !["reviewed_opening", "checkpoint"].includes(opening.kind)) throw new Error("Invalid opening provenance.");
    if (opening.kind === "reviewed_opening") {
      if (openingDay !== first || opening.history !== "unknown" || !openingDelta.eq(aggregate(opening.balance))) throw new Error("Reviewed opening must match its ledger contribution and retain unknown prior history.");
      baseline = new D(0); // Already in total; never add the opening a second time.
    } else {
      if (openingDay !== first - 1) throw new Error("Checkpoint must immediately precede the window.");
      baseline = aggregate(opening.balance);
    }
  } else reasons.push("missing_opening");

  const evidenceIds = new Set<string>();
  const intervals = coverage.map(row => {
    const start = day(row.start), end = day(row.end);
    if (!row.evidenceId || evidenceIds.has(row.evidenceId) || start > end || !["complete", "partial", "balance_only"].includes(row.completeness)) throw new Error("Invalid or duplicate coverage evidence.");
    evidenceIds.add(row.evidenceId);
    return { start, end, complete: row.completeness === "complete" };
  }).filter(row => row.complete && row.end >= first && row.start <= last).sort((a, b) => a.start - b.start);
  let coveredThrough = first - 1;
  for (const interval of intervals) {
    if (interval.start > coveredThrough + 1) break;
    coveredThrough = Math.max(coveredThrough, interval.end);
  }
  if (coveredThrough < last) reasons.push("coverage_gap");
  const closingIds = new Set<string>(), values = new Set<string>();
  for (const row of closing) {
    const date = day(row.date);
    if (!row.evidenceId || closingIds.has(row.evidenceId) || date < first || date > last) throw new Error("Invalid or future closing evidence.");
    closingIds.add(row.evidenceId);
    if (row.balance !== null) {
      const value = aggregate(row.balance).toFixed(12);
      if (date === last) values.add(value);
    }
  }
  if (!values.size) reasons.push("missing_closing");
  if (values.size > 1) reasons.push("conflicting_closing");
  const calculated = baseline === null ? null : baseline.plus(total);
  const observed = values.size === 1 ? [...values][0]! : null;
  const difference = calculated !== null && observed !== null && coveredThrough >= last ? new D(observed).minus(calculated) : null;
  if (difference !== null && !difference.isZero()) reasons.push("balance_mismatch");
  if (unresolved) reasons.push("unresolved_evidence");
  return {
    ruleVersion: BANK_BALANCE_RULE, ...scope,
    calculatedBalance: calculated?.toFixed(12) ?? null,
    observedBalance: observed, difference: difference?.toFixed(12) ?? null,
    reconciledBalance: reasons.length === 0 ? calculated!.toFixed(12) : null,
    status: reasons.length === 0 ? "reconciled" as const : "incomplete" as const,
    history: opening?.history ?? "unknown", reasons,
    openingEvidenceId: opening?.evidenceId ?? null,
    coverageEvidenceIds: coverage.map(row => row.evidenceId).sort(),
    closingEvidenceIds: closing.filter(row => row.date === scope.asOf).map(row => row.evidenceId).sort(),
  };
}
