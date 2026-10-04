import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { authDatabase, serviceTransaction, type Database, type Transaction } from "./connection";
import { migrateIdentity, migrationLock } from "./migrate";
import { users, credentials, households, memberships, installation, sessions, recoveryCodes, invitations, resetTokens, auditEvents } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/auth/passwords";
import { newToken, sessionDigest, protectedDigest, secretMatches, makeRecoveryCodes, normalizeCode } from "@/lib/auth/crypto";
import { AccessError, invalidCredentials } from "@/lib/auth/errors";
import { setupSchema, emailSchema, passwordSchema, invitationSchema, acceptSchema, recoverSchema, hasPermission, type Role, type Permission } from "@/lib/auth/validation";
import { FINANCIAL_SCHEMA, schemaIsCompatible } from "@/lib/config/policy";
import { operationsStatusSchema } from "@/lib/operations/status";

export type Actor = { userId: string; householdId: string; role: Role; name: string; email: string; reauthenticated: boolean; schemaVersion: number };
type Options = { db?: Database; admin?: Database; secret: string; bootstrapSecret?: string; runtimeRole: string };
// Fixed valid Argon2id hash: unknown identities perform the same password KDF.
const DUMMY_HASH = "$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$W+jEHUCRnKvYv26jf7FbHcIo1lHuF87ONtceJKLlAgk";
const DAY = 86400_000;

