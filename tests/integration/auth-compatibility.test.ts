import { randomUUID } from "node:crypto";
import { Auth } from "@auth/core";
import { decode } from "next-auth/jwt";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "@/lib/auth/passwords";
import { spikeAuthConfig, tokenDigest, type SpikeSessionStore } from "../support/auth-spike";

const schemaName = `runtime_test_${randomUUID().replaceAll("-", "")}`;
const sessions = pgSchema(schemaName).table("auth_session", {
  tokenHash: text("token_hash").primaryKey(), userId: text("user_id").notNull(),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2, connectionTimeoutMillis: 3000 });
const db = drizzle(pool);
const store: SpikeSessionStore = {
  async create(tokenHash, userId, expires) { await db.insert(sessions).values({ tokenHash, userId, expires }); },
  async active(tokenHash, userId) {
    const rows = await db.select().from(sessions).where(and(
      eq(sessions.tokenHash, tokenHash), eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expires, sql`now()`),
    ));
    return rows.length === 1;
  },
  async revoke(tokenHash) { await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, tokenHash)); },
};
let config: ReturnType<typeof spikeAuthConfig>;
const password = "synthetic credential fixture";

function cookieHeader(response: Response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}
async function request(path: string, cookies = "", body?: URLSearchParams) {
  return Auth(new Request(`http://localhost:3000/api/auth/${path}`, {
    method: body ? "POST" : "GET",
    headers: { cookie: cookies, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body,
  }), config);
}
async function signIn(email = "owner@example.test", inputPassword = password) {
  const csrfResponse = await request("csrf");
  const { csrfToken } = await csrfResponse.json();
  return request("callback/credentials", cookieHeader(csrfResponse), new URLSearchParams({
    csrfToken, email, password: inputPassword,
  }));
}

beforeAll(async () => {
  await db.execute(sql`create schema ${sql.identifier(schemaName)}`);
  await db.execute(sql`create table ${sessions} (token_hash text primary key, user_id text not null, expires timestamptz not null, revoked_at timestamptz)`);
  config = spikeAuthConfig(store, await hashPassword(password));
});
beforeEach(async () => { await db.delete(sessions); });
afterAll(async () => {
  try { await db.execute(sql`drop schema if exists ${sql.identifier(schemaName)} cascade`); }
  finally { await pool.end(); }
});

describe("real Auth.js credentials protocol with a Postgres session registry", () => {
  it("confirms credentials + built-in database strategy is unsupported", async () => {
    const error = vi.fn();
    const response = await Auth(new Request("http://localhost:3000/api/auth/session"), {
      ...config, session: { strategy: "database" }, logger: { error },
    });
    expect(response.status).toBe(500);
    expect(error.mock.calls[0]?.[0].type).toBe("UnsupportedStrategy");
  });

  it("uses a hashed persistent record and rejects the same cookie immediately after revocation", async () => {
    const response = await signIn();
    expect(response.status).toBe(302);
    const cookies = cookieHeader(response);
    expect(cookies).toContain("authjs.session-token=");
    const raw = cookies.split("; ").find((cookie) => cookie.startsWith("authjs.session-token="))!.split("=")[1]!;
    const payload = await decode({ token: raw, secret: config.secret as string, salt: "authjs.session-token" });
    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(tokenDigest(payload!.sid as string));
    expect(JSON.stringify(rows)).not.toContain(payload!.sid as string);
    expect(JSON.stringify(rows)).not.toContain(raw);

    // Recreate config to prove the session does not rely on an in-memory auth instance.
    config = spikeAuthConfig(store, await hashPassword(password));
    const active = await (await request("session", cookies)).json();
    expect(active.user.id).toBe("fixture-user");
    expect(active.sid).toBeUndefined();
    await store.revoke(rows[0]!.tokenHash);
    expect(await (await request("session", cookies)).json()).toBeNull();
  });

  it("rotates identifiers on new logins and supports revoke-all", async () => {
    const first = cookieHeader(await signIn());
    const second = cookieHeader(await signIn());
    expect(first).not.toBe(second);
    expect(await db.select().from(sessions)).toHaveLength(2);
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.userId, "fixture-user"));
    expect(await (await request("session", first)).json()).toBeNull();
    expect(await (await request("session", second)).json()).toBeNull();
  });

  it("rejects expired or missing registry records even while the cookie is valid", async () => {
    const cookies = cookieHeader(await signIn());
    await db.update(sessions).set({ expires: new Date(0) });
    expect(await (await request("session", cookies)).json()).toBeNull();
    await db.delete(sessions);
    expect(await (await request("session", cookies)).json()).toBeNull();
  });

  it("fails closed when the session registry cannot be read", async () => {
    const cookies = cookieHeader(await signIn());
    config = spikeAuthConfig({ ...store, active: async () => { throw new Error("synthetic database outage"); } }, await hashPassword(password));
    expect(await (await request("session", cookies)).json()).toBeNull();
  });

  it("returns generic failures for wrong passwords and unknown users, without session creation", async () => {
    const wrong = await signIn("owner@example.test", "incorrect password fixture");
    const unknown = await signIn("unknown@example.test", password);
    expect(wrong.headers.get("location")).toBe(unknown.headers.get("location"));
    expect(wrong.headers.get("location")).toContain("CredentialsSignin");
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("rejects a credentials callback without a valid CSRF token", async () => {
    const response = await request("callback/credentials", "", new URLSearchParams({ email: "owner@example.test", password }));
    expect(response.headers.get("location")).toContain("MissingCSRF");
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("revokes on protocol sign-out so a copied cookie cannot be reused", async () => {
    const cookies = cookieHeader(await signIn());
    const csrfResponse = await request("csrf", cookies);
    const { csrfToken } = await csrfResponse.json();
    await request("signout", `${cookies}; ${cookieHeader(csrfResponse)}`, new URLSearchParams({ csrfToken }));
    expect(await (await request("session", cookies)).json()).toBeNull();
  });
});
