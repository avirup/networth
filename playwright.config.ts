import { defineConfig, devices } from "@playwright/test";

// Optional second engine for cross-browser checks and hosts with a stalled Chromium compositor.
const browserName = process.env.PLAYWRIGHT_BROWSER === "firefox" ? "firefox" : "chromium";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results/runtime",
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], browserName } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: browserName, browserName, ...(browserName === "firefox" ? { isMobile: false } : {}) } },
  ],
  webServer: [
    { command: "node scripts/start-smoke.mjs missing 3100", url: "http://127.0.0.1:3100/api/health", reuseExistingServer: false },
    { command: "node scripts/start-smoke.mjs preview 3101", url: "http://127.0.0.1:3101/api/health", reuseExistingServer: false },
  ],
});
