import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { hashPassword, verifyPassword } from "@/lib/auth/passwords";
import { makeRecoveryCodes, normalizeCode, protectedDigest } from "@/lib/auth/crypto";
import { passwordSchema } from "@/lib/auth/validation";
import { FINANCIAL_SCHEMA } from "@/lib/config/policy";
import { BACKUP_PART_BYTES, BACKUP_PART_ROWS, backupManifestSchema, createBackupWriter, sha256, verifyBackup, type BackupManifest, type BackupPart } from "@/lib/backup/format";

type TableSpec = { name: `${"core" | "ops"}.${string}`; from: string; where: string; order: string; excluded?: string[] };

export const BACKUP_TABLES: TableSpec[] = [
  { name: "core.household", from: "core.household t", where: "t.id=$1", order: "t.id" },
  { name: "core.auth_user", from: "core.auth_user t", where: "exists(select 1 from core.household_membership m where m.user_id=t.id and m.household_id=$1)", order: "t.id" },
  { name: "core.household_membership", from: "core.household_membership t", where: "t.household_id=$1", order: "t.id" },
  { name: "core.dim_institution", from: "core.dim_institution t", where: "t.household_id=$1", order: "t.id" },
  { name: "core.credit_facility", from: "core.credit_facility t", where: "t.household_id=$1", order: "t.id" },
  { name: "core.dim_account", from: "core.dim_account t", where: "t.household_id=$1", order: "t.id" },
  { name: "core.dim_instrument", from: "core.dim_instrument t", where: "t.household_id=$1", order: "t.id" },
  { name: "core.holding", from: "core.holding t", where: "t.household_id=$1", order: "t.id" },
  { name: "core.dim_owner", from: "core.dim_owner t", where: "t.household_id=$1", order: "t.id" },
  { name: "core.dim_category", from: "core.dim_category t", where: "t.household_id=$1", order: "t.code,t.id" },
  { name: "core.dim_counterparty", from: "core.dim_counterparty t", where: "t.household_id=$1", order: "t.id" },
  { name: "core.reporting_scope", from: "core.reporting_scope t", where: "t.household_id=$1", order: "t.id" },
  { name: "core.scope_member", from: "core.scope_member t", where: "t.household_id=$1", order: "t.id" },
  { name: "core.ownership_allocation", from: "core.ownership_allocation t", where: "t.household_id=$1", order: "t.valid_from,t.id" },
  { name: "core.ownership_interest", from: "core.ownership_interest t", where: "t.household_id=$1", order: "t.allocation_id,t.id" },
  { name: "core.ledger_account", from: "core.ledger_account t", where: "t.household_id=$1", order: "t.code,t.id" },
  { name: "core.import_batch", from: "core.import_batch t", where: "t.household_id=$1", order: "t.revision,t.id", excluded: ["created_xid"] },
  { name: "core.source_record", from: "core.source_record t", where: "t.household_id=$1", order: "t.batch_id,t.row_number,t.id" },
  { name: "core.transaction_event", from: "core.transaction_event t", where: "t.household_id=$1", order: "t.recorded_at,t.id" },
  { name: "core.event_source_link", from: "core.event_source_link t", where: "t.household_id=$1", order: "t.event_id,t.source_id,t.id" },
  { name: "core.fact_posting", from: "core.fact_posting t", where: "t.household_id=$1", order: "t.event_id,t.line_number,t.id" },
  { name: "core.fact_statement_observation", from: "core.fact_statement_observation t", where: "t.household_id=$1", order: "t.as_of,t.id" },
  { name: "core.credit_facility_term", from: "core.credit_facility_term t", where: "t.household_id=$1", order: "t.effective_date,t.id" },
  { name: "core.account_facility_link", from: "core.account_facility_link t", where: "t.household_id=$1", order: "t.effective_date,t.id" },
  { name: "core.card_statement", from: "core.card_statement t", where: "t.household_id=$1", order: "t.id" },
  { name: "core.reconciliation_result", from: "core.reconciliation_result t", where: "t.household_id=$1", order: "t.revision,t.id" },
  { name: "ops.source_revision", from: "ops.source_revision t", where: "t.household_id=$1", order: "t.household_id" },
];

const RESTORE_ORDER = BACKUP_TABLES.map(table => table.name);
const SECURITY_EXCLUSIONS = [
  "password hashes", "sessions", "recovery codes", "reset and invitation tokens", "authentication throttles",
  "security audit history", "provider credentials", "workflow delivery history", "derived report generations",
];

