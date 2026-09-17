import { defineConfig, devices } from "@playwright/test";
const browserName = process.env.PLAYWRIGHT_BROWSER === "firefox" ? "firefox" : "chromium";
export default defineConfig({
  testDir: "./tests/auth-e2e", outputDir: "test-results/auth", workers: 1, fullyParallel: false, retries: 0, reporter: "list",
  use: { ...devices["Desktop Chrome"], browserName, baseURL: "http://127.0.0.1:3102", trace: "retain-on-failure" },
  webServer: { command: "node scripts/start-auth-smoke.mjs", url: "http://127.0.0.1:3102/api/health", reuseExistingServer: false },
});
