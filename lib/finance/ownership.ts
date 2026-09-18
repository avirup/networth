import { D, decimal, economicDate } from "./decimal";
export type Allocation = { targetId: string; validFrom: string; validTo: string | null; shares: { ownerId: string; fraction: string }[] };
export function ownershipShare(account: Allocation[], holding: Allocation[], selectedOwners: string[], asOf: string) {
  economicDate(asOf);
  const active = (rows: Allocation[]) => rows.filter(row => row.validFrom <= asOf && (!row.validTo || asOf < row.validTo));
  const specific = active(holding); const candidates = specific.length ? specific : active(account);
  if (!candidates.length) return { fraction: null, reason: "Ownership is not known for this date." };
  if (candidates.length !== 1) throw new Error("Overlapping ownership allocations.");
  const shares = candidates[0]!.shares;
  if (new Set(shares.map(s => s.ownerId)).size !== shares.length || shares.some(s => decimal(s.fraction, 18).lt(0) || decimal(s.fraction, 18).gt(1)) || !shares.reduce((sum,s) => sum.plus(decimal(s.fraction,18)),new D(0)).eq(1)) throw new Error("Ownership fractions must total one.");
  return { fraction: shares.filter(s => selectedOwners.includes(s.ownerId)).reduce((sum,s) => sum.plus(decimal(s.fraction,18)),new D(0)).toFixed(18), reason: null };
}
export function scopedHoldingIds(positions: { id: string; accountId: string }[], accountIds: string[], holdingIds: string[]) {
  return [...new Set(positions.filter(position => holdingIds.includes(position.id) || accountIds.includes(position.accountId)).map(position=>position.id))];
}
