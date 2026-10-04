import { afterAll, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { migrateIdentity } from "@/db/auth/migrate";
const pool = new Pool({ connectionString:process.env.TEST_DATABASE_URL });
afterAll(()=>pool.end());
it("upgrades a populated v1 identity database without changing users or sessions",async()=>{
  const client=await pool.connect();
  let userId:string,householdId:string;
  try{
    await client.query("drop schema if exists reporting cascade; drop schema if exists ops cascade");await client.query("drop schema if exists core cascade");
    await client.query("do $$ begin if not exists(select from pg_roles where rolname='networth_test_app') then create role networth_test_app login password 'synthetic-runtime-test-only' noinherit nosuperuser nocreatedb nocreaterole nobypassrls; end if; end $$");
    await client.query("begin");
    await client.query("create schema core");await client.query("create table core.schema_migration(name text primary key,checksum text not null,applied_at timestamptz not null default now())");
    for(const name of ['0000_identity','0001_security']){
      const source=await readFile(`db/migrations/${name}.sql`,'utf8');
      for(const statement of source.split('--> statement-breakpoint'))if(statement.trim())await client.query(statement);
      await client.query("insert into core.schema_migration(name,checksum) values($1,$2)",[name,createHash('sha256').update(source).digest('hex')]);
    }
    userId=(await client.query("insert into core.auth_user(name,email) values('Existing synthetic owner','existing@example.test') returning id")).rows[0].id;
    householdId=(await client.query("insert into core.household(name) values('Existing household') returning id")).rows[0].id;
    await client.query("insert into core.household_membership(household_id,user_id,role) values($1,$2,'owner')",[householdId,userId]);
    await client.query("insert into core.system_installation(household_id,schema_version) values($1,1)",[householdId]);
    await client.query("insert into core.auth_credential(user_id,password_hash) values($1,'synthetic-preservation-marker')",[userId]);
    await client.query("insert into core.auth_session(token_hash,user_id,expires_at) values($1,$2,now()+interval '1 day')",['d'.repeat(64),userId]);
    await client.query("commit");
  }catch(error){await client.query("rollback");throw error;}finally{client.release();}
  await drizzle(pool).transaction(tx=>migrateIdentity(tx,'networth_test_app'));
  await drizzle(pool).transaction(tx=>migrateIdentity(tx,'networth_test_app'));
  expect((await pool.query("select schema_version from core.system_installation")).rows[0].schema_version).toBe(13);
  expect((await pool.query("select password_hash from core.auth_credential where user_id=$1",[userId!])).rows[0].password_hash).toBe('synthetic-preservation-marker');
  expect((await pool.query("select user_id,revoked_at from core.auth_session")).rows).toEqual([{user_id:userId!,revoked_at:null}]);
  expect((await pool.query("select count(*)::int n from core.dim_category where household_id=$1",[householdId!])).rows[0].n).toBe(15);
  expect((await pool.query("select count(*)::int n from core.transaction_event")).rows[0].n).toBe(0);
});