function quote(value: string) { return `"${value.replaceAll('"', '""')}"`; }
function relation(name: string) { const [schema, table] = name.split("."); return `${quote(schema!)}.${quote(table!)}`; }
function exactText(value: unknown) { return typeof value === "string" ? value : String(value ?? "0"); }

async function controls(client: PoolClient, householdId: string) {
  const row = (await client.query<{ posting_count: number; posting_total: string; event_count: number; source_count: number; reconciliation_count: number }>(`
    select (select count(*)::int from core.fact_posting where household_id=$1) posting_count,
      (select coalesce(sum(book_amount_inr),0)::text from core.fact_posting where household_id=$1) posting_total,
      (select count(*)::int from core.transaction_event where household_id=$1) event_count,
      (select count(*)::int from core.source_record where household_id=$1) source_count,
      (select count(*)::int from core.reconciliation_result where household_id=$1) reconciliation_count`, [householdId])).rows[0]!;
  return { postingCount: row.posting_count, postingBookTotalInr: exactText(row.posting_total), eventCount: row.event_count,
    sourceRecordCount: row.source_count, reconciliationCount: row.reconciliation_count };
}

async function ownerSnapshot(client: PoolClient, email: string, password: string) {
  const result = await client.query<{ user_id: string; household_id: string; password_hash: string; installation_id: string; schema_version: number; source_revision: number }>(`
    select u.id user_id,m.household_id,c.password_hash,i.id installation_id,i.schema_version,coalesce(r.revision,0) source_revision
    from core.auth_user u join core.auth_credential c on c.user_id=u.id
    join core.household_membership m on m.user_id=u.id and m.role='owner' and m.state='active'
    join core.system_installation i on i.household_id=m.household_id
    left join ops.source_revision r on r.household_id=m.household_id
    where u.email=$1 and u.state='active'`, [email.trim().toLowerCase()]);
  if (result.rows.length !== 1 || !await verifyPassword(result.rows[0]!.password_hash, password)) throw new Error("Active owner credentials were not accepted.");
  if (result.rows[0]!.schema_version !== FINANCIAL_SCHEMA) throw new Error("Apply the reviewed database migration before exporting.");
  return result.rows[0]!;
}

export async function exportHouseholdBackup(input: { pool: Pool; directory: string; ownerEmail: string; ownerPassword: string; passphrase: string }) {
  const client = await input.pool.connect(); const exportId = randomUUID(); const createdAt = new Date().toISOString();
  let actor: Awaited<ReturnType<typeof ownerSnapshot>> | undefined;
  try {
    await client.query("begin isolation level repeatable read read only");
    actor = await ownerSnapshot(client, input.ownerEmail, input.ownerPassword);
    const writer = await createBackupWriter(input.directory, { exportId, createdAt, passphrase: input.passphrase });
    const parts: BackupPart[] = []; const tables: BackupManifest["tables"] = []; let partNumber = 0;
    for (const table of BACKUP_TABLES) {
      const tableParts: string[] = []; let tableRows = 0; let offset = 0; let pending: string[] = []; let pendingBytes = 0;
      const flush = async () => {
        if (!pending.length) return;
        const plaintext = Buffer.from(`${pending.join("\n")}\n`, "utf8"); const name = `part-${String(++partNumber).padStart(6, "0")}.enc`;
        await writer.part(name, plaintext);
        parts.push({ name, table: table.name, rowCount: pending.length, plaintextBytes: plaintext.length, plaintextSha256: sha256(plaintext) });
        tableParts.push(name); pending = []; pendingBytes = 0;
      };
      while (true) {
        const omitted = table.excluded?.map(column => `-'${column.replaceAll("'", "''")}'`).join("") ?? "";
        const page = await client.query<{ row_json: string }>(`select (to_jsonb(t)${omitted})::text row_json from ${table.from} where ${table.where} order by ${table.order} limit ${BACKUP_PART_ROWS} offset $2`, [actor.household_id, offset]);
        if (!page.rows.length) break;
        for (const { row_json: row } of page.rows) {
          const bytes = Buffer.byteLength(row) + 1;
          if (bytes > BACKUP_PART_BYTES) throw new Error(`A ${table.name} row exceeds the backup part boundary.`);
          if (pending.length >= BACKUP_PART_ROWS || pendingBytes + bytes > BACKUP_PART_BYTES) await flush();
          pending.push(row); pendingBytes += bytes; tableRows += 1;
        }
        offset += page.rows.length;
        if (page.rows.length < BACKUP_PART_ROWS) break;
      }
      await flush(); tables.push({ name: table.name, rowCount: tableRows, parts: tableParts });
    }
    const manifest = backupManifestSchema.parse({ format: "networth-backup-v1", exportId, createdAt, schemaVersion: actor.schema_version,
      installationId: actor.installation_id, householdId: actor.household_id, sourceRevision: actor.source_revision,
      ruleVersions: { bankImport: "bank-v1", bankMovement: "bank-movements-v1", bankBalance: "bank-balance-v1" },
      exclusions: SECURITY_EXCLUSIONS, tables, parts, controls: await controls(client, actor.household_id) });
    const envelope = await writer.finish(manifest); await client.query("commit");
    await client.query("insert into core.security_audit_event(household_id,actor_id,kind,target_id) values($1,$2,'backup_exported',$3)", [actor.household_id, actor.user_id, exportId]);
    return { envelope, manifest };
  } catch (error) { try { await client.query("rollback"); } catch { /* Original failure is more useful. */ } throw error; }
  finally { client.release(); }
}

