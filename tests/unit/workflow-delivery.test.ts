import { expect, it, vi, afterEach } from "vitest";
import { workEvent, workIntentSchema } from "@/lib/workflows/events";
import { validCronAuthorization } from "@/lib/workflows/cron";
import { sendWorkIntent } from "@/lib/workflows/send";
const intent = { outboxId: "00000000-0000-4000-8000-000000000001", householdId: "00000000-0000-4000-8000-000000000002", batchId: "00000000-0000-4000-8000-000000000003", revision: 1 };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("uses stable provider deduplication IDs and never includes financial payloads", () => {
  expect(workEvent(intent)).toEqual(workEvent({ ...intent }));
  expect(workIntentSchema.safeParse({ ...intent, amount: "100" }).success).toBe(false);
  expect(Object.keys(workEvent(intent).data).sort()).toEqual(["batchId", "householdId", "outboxId", "revision"]);
});
it("requires an exact nonempty cron bearer credential", () => {
  const secret = "synthetic-cron-secret-for-tests-only";
  expect(validCronAuthorization(null, undefined)).toBe(false);
  expect(validCronAuthorization(`Bearer ${secret}`, secret)).toBe(true);
  expect(validCronAuthorization(`Bearer ${secret}x`, secret)).toBe(false);
  expect(validCronAuthorization(`bearer ${secret}`, secret)).toBe(false);
});
it("sends once, times out and returns a redacted failure without SDK retries", async () => {
  vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("VERCEL_ENV", ""); vi.stubEnv("VERCEL", "");
  vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@127.0.0.1/networth_test");
  vi.stubEnv("AUTH_SECRET", "synthetic-auth-secret-for-tests-only"); vi.stubEnv("APP_URL", "http://127.0.0.1:3000"); vi.stubEnv("INNGEST_DEV", "1");
  const fetch = vi.fn().mockRejectedValue(new Error("private-provider-secret")); vi.stubGlobal("fetch", fetch);
  await expect(sendWorkIntent(intent)).rejects.toThrow("Workflow event delivery failed.");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe("http://127.0.0.1:8288/e/local");
  expect(fetch.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
});
