import "server-only";
import { sql } from "drizzle-orm";
import type { Database } from "./connection";
import { migrationLock } from "./migrate";

// Local CLI only: callers must hold the separate administrative connection.
export async function recoverSoleOwner(db: Database, installationId: string, email: string, passwordHash: string) {
  await db.transaction(async tx => {
    await migrationLock(tx);
    const instance = (await tx.execute<{ id: string; household_id: string }>(sql`select id,household_id from core.system_installation where id::text=${installationId}`)).rows[0];
    if (!instance) throw new Error("Installation does not match.");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`household:${instance.household_id}`},0))`);
    const owners = await tx.execute<{ id: string; email: string }>(sql`select u.id,u.email from core.auth_user u join core.household_membership m on m.user_id=u.id where m.household_id=${instance.household_id} and m.role='owner' and m.state='active' and u.state='active' for update of u`);
    if (owners.rows.length !== 1 || owners.rows[0]?.email !== email) throw new Error("Recovery requires the matching sole active owner.");
    const userId = owners.rows[0].id;
    await tx.execute(sql`update core.auth_credential set password_hash=${passwordHash},changed_at=now() where user_id=${userId}`);
    await tx.execute(sql`update core.auth_session set revoked_at=now(),reauthenticated_at=null where user_id=${userId}`);
    await tx.execute(sql`delete from core.auth_recovery_code where user_id=${userId}`);
    await tx.execute(sql`update core.auth_reset_token set revoked_at=now() where user_id=${userId}`);
    await tx.execute(sql`update core.auth_invitation set revoked_at=now() where created_by=${userId} and consumed_at is null`);
    await tx.execute(sql`insert into core.security_audit_event(household_id,actor_id,kind) values(${instance.household_id},${userId},'local_owner_recovery')`);
  });
}