async function readIdentity(verified: Awaited<ReturnType<typeof verifyBackup>>, email: string) {
  const users: Array<{ id: string; email: string; state: string }> = []; const memberships: Array<{ user_id: string; role: string; state: string }> = [];
  for (const part of verified.manifest.parts.filter(value => ["core.auth_user", "core.household_membership"].includes(value.table))) {
    const rows = (await verified.plaintext(part)).split("\n").filter(Boolean).map(row => JSON.parse(row));
    if (part.table === "core.auth_user") users.push(...rows); else memberships.push(...rows);
  }
  const owner = users.find(user => user.email === email.trim().toLowerCase() && user.state === "active");
  if (!owner || !memberships.some(member => member.user_id === owner.id && member.role === "owner" && member.state === "active")) throw new Error("Choose an active owner email contained in this backup.");
  return { owner, users };
}

async function columns(client: PoolClient, spec: TableSpec) {
  const [schema, table] = spec.name.split(".");
  const result = await client.query<{ column_name: string }>(`select column_name from information_schema.columns where table_schema=$1 and table_name=$2 and is_generated='NEVER' order by ordinal_position`, [schema, table]);
  const excluded = new Set(spec.excluded ?? []); return result.rows.map(row => row.column_name).filter(column => !excluded.has(column));
}

async function insertPart(client: PoolClient, spec: TableSpec, plaintext: string) {
  const names = await columns(client, spec); const list = names.map(quote).join(","); const rows = plaintext.split("\n").filter(Boolean);
  if (!rows.length || rows.length > BACKUP_PART_ROWS) throw new Error("Backup part row count is invalid.");
  await client.query(`insert into ${relation(spec.name)} (${list}) select ${list} from json_populate_recordset(null::${relation(spec.name)},$1::json)`, [`[${rows.join(",")}]`]);
}

async function setUserTriggers(client: PoolClient, enabled: boolean) {
  const tables = [...new Set(["core.auth_user", "core.household", "core.household_membership", "core.system_installation", "core.auth_credential", "core.auth_recovery_code", "core.security_audit_event", "ops.outbox_event", "ops.rebuild_request", "ops.workflow_delivery", ...RESTORE_ORDER])];
  for (const table of tables) await client.query(`alter table ${relation(table)} ${enabled ? "enable" : "disable"} trigger user`);
}

async function validateRestored(client: PoolClient, manifest: BackupManifest) {
  const restored = await controls(client, manifest.householdId);
  if (JSON.stringify(restored) !== JSON.stringify(manifest.controls)) throw new Error("Restored financial control totals do not match the backup manifest.");
  const invalid = await client.query<{ count: number }>(`select count(*)::int count from (
    select e.id from core.transaction_event e left join core.fact_posting p on p.household_id=e.household_id and p.event_id=e.id
    where e.household_id=$1 group by e.id having count(p.id)<2 or coalesce(sum(p.book_amount_inr),0)<>0
  ) broken`, [manifest.householdId]);
  if (invalid.rows[0]!.count) throw new Error("Restored ledger events are not balanced.");
  const revision = await client.query<{ revision: number; maximum: number }>(`select r.revision,coalesce((select max(revision) from core.import_batch where household_id=$1),0)::int maximum from ops.source_revision r where r.household_id=$1`, [manifest.householdId]);
  if (revision.rows[0]?.revision !== manifest.sourceRevision || revision.rows[0]?.maximum !== manifest.sourceRevision) throw new Error("Restored source revision does not match the manifest.");
  for (const table of manifest.tables) {
    const spec = BACKUP_TABLES.find(value => value.name === table.name); if (!spec) throw new Error("Backup includes an unsupported table.");
    const count = await client.query<{ count: number }>(`select count(*)::int count from ${spec.from} where ${spec.where}`, [manifest.householdId]);
    if (count.rows[0]!.count !== table.rowCount) throw new Error(`Restored row count does not match for ${table.name}.`);
  }
}

