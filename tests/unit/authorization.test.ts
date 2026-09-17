import { describe, expect, it } from "vitest";
import { hasPermission, setupSchema } from "@/lib/auth/validation";
import { inspectEnvironment } from "@/lib/config/environment";
import { secretMatches, sessionDigest, protectedDigest } from "@/lib/auth/crypto";
describe("identity boundaries", () => {
  it("grants only explicit role capabilities", () => {
    for (const role of ["owner", "editor", "viewer"] as const) expect(hasPermission(role, "read")).toBe(true);
    expect(hasPermission("editor", "import")).toBe(true);
    expect(hasPermission("editor", "export")).toBe(false);
    expect(hasPermission("editor", "admin")).toBe(false);
    expect(hasPermission("viewer", "classify")).toBe(false);
    expect(hasPermission("owner", "admin")).toBe(true);
  });
  it("normalizes identity and rejects extra setup fields", () => {
    const input = { setupCode: "x".repeat(32), email: " OWNER@example.test ", name: "Owner", password: "long test password" };
    expect(setupSchema.parse(input).email).toBe("owner@example.test");
    expect(setupSchema.safeParse({ ...input, role: "owner" }).success).toBe(false);
  });
  it("separates credential hash purposes and timing-safe secret checks", () => {
    expect(secretMatches("same", "same")).toBe(true); expect(secretMatches("short", "different")).toBe(false);
    expect(sessionDigest("token")).toHaveLength(64);
    expect(protectedDigest("invite", "token", "secret")).not.toBe(protectedDigest("reset", "token", "secret"));
  });
  it("permits local production builds only for explicit loopback configuration", () => {
    const env = { NODE_ENV: "production", LOCAL_RUNTIME: "1", APP_URL: "http://127.0.0.1:3102", DATABASE_URL: "postgresql://fixture@127.0.0.1/networth_test" };
    expect(inspectEnvironment(env).deployment).toBe("local");
    expect(inspectEnvironment({ ...env, VERCEL: "1" }).deployment).toBe("preview");
    expect(inspectEnvironment({ ...env, DATABASE_URL: "postgresql://fixture@remote.example.test/db" }).deployment).toBe("production");
  });
});
