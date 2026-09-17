import { sql } from "drizzle-orm";
import { pgSchema, uuid, text, timestamp, integer, boolean, bigserial, unique, check, foreignKey, index } from "drizzle-orm/pg-core";

export const core = pgSchema("core");
export const memberRole = core.enum("member_role", ["owner", "editor", "viewer"]);
export const accessState = core.enum("access_state", ["active", "disabled"]);
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export const users = core.table("auth_user", {
  id: uuid().defaultRandom().primaryKey(), email: text().notNull().unique(), name: text().notNull(),
  state: accessState().notNull().default("active"), createdAt: instant("created_at").notNull().defaultNow(),
}, t => [check("normalized_email", sql`${t.email} = lower(btrim(${t.email})) and length(${t.email}) between 3 and 254`), check("bounded_name", sql`length(${t.name}) between 1 and 100`)]);
export const credentials = core.table("auth_credential", {
  userId: uuid("user_id").primaryKey().references(() => users.id), passwordHash: text("password_hash").notNull(), changedAt: instant("changed_at").notNull().defaultNow(),
});
export const households = core.table("household", {
  id: uuid().defaultRandom().primaryKey(), name: text().notNull(), currency: text().notNull().default("INR"), timezone: text().notNull().default("Asia/Kolkata"),
  createdAt: instant("created_at").notNull().defaultNow(),
}, t => [check("household_name_length", sql`length(${t.name}) between 1 and 100`)]);
export const memberships = core.table("household_membership", {
  id: uuid().defaultRandom().primaryKey(), householdId: uuid("household_id").notNull().references(() => households.id), userId: uuid("user_id").notNull().references(() => users.id),
  role: memberRole().notNull(), state: accessState().notNull().default("active"), createdAt: instant("created_at").notNull().defaultNow(),
}, t => [unique("membership_household_user").on(t.householdId, t.userId), index("membership_user").on(t.userId)]);
export const installation = core.table("system_installation", {
  singleton: boolean().primaryKey().default(true), id: uuid().defaultRandom().notNull().unique(), householdId: uuid("household_id").notNull().references(() => households.id),
  schemaVersion: integer("schema_version").notNull(), setupCompletedAt: instant("setup_completed_at").notNull().defaultNow(),
}, t => [check("installation_singleton", sql`${t.singleton} = true`), check("positive_schema_version", sql`${t.schemaVersion} > 0`)]);
export const sessions = core.table("auth_session", {
  tokenHash: text("token_hash").primaryKey(), userId: uuid("user_id").notNull().references(() => users.id), expiresAt: instant("expires_at").notNull(),
  revokedAt: instant("revoked_at"), reauthenticatedAt: instant("reauthenticated_at"), createdAt: instant("created_at").notNull().defaultNow(),
}, t => [index("session_user").on(t.userId), check("session_hash_length", sql`length(${t.tokenHash}) = 64`)]);
export const invitations = core.table("auth_invitation", {
  id: uuid().defaultRandom().primaryKey(), householdId: uuid("household_id").notNull(), email: text().notNull(), role: memberRole().notNull(),
  tokenHash: text("token_hash").notNull().unique(), createdBy: uuid("created_by").notNull(), expiresAt: instant("expires_at").notNull(),
  consumedAt: instant("consumed_at"), revokedAt: instant("revoked_at"), createdAt: instant("created_at").notNull().defaultNow(),
}, t => [foreignKey({ columns: [t.householdId, t.createdBy], foreignColumns: [memberships.householdId, memberships.userId] }),
  check("invitation_non_owner", sql`${t.role} in ('editor', 'viewer')`), check("invitation_email", sql`${t.email} = lower(btrim(${t.email})) and length(${t.email}) <= 254`), index("invitation_household").on(t.householdId)]);
export const recoveryCodes = core.table("auth_recovery_code", {
  codeHash: text("code_hash").primaryKey(), userId: uuid("user_id").notNull().references(() => users.id), expiresAt: instant("expires_at").notNull(),
  usedAt: instant("used_at"), createdAt: instant("created_at").notNull().defaultNow(),
}, t => [index("recovery_user").on(t.userId)]);
export const resetTokens = core.table("auth_reset_token", {
  id: uuid().defaultRandom().primaryKey(), householdId: uuid("household_id").notNull(), userId: uuid("user_id").notNull(), createdBy: uuid("created_by").notNull(),
  tokenHash: text("token_hash").notNull().unique(), expiresAt: instant("expires_at").notNull(), usedAt: instant("used_at"), revokedAt: instant("revoked_at"), createdAt: instant("created_at").notNull().defaultNow(),
}, t => [foreignKey({ columns: [t.householdId, t.userId], foreignColumns: [memberships.householdId, memberships.userId] }),
  foreignKey({ columns: [t.householdId, t.createdBy], foreignColumns: [memberships.householdId, memberships.userId] }), index("reset_user").on(t.userId)]);
export const attempts = core.table("auth_attempt", {
  bucketKey: text("bucket_key").primaryKey(), count: integer().notNull(), expiresAt: instant("expires_at").notNull(),
}, t => [check("positive_attempts", sql`${t.count} > 0`), index("attempt_expiry").on(t.expiresAt)]);
export const auditEvents = core.table("security_audit_event", {
  id: bigserial({ mode: "bigint" }).primaryKey(), householdId: uuid("household_id").notNull(), actorId: uuid("actor_id").notNull(),
  kind: text().notNull(), targetId: uuid("target_id"), result: text().notNull().default("success"), createdAt: instant("created_at").notNull().defaultNow(),
}, t => [foreignKey({ columns: [t.householdId, t.actorId], foreignColumns: [memberships.householdId, memberships.userId] }), index("audit_household_time").on(t.householdId, t.createdAt)]);