export async function restoreHouseholdBackup(input: { pool: Pool; directory: string; passphrase: string; ownerEmail: string; ownerPassword: string; authSecret: string }) {
  if (!passwordSchema.safeParse(input.ownerPassword).success || input.authSecret.length < 32) throw new Error("Provide a valid new owner password and configured AUTH_SECRET.");
  const verified = await verifyBackup(input.directory, input.passphrase);
  if (verified.manifest.schemaVersion !== FINANCIAL_SCHEMA) throw new Error("Backup schema version is not supported by this application revision.");
  const expectedTables = new Set(BACKUP_TABLES.map(table => table.name));
  if (verified.manifest.tables.length !== expectedTables.size || verified.manifest.tables.some(table => !expectedTables.delete(table.name as TableSpec["name"]))) throw new Error("Backup authoritative table inventory is incomplete or unsupported.");
  const identity = await readIdentity(verified, input.ownerEmail); const passwordHash = await hashPassword(input.ownerPassword);
  const disabledHash = await hashPassword(randomBytes(48).toString("base64url")); const codes = makeRecoveryCodes();
  const client = await input.pool.connect();
  try {
    await client.query("begin isolation level serializable"); await client.query("select pg_advisory_xact_lock(716284914)");
    const state = await client.query<{ schema_version: number | null; occupied: number }>(`select (select max(schema_version) from core.system_installation) schema_version,
      ((select count(*) from core.system_installation)+(select count(*) from core.household)+(select count(*) from core.auth_user))::int occupied`);
    if (state.rows[0]!.occupied !== 0) throw new Error("Restore requires an empty migrated database.");
    await setUserTriggers(client, false);
    for (const name of RESTORE_ORDER) {
      const spec = BACKUP_TABLES.find(table => table.name === name)!;
      for (const part of verified.manifest.parts.filter(value => value.table === name)) await insertPart(client, spec, await verified.plaintext(part));
    }
    for (const user of identity.users) await client.query("insert into core.auth_credential(user_id,password_hash) values($1,$2)", [user.id, user.id === identity.owner.id ? passwordHash : disabledHash]);
    await client.query(`insert into core.system_installation(singleton,id,household_id,schema_version,setup_completed_at) values(true,$1,$2,$3,now())`, [verified.manifest.installationId, verified.manifest.householdId, FINANCIAL_SCHEMA]);
    for (const code of codes) await client.query("insert into core.auth_recovery_code(code_hash,user_id,expires_at) values($1,$2,now()+interval '365 days')", [protectedDigest("recovery", normalizeCode(code), input.authSecret), identity.owner.id]);
    const latest = await client.query<{ id: string; revision: number }>("select id,revision from core.import_batch where household_id=$1 order by revision desc limit 1", [verified.manifest.householdId]);
    if (latest.rows[0]) {
      const outbox = randomUUID();
      await client.query("insert into ops.outbox_event(id,household_id,batch_id,revision,state) values($1,$2,$3,$4,'pending')", [outbox, verified.manifest.householdId, latest.rows[0].id, latest.rows[0].revision]);
      await client.query(`insert into ops.rebuild_request(id,household_id,batch_id,account_id,earliest_date,revision,cause)
        select gen_random_uuid(),$1,$2,account_id,min(coverage_start),$3,'restore' from core.import_batch where household_id=$1 group by account_id`, [verified.manifest.householdId, latest.rows[0].id, latest.rows[0].revision]);
      await client.query("insert into ops.workflow_delivery(outbox_id,household_id) values($1,$2)", [outbox, verified.manifest.householdId]);
    }
    await client.query("insert into core.security_audit_event(household_id,actor_id,kind,target_id) values($1,$2,'backup_restored',$3)", [verified.manifest.householdId, identity.owner.id, verified.manifest.exportId]);
    await setUserTriggers(client, true); await validateRestored(client, verified.manifest); await client.query("commit");
    return { manifest: verified.manifest, recoveryCodes: codes };
  } catch (error) { try { await client.query("rollback"); } catch { /* Original failure is more useful. */ } throw error; }
  finally { client.release(); }
}

export async function verifyHouseholdBackup(directory: string, passphrase: string) { return (await verifyBackup(directory, passphrase)).manifest; }
