import { expect, test } from "@playwright/test";

for (const [mode, port] of [["missing configuration", 3100], ["preview deployment", 3101]] as const) {
  test.describe(mode, () => {
    const base = `http://127.0.0.1:${port}`;
    test("root redirects to an honest, responsive sign-in placeholder", async ({ page }, testInfo) => {
      await page.goto(base);
      await expect(page).toHaveURL(`${base}/login`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your financial picture, in one private place.");
      await expect(page.getByText("Sign-in is not available yet.", { exact: false })).toBeVisible();
      expect(await page.locator("form").count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await page.content()).not.toMatch(/preview-secret-marker|DATABASE_URL|INNGEST_SIGNING_KEY/);
      await page.screenshot({ path: testInfo.outputPath("runtime.png"), fullPage: true });
    });

    test("health stays safe and financial/auth/workflow routes stay closed", async ({ request }) => {
      const live = await request.get(`${base}/api/health`);
      expect(live.status()).toBe(200);
      expect(await live.json()).toEqual({ status: "ok" });
      expect(live.headers()["cache-control"]).toBe("no-store");
      const ready = await request.get(`${base}/api/health/ready`);
      expect(ready.status()).toBe(503);
      expect(await ready.json()).toEqual({ status: "not_ready" });
      expect(ready.headers()["cache-control"]).toBe("no-store");
      for (const path of ["/dashboard", "/api/reports", "/api/auth/session"]) {
        expect((await request.get(`${base}${path}`)).status()).toBe(404);
      }
      expect((await request.post(`${base}/api/imports`, { data: {} })).status()).toBe(404);
      for (const method of ["GET", "POST", "PUT"]) {
        const response = await request.fetch(`${base}/api/inngest`, { method });
        expect(response.status()).toBe(503);
        expect(await response.json()).toEqual({ error: "Workflow endpoint unavailable" });
      }
    });
  });
}
