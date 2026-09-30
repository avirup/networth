import "server-only";
import { sql } from "drizzle-orm";
import type { Transaction } from "@/db/auth/connection";
import type { Actor } from "@/db/auth/service";
import { AccessError } from "@/lib/auth/errors";
import { FINANCIAL_SCHEMA } from "@/lib/config/policy";
import { economicDate } from "@/lib/finance/decimal";

const RESPONSE_LIMIT = 3_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ReportQuality = {
  status: "complete" | "incomplete" | "stale" | "paused";
  coverageStart: string | null; coverageEnd: string | null; newestImportAt: string | null;
  incompleteBatchCount: number; latestSourceRevision: number;
  pauseReason: "capacity" | "retry_limit" | "window_limit" | null;
};
export type BankOverview = {
  release: { id: string; asOf: string; sourceRevision: number; publishedAt: string; reloadedCurrent: boolean };
  scope: { kind: "household"; id: string; asOf: string };
  summary: { knownAssetsInr: string; netWorthInr: string; monthlyIncomeInr: string; monthlyExpenseInr: string; unknownAccountCount: number };
  accounts: { id: string; name: string; currency: string; effectiveDate: string; calculatedBalance: string | null; reconciledBalance: string | null; status: "reconciled" | "incomplete"; reasons: string[] }[];
  categories: { kind: "income" | "expense"; category: string; amountInr: string; postingCount: number }[];
  trends: { month: string; incomeInr: string; expenseInr: string }[];
  cashFlow: { recognizedIncomeInr: string; recognizedExpenseInr: string; debtPrincipalInr: string; investmentAllocationInr: null; investmentReason: string; otherFundingInr: string; netCashMovementInr: string };
  largestExpense: { eventId: string; date: string; amountInr: string; counterparty: string } | null;
  quality: ReportQuality;
};
export type BankActivityItem = {
  id: string; kind: string; date: string; description: string; amountInr: string; category: string | null; accounts: string | null; quality: string;
  import: { batchId: string; revision: number; confirmedAt: string };
  sources: { id: string; rowNumber: number; rowId: string | null; description: string | null; transactionReference: string | null }[];
};
export type BankActivityPage = { releaseId: string; items: BankActivityItem[]; nextCursor: string | null; reloadedCurrent: boolean };
type PinContext = { releaseId: string; reloadedCurrent: boolean };

function requireSchema(actor: Actor) {
  if (actor.schemaVersion !== FINANCIAL_SCHEMA) throw new AccessError(503, "The installation needs an administrator upgrade.");
}
function responseSize<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > RESPONSE_LIMIT) throw new AccessError(503, "The published report is unavailable.");
  return value;
}
async function pinReport(tx: Transaction, actor: Actor, requestedRelease?: string | null) {
  requireSchema(actor);
  if (requestedRelease && !UUID.test(requestedRelease)) throw new AccessError(400, "Choose a valid report release.");
  return (await tx.execute<{ context: PinContext | null }>(sql`select ops.pin_report_context(${actor.householdId}::uuid,${requestedRelease ?? null}::uuid) context`)).rows[0]?.context ?? null;
}
export function reportCacheKey(input: { householdId: string; scope: string; releaseId: string; asOf: string; month: string; resource: string; cursor?: string | null; limit?: number }) {
  return [input.householdId, input.scope, input.releaseId, input.asOf, input.month, input.resource, input.cursor ?? "", input.limit ?? ""].join(":");
}
export async function readBankOverview(tx: Transaction, actor: Actor, month: string, requestedRelease?: string | null) {
  economicDate(`${month}-01`);
  const context = await pinReport(tx, actor, requestedRelease);
  if (!context) return null;
  const report = (await tx.execute<{ report: BankOverview }>(sql`select reporting.bank_dashboard(${actor.householdId}::uuid,${context.releaseId}::uuid,${`${month}-01`}::date,'household',null) report`)).rows[0]?.report;
  if (!report) throw new AccessError(503, "The published report is unavailable.");
  report.release.reloadedCurrent = context.reloadedCurrent;
  return responseSize(report);
}
type Cursor = { date: string; id: string };
function decodeCursor(value?: string | null): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    economicDate(parsed.date);
    if (!UUID.test(parsed.id)) throw new Error();
    return parsed;
  } catch { throw new AccessError(400, "The activity page cursor is invalid."); }
}
function encodeCursor(value: Cursor) { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
export async function readBankActivity(tx: Transaction, actor: Actor, input: { month: string; releaseId: string; cursor?: string | null; limit: number }) {
  economicDate(`${input.month}-01`);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000) throw new AccessError(400, "Choose an activity page size from 1 to 1,000.");
  const cursor = decodeCursor(input.cursor);
  const context = await pinReport(tx, actor, input.releaseId);
  if (!context) return null;
  const raw = (await tx.execute<{ report: { releaseId: string; items: BankActivityItem[]; hasMore: boolean } }>(sql`select reporting.bank_activity(
    ${actor.householdId}::uuid,${context.releaseId}::uuid,${`${input.month}-01`}::date,${input.limit},${cursor?.date ?? null}::date,${cursor?.id ?? null}::uuid
  ) report`)).rows[0]?.report;
  if (!raw) throw new AccessError(503, "The published activity is unavailable.");
  const last = raw.items.at(-1);
  return responseSize<BankActivityPage>({ releaseId: context.releaseId, items: raw.items,
    nextCursor: raw.hasMore && last ? encodeCursor({ date: last.date, id: last.id }) : null,
    reloadedCurrent: context.reloadedCurrent });
}
