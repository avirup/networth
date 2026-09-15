import { randomBytes, createHash } from "node:crypto";
import type { AuthConfig } from "@auth/core";
import Credentials from "next-auth/providers/credentials";
import { verifyPassword } from "@/lib/auth/passwords";

export interface SpikeSessionStore {
  create(tokenHash: string, userId: string, expires: Date): Promise<void>;
  active(tokenHash: string, userId: string): Promise<boolean>;
  revoke(tokenHash: string): Promise<void>;
}

export function tokenDigest(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// Compatibility experiment ONLY. Not imported by any application route.
// Step 3 must add membership, throttling, setup/invites, audit and rotation rules.
export function spikeAuthConfig(store: SpikeSessionStore, passwordHash: string): AuthConfig {
  return {
    secret: "synthetic-auth-spike-secret-never-use-in-production",
    trustHost: true,
    basePath: "/api/auth",
    session: { strategy: "jwt", maxAge: 3600 },
    logger: { error() {}, warn() {}, debug() {} },
    providers: [Credentials({
      credentials: { email: {}, password: { type: "password" } },
      async authorize(input) {
        // Always perform password verification, even for an unknown identity.
        const matches = await verifyPassword(passwordHash, typeof input.password === "string" ? input.password : "");
        if (!matches || input.email !== "owner@example.test") return null;
        return { id: "fixture-user", email: "owner@example.test", name: "Synthetic owner" };
      },
    })],
    callbacks: {
      async jwt({ token, user }) {
        if (user) {
          const sid = randomBytes(32).toString("hex");
          await store.create(tokenDigest(sid), user.id!, new Date(Date.now() + 3600_000));
          return { sub: user.id, sid };
        }
        if (typeof token.sid !== "string" || !token.sub) return null;
        if (!(await store.active(tokenDigest(token.sid), token.sub))) return null;
        return token;
      },
      session({ session, token }) {
        // Do not expose the registry bearer token to browser JavaScript.
        session.user.id = token.sub!;
        return session;
      },
    },
    events: {
      async signOut(message) {
        if ("token" in message && typeof message.token?.sid === "string") {
          await store.revoke(tokenDigest(message.token.sid));
        }
      },
    },
  };
}
