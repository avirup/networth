import { D, decimal, economicDate, money } from "./decimal";
import { cardMoney } from "@/lib/imports/card-v1";

type Interval = { validFrom: string; validTo: string | null };
export type CreditFacilityTerm = Interval & { facilityId: string; limitInr: string | null };
export type AccountFacilityLink = Interval & { accountId: string; facilityId: string };
export type CardPosition = { accountId: string; asOf: string; outstandingInr: string | null };
export const CARD_FACILITY_RULE = "card-facility-v1" as const;

function validateIntervals<T extends Interval>(rows: T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    economicDate(row.validFrom);
    if (row.validTo !== null) {
      economicDate(row.validTo);
      if (row.validTo <= row.validFrom) throw new Error("Effective intervals must have positive duration.");
    }
    const id = key(row);
    if (!id) throw new Error("Facility and account identifiers are required.");
    const group = groups.get(id) ?? []; group.push(row); groups.set(id, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    for (let index = 1; index < group.length; index++) {
      const previous = group[index - 1]!;
      if (previous.validTo === null || previous.validTo > group[index]!.validFrom)
        throw new Error("Effective intervals overlap.");
    }
  }
}

/** Household totals use each account once. Facility limits are metadata, never assets.
 * Callers supply all authorized active links and same-release positions, including unknowns. */
export function summarizeCardFacilities(input: { asOf: string; positions: CardPosition[]; terms: CreditFacilityTerm[]; links: AccountFacilityLink[] }) {
  economicDate(input.asOf);
  if ([input.positions, input.terms, input.links].some(rows => rows.length > 1000)) throw new Error("Card facility input exceeds its bounded limit.");
  validateIntervals(input.terms, row => row.facilityId);
  validateIntervals(input.links, row => row.accountId);
  for (const term of input.terms) {
    if (term.limitInr !== null && decimal(cardMoney(term.limitInr)).lt(0)) throw new Error("Credit limit cannot be negative.");
  }
  for (const link of input.links) if (!link.facilityId) throw new Error("A credit facility identifier is required.");
  const active = (row: Interval) => row.validFrom <= input.asOf && (row.validTo === null || input.asOf < row.validTo);
  const positions = new Map<string, CardPosition>();
  let debt = new D(0), credit = new D(0), unknownAccountCount = 0;
  for (const position of input.positions) {
    if (!position.accountId || positions.has(position.accountId) || position.asOf !== input.asOf)
      throw new Error("Card positions must be unique and share the report as-of date.");
    positions.set(position.accountId, position);
    if (position.outstandingInr === null) { unknownAccountCount++; continue; }
    const outstanding = decimal(cardMoney(position.outstandingInr));
    if (outstanding.gte(0)) debt = debt.plus(outstanding);
    else credit = credit.minus(outstanding);
  }
  const links = input.links.filter(active);
  for (const link of links) if (!positions.has(link.accountId)) throw new Error("A linked card position is missing; supply an explicit unknown.");
  const facilities = [...new Set(links.map(link => link.facilityId))].sort().map(facilityId => {
    const members = links.filter(link => link.facilityId === facilityId).map(link => positions.get(link.accountId)!);
    const term = input.terms.find(row => row.facilityId === facilityId && active(row));
    const unknown = members.some(member => member.outstandingInr === null);
    // Do not net a credit on one card against another card's drawn amount.
    const drawn = members.reduce((sum, member) => {
      const outstanding = member.outstandingInr === null ? new D(0) : decimal(member.outstandingInr);
      return outstanding.gt(0) ? sum.plus(outstanding) : sum;
    }, new D(0));
    const limit = term?.limitInr === null || term?.limitInr === undefined ? null : decimal(term.limitInr);
    const reason = unknown ? "unknown_outstanding" : limit === null ? "missing_limit" : limit.isZero() ? "zero_limit" : null;
    const available = !unknown && limit !== null ? D.max(limit.minus(drawn), 0) : null;
    return {
      facilityId, accountIds: members.map(member => member.accountId).sort(),
      limitInr: limit?.toFixed(12) ?? null, drawnInr: unknown ? null : drawn.toFixed(12),
      availableCreditInr: available?.toFixed(12) ?? null,
      overLimitInr: !unknown && limit !== null ? D.max(drawn.minus(limit), 0).toFixed(12) : null,
      utilizationPercent: reason === null ? drawn.div(limit!).mul(100).toFixed(6) : null,
      reason,
    };
  });
  return {
    ruleVersion: CARD_FACILITY_RULE, asOf: input.asOf,
    knownLiabilitiesInr: money(debt.toFixed()), knownCreditBalancesInr: money(credit.toFixed()),
    knownNetWorthContributionInr: money(credit.minus(debt).toFixed()), unknownAccountCount,
    facilities, unlinkedAccountIds: [...positions.keys()].filter(id => !links.some(link => link.accountId === id)).sort(),
  };
}