async function audit(tx: Transaction, actor: Pick<Actor, "householdId" | "userId">, kind: string, targetId?: string) {
  await tx.insert(auditEvents).values({ householdId: actor.householdId, actorId: actor.userId, kind, targetId });
}
async function compatible(tx: Transaction, allowMismatch = false) {
  const [row] = await tx.select().from(installation);
  if (!row || (!allowMismatch && !schemaIsCompatible(row.schemaVersion))) throw new AccessError(503, "The installation needs an administrator upgrade.");
  return row;
}
async function householdLock(tx: Transaction, id: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`household:${id}`}, 0))`); }
async function userLock(tx: Transaction, id: string) { await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).for("update"); }
async function revokeAll(tx: Transaction, userId: string) { await tx.update(sessions).set({ revokedAt: new Date(), reauthenticatedAt: null }).where(eq(sessions.userId, userId)); }
async function actorFor(tx: Transaction, reference: string, permission: Permission = "read", recent = false, householdId?: string, allowMismatch = false): Promise<Actor> {
  const instance = await compatible(tx, allowMismatch);
  const rows = await tx.execute<Actor>(sql`
    select u.id as "userId", m.household_id as "householdId", m.role, u.name, u.email,
      (s.reauthenticated_at > now() - interval '5 minutes') is true as reauthenticated,
      ${instance.schemaVersion}::integer as "schemaVersion"
    from core.auth_session s join core.auth_user u on u.id=s.user_id join core.household_membership m on m.user_id=u.id
    where s.token_hash=${sessionDigest(reference)} and s.expires_at>now() and s.revoked_at is null
      and u.state='active' and m.state='active' and m.household_id=${householdId ?? instance.householdId} limit 1
  `);
  const actor = rows.rows[0];
  if (!actor) throw new AccessError(401, "Please sign in again.");
  if (!hasPermission(actor.role, permission)) throw new AccessError(403, "You do not have permission for this action.");
  if (recent && !actor.reauthenticated) throw new AccessError(403, "Confirm your password before continuing.");
  return actor;
}
async function throttle(tx: Transaction, keys: { key: string; limit: number }[]) {
  // Bounded, transaction-safe buckets; no addresses or emails retained here.
  await tx.execute(sql`select pg_advisory_xact_lock(716284914)`);
  await tx.execute(sql`delete from core.auth_attempt where bucket_key in (select bucket_key from core.auth_attempt where expires_at<=now() limit 128)`);
  for (const { key, limit } of keys) {
    const result = await tx.execute<{ count: number }>(sql`
      insert into core.auth_attempt(bucket_key,count,expires_at)
      select ${key},1,now()+interval '15 minutes'
      where (select count(*) from core.auth_attempt)<4096 or exists(select 1 from core.auth_attempt where bucket_key=${key})
      on conflict(bucket_key) do update set count=least(core.auth_attempt.count+1,100000)
      returning count
    `);
    if (!result.rows[0] || result.rows[0].count > limit) return false;
  }
  return true;
}

export function createIdentityService(options: Options) {
  const db = () => options.db ?? authDatabase();
  const run = <T>(work: (tx: Transaction) => Promise<T>) => serviceTransaction(work, db());
  const digest = (purpose: string, value: string) => protectedDigest(purpose, value, options.secret);
  async function limit(purpose: string, account: string, source: string) {
    const allowed = await run(tx => throttle(tx, [
      { key: digest("limit", `${purpose}:global`), limit: 100 },
      { key: digest("limit", `${purpose}:source:${source}`), limit: 30 },
      { key: digest("limit", `${purpose}:account:${account}`), limit: 10 },
    ]));
    if (!allowed) throw new AccessError(429, "Too many attempts. Try again in 15 minutes.");
  }
  async function storeCodes(tx: Transaction, userId: string) {
    const codes = makeRecoveryCodes();
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    await tx.insert(recoveryCodes).values(codes.map(code => ({ userId, codeHash: digest("recovery", normalizeCode(code)), expiresAt: new Date(Date.now() + 365 * DAY) })));
    return codes;
  }
  async function sensitive<T>(reference: string, permission: Permission, work: (tx: Transaction, actor: Actor) => Promise<T>) {
    return run(async tx => {
      const first = await actorFor(tx, reference, permission, true);
      await householdLock(tx, first.householdId);
      const actor = await actorFor(tx, reference, permission, true);
      return work(tx, actor);
    });
  }
  return {
    async installationState() {
      const exists = await db().execute<{ present: boolean }>(sql`select to_regclass('core.system_installation') is not null as present`);
      if (!exists.rows[0]?.present) return null;
      return run(async tx => (await tx.select().from(installation))[0] ?? null);
    },
    async setup(input: unknown) {
      // No database reads, writes, migrations, password KDF or state disclosure before authorization.
      const supplied = input && typeof input === "object" && "setupCode" in input && typeof input.setupCode === "string" ? input.setupCode : "";
      if (!options.bootstrapSecret || options.bootstrapSecret.length < 32 || !secretMatches(supplied, options.bootstrapSecret)) throw invalidCredentials();
      const parsed = setupSchema.safeParse(input);
      if (!parsed.success) throw new AccessError(400, "Check your name, email and password (12–1024 characters).");
      const passwordHash = await hashPassword(parsed.data.password);
      const admin = options.admin ?? authDatabase(true);
      return admin.transaction(async tx => {
        await migrationLock(tx);
        await migrateIdentity(tx, options.runtimeRole);
        if ((await tx.select().from(installation)).length) throw new AccessError(409, "Setup is already complete. Sign in instead.");
        if (!await throttle(tx, [{ key: digest("limit", "authorized-setup"), limit: 3 }])) throw new AccessError(429, "Try setup again later.");
        const [user] = await tx.insert(users).values({ name: parsed.data.name, email: parsed.data.email }).returning();
        const [household] = await tx.insert(households).values({ name: parsed.data.householdName }).returning();
        await tx.insert(credentials).values({ userId: user!.id, passwordHash });
        await tx.insert(memberships).values({ userId: user!.id, householdId: household!.id, role: "owner" });
        const codes = await storeCodes(tx, user!.id);
        await tx.insert(installation).values({ householdId: household!.id, schemaVersion: FINANCIAL_SCHEMA });
        await audit(tx, { userId: user!.id, householdId: household!.id }, "setup_completed");
        return { recoveryCodes: codes };
      });
    },
    async login(email: unknown, password: unknown, source: string) {
      const parsed = emailSchema.safeParse(email);
      const inputPassword = typeof password === "string" && password.length <= 1024 ? password : "invalid password input";
      await limit("login", parsed.success ? parsed.data : "invalid", source);
      return run(async tx => {
        await compatible(tx, true);
        const [user] = parsed.success ? await tx.select().from(users).where(eq(users.email, parsed.data)).for("update") : [];
        const [credential] = user ? await tx.select().from(credentials).where(eq(credentials.userId, user.id)) : [];
        const matched = await verifyPassword(credential?.passwordHash ?? DUMMY_HASH, inputPassword.length >= 12 ? inputPassword : "invalid password input");
        const [member] = user ? await tx.select().from(memberships).where(and(eq(memberships.userId, user.id), eq(memberships.state, "active"))).limit(1) : [];
        if (!matched || !user || user.state !== "active" || !member || !passwordSchema.safeParse(password).success) return null;
        await tx.execute(sql`delete from core.auth_session where user_id=${user.id} and (revoked_at is not null or expires_at<=now())`);
        await tx.execute(sql`delete from core.auth_session where token_hash in (select token_hash from core.auth_session where user_id=${user.id} order by created_at desc offset 9)`);
        const reference = newToken();
        await tx.insert(sessions).values({ userId: user.id, tokenHash: sessionDigest(reference), expiresAt: new Date(Date.now() + DAY) });
        await audit(tx, { userId: user.id, householdId: member.householdId }, "signed_in");
        return { id: user.id, name: user.name, email: user.email, reference };
      });
    },
    async resolve(reference: string, permission: Permission = "read", householdId?: string) {
      return run(tx => actorFor(tx, reference, permission, false, householdId));
    },
    async resolveSession(reference: string) {
      return run(tx => actorFor(tx, reference, "read", false, undefined, true));
    },
    async resolveStatus(reference: string) {
      return run(tx => actorFor(tx, reference, "admin", false, undefined, true));
    },
    async operationsStatus(reference: string) {
      return run(async tx => {
        const actor = await actorFor(tx, reference, "admin");
        await tx.execute(sql`select set_config('app.user_id',${actor.userId},true),set_config('app.household_id',${actor.householdId},true),set_config('app.session_hash',${sessionDigest(reference)},true)`);
        await tx.execute(sql`set local role networth_member`);
        const result = await tx.execute<{ value: Record<string, unknown> }>(sql`select ops.installation_status(${actor.householdId}) value`);
        return operationsStatusSchema.parse(result.rows[0]!.value);
      });
    },
    async scoped<T>(reference: string, householdId: string, permission: Permission, work: (tx: Transaction, actor: Actor) => Promise<T>) {
      return run(async tx => {
        const actor = await actorFor(tx, reference, permission, false, householdId);
        await tx.execute(sql`select set_config('app.user_id',${actor.userId},true), set_config('app.household_id',${actor.householdId},true), set_config('app.session_hash',${sessionDigest(reference)},true)`);
        await tx.execute(sql`set local role networth_member`);
        return work(tx, actor);
      });
    },
    async signout(reference: string) {
      await run(async tx => {
        await tx.update(sessions).set({ revokedAt: new Date(), reauthenticatedAt: null }).where(eq(sessions.tokenHash, sessionDigest(reference)));
      });
    },
    async confirmPassword(reference: string, password: string, source: string) {
      const actor = await this.resolve(reference);
      await limit("confirm", actor.userId, source);
      await run(async tx => {
        await userLock(tx, actor.userId);
        await actorFor(tx, reference);
        const [credential] = await tx.select().from(credentials).where(eq(credentials.userId, actor.userId));
        if (!await verifyPassword(credential?.passwordHash ?? DUMMY_HASH, password)) throw invalidCredentials();
        await tx.update(sessions).set({ reauthenticatedAt: new Date() }).where(and(eq(sessions.tokenHash, sessionDigest(reference)), isNull(sessions.revokedAt)));
      });
    },
    async changePassword(reference: string, password: string) {
      if (!passwordSchema.safeParse(password).success) throw invalidCredentials();
      return sensitive(reference, "read", async (tx, actor) => {
        await userLock(tx, actor.userId);
        await tx.update(credentials).set({ passwordHash: await hashPassword(password), changedAt: new Date() }).where(eq(credentials.userId, actor.userId));
        await revokeAll(tx, actor.userId);
        await tx.update(resetTokens).set({ revokedAt: new Date() }).where(eq(resetTokens.userId, actor.userId));
        await audit(tx, actor, "password_changed");
      });
    },
    async regenerateCodes(reference: string) {
      return sensitive(reference, "read", async (tx, actor) => {
        await userLock(tx, actor.userId);
        const codes = await storeCodes(tx, actor.userId);
        await revokeAll(tx, actor.userId);
        await audit(tx, actor, "recovery_codes_regenerated");
        return codes;
      });
    },
    async revokeSessions(reference: string) {
      return sensitive(reference, "read", async (tx, actor) => { await userLock(tx, actor.userId); await revokeAll(tx, actor.userId); await audit(tx, actor, "sessions_revoked"); });
    },
    async members(reference: string) {
      return run(async tx => {
        const actor = await actorFor(tx, reference, "admin");
        const members = await tx.select({ userId: users.id, name: users.name, email: users.email, role: memberships.role, state: memberships.state }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.householdId, actor.householdId)).limit(100);
        const pending = await tx.select({ id: invitations.id, email: invitations.email, role: invitations.role, expiresAt: invitations.expiresAt }).from(invitations).where(and(eq(invitations.householdId, actor.householdId), isNull(invitations.revokedAt), isNull(invitations.consumedAt), sql`${invitations.expiresAt}>now()`)).limit(100);
        return { members, invitations: pending };
      });
    },
    async changeMember(reference: string, userId: string, role: Role, state: "active" | "disabled") {
      return sensitive(reference, "admin", async (tx, actor) => {
        await userLock(tx, userId);
        const [target] = await tx.select().from(memberships).where(and(eq(memberships.householdId, actor.householdId), eq(memberships.userId, userId)));
        if (!target) throw new AccessError(404, "Member not found.");
        await tx.update(memberships).set({ role, state }).where(eq(memberships.id, target.id));
        await revokeAll(tx, userId);
        await tx.update(invitations).set({ revokedAt: new Date() }).where(and(eq(invitations.createdBy, userId), isNull(invitations.consumedAt)));
        await tx.update(resetTokens).set({ revokedAt: new Date() }).where(eq(resetTokens.userId, userId));
        await audit(tx, actor, state === "disabled" ? "member_removed" : "member_role_changed", userId);
      });
    },
    async invite(reference: string, input: unknown) {
      const parsed = invitationSchema.safeParse(input);
      if (!parsed.success) throw new AccessError(400, "Enter a valid email and role.");
      return sensitive(reference, "admin", async (tx, actor) => {
        const [pendingCount] = (await tx.execute<{ count: number }>(sql`select count(*)::int as count from core.auth_invitation where household_id=${actor.householdId} and consumed_at is null and revoked_at is null and expires_at>now()`)).rows;
        if ((pendingCount?.count ?? 50) >= 50) throw new AccessError(429, "Revoke an outstanding invitation before creating another.");
        await tx.update(invitations).set({ revokedAt: new Date() }).where(and(eq(invitations.householdId, actor.householdId), eq(invitations.email, parsed.data.email), isNull(invitations.consumedAt)));
        const token = newToken();
        const [invitation] = await tx.insert(invitations).values({ householdId: actor.householdId, email: parsed.data.email, role: parsed.data.role, tokenHash: digest("invitation", token), createdBy: actor.userId, expiresAt: new Date(Date.now() + DAY) }).returning({ id: invitations.id });
        await audit(tx, actor, "invitation_created", invitation!.id);
        return token;
      });
    },
    async revokeInvitation(reference: string, invitationId: string) {
      return sensitive(reference, "admin", async (tx, actor) => {
        const rows = await tx.update(invitations).set({ revokedAt: new Date() }).where(and(eq(invitations.id, invitationId), eq(invitations.householdId, actor.householdId), isNull(invitations.consumedAt))).returning({ id: invitations.id });
        if (!rows.length) throw new AccessError(404, "Invitation not found.");
        await audit(tx, actor, "invitation_revoked", invitationId);
      });
    },
    async acceptInvitation(input: unknown, source: string) {
      const parsed = acceptSchema.safeParse(input);
      if (!parsed.success) throw invalidCredentials();
      const data = parsed.data;
      await limit("invitation", data.email, source);
      return run(async tx => {
        await compatible(tx);
        const [candidate] = await tx.select().from(invitations).where(eq(invitations.tokenHash, digest("invitation", data.token)));
        // Always hash once, including nonexistent/used invitations. Existing identities
        // must prove their existing password, never have it overwritten by an invite.
        const hash = await hashPassword(data.password);
        if (!candidate) throw invalidCredentials();
        await householdLock(tx, candidate.householdId);
        const [invitation] = await tx.select().from(invitations).where(eq(invitations.id, candidate.id)).for("update");
        if (!invitation || invitation.email !== data.email || invitation.revokedAt || invitation.consumedAt || invitation.expiresAt <= new Date()) throw invalidCredentials();
        const [creator] = await tx.select().from(memberships).where(and(eq(memberships.userId, invitation.createdBy), eq(memberships.householdId, invitation.householdId), eq(memberships.role, "owner"), eq(memberships.state, "active")));
        if (!creator) throw invalidCredentials();
        let [user] = await tx.select().from(users).where(eq(users.email, data.email)).for("update");
        if (user) {
          const [credential] = await tx.select().from(credentials).where(eq(credentials.userId, user.id));
          if (user.state !== "active" || !await verifyPassword(credential?.passwordHash ?? DUMMY_HASH, data.password)) throw invalidCredentials();
        } else {
          [user] = await tx.insert(users).values({ email: data.email, name: data.name }).returning();
          await tx.insert(credentials).values({ userId: user!.id, passwordHash: hash });
        }
        const [existing] = await tx.select().from(memberships).where(and(eq(memberships.householdId, invitation.householdId), eq(memberships.userId, user!.id)));
        if (existing?.state === "active") throw invalidCredentials();
        if (existing) await tx.update(memberships).set({ state: "active", role: invitation.role }).where(eq(memberships.id, existing.id));
        else await tx.insert(memberships).values({ householdId: invitation.householdId, userId: user!.id, role: invitation.role });
        await tx.update(invitations).set({ consumedAt: new Date() }).where(eq(invitations.id, invitation.id));
        await revokeAll(tx, user!.id);
        const codes = await storeCodes(tx, user!.id);
        await audit(tx, { userId: user!.id, householdId: invitation.householdId }, "invitation_accepted", invitation.id);
        return codes;
      });
    },
    async issueReset(reference: string, userId: string) {
      return sensitive(reference, "admin", async (tx, actor) => {
        await userLock(tx, userId);
        const [target] = await tx.select().from(memberships).where(and(eq(memberships.householdId, actor.householdId), eq(memberships.userId, userId), eq(memberships.state, "active")));
        if (!target || target.role === "owner") throw new AccessError(403, "Owners use their recovery codes or the local recovery command.");
        await tx.update(resetTokens).set({ revokedAt: new Date() }).where(eq(resetTokens.userId, userId));
        const token = newToken();
        await tx.insert(resetTokens).values({ userId, householdId: actor.householdId, createdBy: actor.userId, tokenHash: digest("reset", token), expiresAt: new Date(Date.now() + 30 * 60000) });
        await audit(tx, actor, "member_reset_created", userId);
        return token;
      });
    },
    async recover(input: unknown, source: string) {
      const parsed = recoverSchema.safeParse(input);
      if (!parsed.success) throw invalidCredentials();
      const data = parsed.data;
      await limit("recovery", data.email, source);
      const passwordHash = await hashPassword(data.password);
      return run(async tx => {
        const instance = await compatible(tx);
        const [candidate] = await tx.select().from(users).where(eq(users.email, data.email));
        if (!candidate || candidate.state !== "active") throw invalidCredentials();
        const [reset] = data.method === "reset" ? await tx.select().from(resetTokens).where(and(eq(resetTokens.userId, candidate.id), eq(resetTokens.tokenHash, digest("reset", data.code)))) : [];
        const householdId = data.method === "reset" ? reset?.householdId : instance.householdId;
        if (!householdId) throw invalidCredentials();
        await householdLock(tx, householdId);
        await userLock(tx, candidate.id);
        const [activeUser] = await tx.select().from(users).where(and(eq(users.id, candidate.id), eq(users.state, "active")));
        const [member] = await tx.select().from(memberships).where(and(eq(memberships.userId, candidate.id), eq(memberships.householdId, householdId), eq(memberships.state, "active")));
        if (!activeUser || !member) throw invalidCredentials();
        if (data.method === "code") {
          const consumed = await tx.update(recoveryCodes).set({ usedAt: new Date() }).where(and(eq(recoveryCodes.userId, candidate.id), eq(recoveryCodes.codeHash, digest("recovery", normalizeCode(data.code))), isNull(recoveryCodes.usedAt), sql`${recoveryCodes.expiresAt}>now()`)).returning();
          if (!consumed.length) throw invalidCredentials();
        } else {
          const [token] = await tx.select().from(resetTokens).where(and(eq(resetTokens.userId, candidate.id), eq(resetTokens.tokenHash, digest("reset", data.code)), isNull(resetTokens.usedAt), isNull(resetTokens.revokedAt), sql`${resetTokens.expiresAt}>now()`)).for("update");
          if (!token) throw invalidCredentials();
          const [target] = await tx.select().from(memberships).where(and(eq(memberships.householdId, token.householdId), eq(memberships.userId, candidate.id), eq(memberships.state, "active")));
          const [creator] = await tx.select().from(memberships).where(and(eq(memberships.householdId, token.householdId), eq(memberships.userId, token.createdBy), eq(memberships.state, "active"), eq(memberships.role, "owner")));
          if (!target || target.role === "owner" || !creator) throw invalidCredentials();
          await tx.update(resetTokens).set({ usedAt: new Date() }).where(eq(resetTokens.id, token.id));
        }
        await tx.update(credentials).set({ passwordHash, changedAt: new Date() }).where(eq(credentials.userId, candidate.id));
        await revokeAll(tx, candidate.id);
        await tx.update(resetTokens).set({ revokedAt: new Date() }).where(eq(resetTokens.userId, candidate.id));
        await audit(tx, { userId: candidate.id, householdId: member.householdId }, "password_recovered");
      });
    },
  };
}
export type IdentityService = ReturnType<typeof createIdentityService>;
