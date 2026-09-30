import "server-only";
import { sql } from "drizzle-orm";
import type { Transaction } from "@/db/auth/connection";
import type { Actor } from "@/db/auth/service";
import { AccessError } from "@/lib/auth/errors";
import { FINANCIAL_SCHEMA } from "@/lib/config/policy";
import { economicDate } from "@/lib/finance/decimal";

export type BankOverview = {
  release: { id: string; asOf: string; sourceRevision: number; publishedAt: string };
  summary: { knownAssetsInr: string; netWorthInr: string; monthlyIncomeInr: string; monthlyExpenseInr: string; unknownAccountCount: number };
  accounts: { id: string; name: string; currency: string; effectiveDate: string; calculatedBalance: string | null; reconciledBalance: string | null; status: "reconciled" | "incomplete"; reasons: string[] }[];
  categories: { kind: "income" | "expense"; category: string; amountInr: string; postingCount: number }[];
};

export async function readBankOverview(tx: Transaction, actor: Actor, month: string) {
  if (actor.schemaVersion !== FINANCIAL_SCHEMA) throw new AccessError(503, "The installation needs an administrator upgrade.");
  economicDate(`${month}-01`);
  const pinned = (await tx.execute<{ release: string | null }>(sql`select ops.pin_current_report(${actor.householdId}::uuid) release`)).rows[0]?.release;
  if (!pinned) return null;
  const report = (await tx.execute<{ report: BankOverview }>(sql`select reporting.bank_overview(${actor.householdId}::uuid,${pinned}::uuid,${`${month}-01`}::date) report`)).rows[0]?.report;
  if (!report || Buffer.byteLength(JSON.stringify(report), "utf8") > 3_000_000) throw new AccessError(503, "The published report is unavailable.");
  return report;
}
