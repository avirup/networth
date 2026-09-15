import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
  webServer: [
    { command: "node scripts/start-smoke.mjs missing 3100", url: "http://127.0.0.1:3100/api/health", reuseExistingServer: false },
    { command: "node scripts/start-smoke.mjs preview 3101", url: "http://127.0.0.1:3101/api/health", reuseExistingServer: false },
  ],
});
