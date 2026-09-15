import { describe, expect, it, vi } from "vitest";
import { inspectEnvironment, environmentIsValid } from "@/lib/config/environment";
import { canServeWorkflows, canUseDatabase, financialWriteStatus, schemaIsCompatible } from "@/lib/config/policy";
import { logSafeEvent } from "@/lib/config/logging";

const local = {
  NODE_ENV: "development", DATABASE_URL: "postgresql://local:fixture@localhost/networth_local",
  AUTH_SECRET: "synthetic-test-secret-with-32-characters", INNGEST_DEV: "1", APP_URL: "http://localhost:3000",
};
const production = {
  ...local, VERCEL_ENV: "production", NODE_ENV: "production", INNGEST_DEV: "0",
  DATABASE_URL: "postgresql://fixture:fixture@db.example.test/networth?sslmode=verify-full",
  APP_URL: "https://networth.example.test", INNGEST_EVENT_KEY: "fixture", INNGEST_SIGNING_KEY: "fixture",
};

describe("runtime configuration and fail-closed policy", () => {
  it("reports missing variable names without inventing configuration", () => {
    const report = inspectEnvironment({});
    expect(report.missing).toEqual(["DATABASE_URL", "AUTH_SECRET"]);
    expect(environmentIsValid(report)).toBe(false);
  });
  it("allows an intentional local Dev Server without production keys", () => {
    const report = inspectEnvironment(local);
    expect(environmentIsValid(report)).toBe(true);
    expect(canServeWorkflows(report)).toBe(true);
  });
  it("refuses insecure hosted URLs, public secrets and local workflow mode", () => {
    const report = inspectEnvironment({ ...local, VERCEL_ENV: "production", NEXT_PUBLIC_AUTH_SECRET: "do-not-echo" });
    expect(report.invalid).toEqual(expect.arrayContaining(["DATABASE_URL", "APP_URL", "AUTH_SECRET", "INNGEST_DEV"]));
    expect(canServeWorkflows(report)).toBe(false);
  });
  it.each(["preview", "unexpected", "development"])("blocks database and jobs in hosted %s contexts", (context) => {
    const report = inspectEnvironment({ ...production, VERCEL_ENV: context });
    expect(canUseDatabase(report)).toBe(false);
    expect(canServeWorkflows(report)).toBe(false);
    expect(financialWriteStatus(report, { schemaVersion: 1, setupCompleted: true }, true)).toBe("preview_disabled");
  });
  it("fails closed on an incomplete setup, unknown schema or unverified workflow", () => {
    const report = inspectEnvironment(production);
    expect(financialWriteStatus(report, null, true)).toBe("schema_incompatible");
    expect(financialWriteStatus(report, { schemaVersion: 2, setupCompleted: true }, true)).toBe("schema_incompatible");
    expect(financialWriteStatus(report, { schemaVersion: 1, setupCompleted: false }, true)).toBe("setup_incomplete");
    expect(financialWriteStatus(report, { schemaVersion: 1, setupCompleted: true }, false)).toBe("workflow_unavailable");
    expect(financialWriteStatus(report, { schemaVersion: 1, setupCompleted: true }, true)).toBe("ready");
  });
  it.each([null, 0, 2, 1.5, NaN, Infinity])("rejects unsupported schema %s", (version) => {
    expect(schemaIsCompatible(version)).toBe(false);
  });
  it("logs only approved event metadata, including when runtime objects contain extra fields", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const event = { event: "database_unavailable" as const, password: "do-not-echo", error: new Error("do-not-echo") };
    logSafeEvent(event);
    expect(spy).toHaveBeenCalledExactlyOnceWith('{"event":"database_unavailable"}');
    spy.mockRestore();
  });
  it("does not put rejected values in safe diagnostic output", () => {
    const report = inspectEnvironment({ ...local, DATABASE_URL: "bad-sensitive-value", AUTH_SECRET: "short-sensitive" });
    expect(report.invalid).toEqual(["DATABASE_URL", "AUTH_SECRET"]);
    expect(JSON.stringify(report)).not.toContain("sensitive");
  });
});
