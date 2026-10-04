import "server-only";
import { sql } from "drizzle-orm";
import type { Transaction } from "@/db/auth/connection";
import type { Actor } from "@/db/auth/service";
import { economicDate } from "@/lib/finance/decimal";
import { FINANCIAL_SCHEMA } from "@/lib/config/policy";
import { AccessError } from "@/lib/auth/errors";

export type CardEvidence = {
  terms: { facilityId: string; name: string; effectiveDate: string; limitInr: string | null; revision: number; sourceId: string }[];
  links: { accountId: string; facilityId: string | null; effectiveDate: string; revision: number; sourceId: string }[];
  statements: { accountId: string; observationId: string; statementDate: string; outstandingInr: string | null; paymentDueDate: string | null; minimumDue: string | null; revision: number }[];
};

/** Invoke inside identity.scoped. Snapshot dates and source revision must come from
 * the caller's authorized report release; this does not publish a report itself. */
export async function readCardEvidence(tx: Transaction, actor: Actor, asOf: string, sourceRevision: number): Promise<CardEvidence> {
  economicDate(asOf);
  if (actor.schemaVersion !== FINANCIAL_SCHEMA) throw new AccessError(503, "The installation schema is unavailable.");
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) throw new AccessError(400, "Invalid source revision.");
  const revision = await tx.execute<{ revision: number }>(sql`select revision from ops.source_revision where household_id=${actor.householdId}`);
  if (!revision.rows[0] || sourceRevision > revision.rows[0].revision) throw new AccessError(400, "Source revision is not available.");
  const terms = await tx.execute<CardEvidence["terms"][number]>(sql`
    select * from (
      select distinct on (t.facility_id) t.facility_id as "facilityId",f.name,t.effective_date::text as "effectiveDate",
        t.limit_inr::text as "limitInr",b.revision,t.source_id as "sourceId"
      from core.credit_facility_term t join core.credit_facility f on f.id=t.facility_id and f.household_id=t.household_id
      join core.source_record s on s.id=t.source_id and s.household_id=t.household_id
      join core.import_batch b on b.id=s.batch_id and b.household_id=s.household_id
      where t.household_id=${actor.householdId} and t.effective_date<=${asOf}::date and b.revision<=${sourceRevision}
      order by t.facility_id,t.effective_date desc,b.revision desc
    ) current_terms order by "facilityId" limit 1001`);
  const links = await tx.execute<CardEvidence["links"][number]>(sql`
    select * from (
      select distinct on (l.account_id) l.account_id as "accountId",l.facility_id as "facilityId",
        l.effective_date::text as "effectiveDate",b.revision,l.source_id as "sourceId"
      from core.account_facility_link l join core.source_record s on s.id=l.source_id and s.household_id=l.household_id
      join core.import_batch b on b.id=s.batch_id and b.household_id=s.household_id
      where l.household_id=${actor.householdId} and l.effective_date<=${asOf}::date and b.revision<=${sourceRevision}
      order by l.account_id,l.effective_date desc,b.revision desc
    ) current_links order by "accountId" limit 1001`);
  const statements = await tx.execute<CardEvidence["statements"][number]>(sql`
    select * from (
      select distinct on (o.account_id) o.account_id as "accountId",o.id as "observationId",o.as_of::text as "statementDate",
        o.balance::text as "outstandingInr",c.payment_due_date::text as "paymentDueDate",c.minimum_due::text as "minimumDue",b.revision
      from core.card_statement c join core.fact_statement_observation o on o.id=c.observation_id and o.household_id=c.household_id
      join core.source_record s on s.id=o.source_id and s.household_id=o.household_id
      join core.import_batch b on b.id=s.batch_id and b.household_id=s.household_id
      where c.household_id=${actor.householdId} and o.as_of<=${asOf}::date and b.revision<=${sourceRevision}
      order by o.account_id,o.as_of desc,b.revision desc,c.id
    ) current_statements order by "accountId" limit 1001`);
  const result: CardEvidence = { terms: terms.rows, links: links.rows, statements: statements.rows };
  if (Object.values(result).some(rows => rows.length > 1000) || Buffer.byteLength(JSON.stringify(result)) > 3_000_000)
    throw new AccessError(503, "Card evidence exceeds the bounded response size.");
  return result;
}
