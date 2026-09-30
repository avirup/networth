import { describe, expect, it } from "vitest";
import {
  CAPACITY_PRESETS,
  capacityPreset,
  connectionForRole,
  deploymentEnvironment,
  hostedDatabaseUrl,
  productionOrigin,
} from "@/lib/deployment/config";

const admin = "postgresql://owner:admin-secret@db.example.test/networth?sslmode=verify-full&channel_binding=require";

describe("guided deployment configuration", () => {
  it("accepts only an exact HTTPS production origin", () => {
    expect(productionOrigin(" https://money.example.test ")).toBe("https://money.example.test");
    for (const value of ["http://money.example.test", "https://money.example.test/setup", "https://money.example.test?x=1", "https://user@money.example.test"]) {
      expect(() => productionOrigin(value)).toThrow("exact HTTPS app origin");
    }
  });

  it("enforces verified TLS and builds separate role connections", () => {
    expect(hostedDatabaseUrl(admin)).toContain("sslmode=verify-full");
    expect(hostedDatabaseUrl(admin.replace("verify-full", "require"))).toContain("sslmode=verify-full");
    const runtime = new URL(connectionForRole(admin, "networth_app", "runtime-secret"));
    expect(runtime.username).toBe("networth_app");
    expect(runtime.password).toBe("runtime-secret");
    expect(runtime.searchParams.get("channel_binding")).toBe("require");
  });

  it("renders a private environment file without merging database identities", () => {
    const source = deploymentEnvironment({
      databaseAdminUrl: admin,
      runtimePassword: "runtime-secret",
      workerPassword: "worker-secret",
      authSecret: "auth-secret-with-at-least-32-characters",
      bootstrapSecret: "bootstrap-secret-with-at-least-32-characters",
      cronSecret: "cron-secret-with-at-least-32-characters",
      appUrl: "https://money.example.test",
    });
    expect(source).toContain('DATABASE_URL="postgresql://networth_app:runtime-secret@');
    expect(source).toContain('DATABASE_WORKER_URL="postgresql://networth_jobs:worker-secret@');
    expect(source).toContain('DATABASE_ADMIN_URL="postgresql://owner:admin-secret@');
    expect(source).toContain('APP_URL="https://money.example.test"');
    expect(source).not.toContain("NEXT_PUBLIC_");
  });

  it("provides conservative named capacity presets", () => {
    expect(capacityPreset("personal")).toMatchObject({ name: "personal", imports: 10, minutes: 1_440 });
    expect(capacityPreset("regular").storageBytes).toBeLessThanOrEqual(200_000_000);
    expect(CAPACITY_PRESETS.personal.attempts).toBeLessThan(CAPACITY_PRESETS.regular.attempts);
    expect(() => capacityPreset("unlimited")).toThrow("personal or regular");
  });
});
