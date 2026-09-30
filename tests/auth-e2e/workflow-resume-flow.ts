import { expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export async function workflowResumeFlow(page: Page) {
  const raw = process.env.TEST_DATABASE_URL ?? parseEnv(readFileSync(".env.local", "utf8")).TEST_DATABASE_URL;
  const url = new URL(raw!);
  if (process.env.VERCEL || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/networth_test") throw new Error("Use only the disposable browser test database.");
  const db = new Pool({ connectionString: raw });
  const headers = { origin: "http://127.0.0.1:3102" };
  try {
    // Synthetic paused candidate; production has no way to issue execution capacity yet.
    const runId = (await db.query("insert into ops.calculation_run(household_id,source_revision,rule_version) select household_id,revision,'bank-plan-v1' from ops.source_revision returning id")).rows[0].id;
    await db.query("update ops.calculation_budget set state='paused',reason='window_limit',window_attempts=100,total_attempts=100 where run_id=$1", [runId]);
    const data = { runId };
    expect((await page.request.post("/api/workflows/resume", { data })).status()).toBe(403);
    expect((await page.request.post("/api/workflows/resume", { headers, data: {} })).status()).toBe(400);
    expect((await page.request.post("/api/workflows/resume", { headers, data })).status()).toBe(503);
    expect((await db.query("select state from ops.calculation_budget where run_id=$1", [runId])).rows[0].state).toBe("paused");
    await db.query("insert into ops.execution_capacity values(true,now()+interval '1 hour',100,300000000) on conflict(singleton) do update set verified_until=excluded.verified_until,remaining_attempts=excluded.remaining_attempts,remaining_storage_bytes=excluded.remaining_storage_bytes");
    const response = await page.request.post("/api/workflows/resume", { headers, data });
    expect(response.status()).toBe(503);
    expect((await db.query("select state,window_attempts,total_attempts::text from ops.calculation_budget where run_id=$1", [runId])).rows[0]).toEqual({ state: "paused", window_attempts: 0, total_attempts: "100" });
    const status = await (await page.request.get("/api/imports/status")).json();
    expect(status.history[0]).toMatchObject({ calculationRunId: runId, planningExecutionState: "paused", planningTotalAttempts: "100" });
  } finally { await db.end(); }
}
