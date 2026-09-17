import { expect, test } from "@playwright/test";
const base = "http://127.0.0.1:3100";
const example = `${base}/preview/overview?month=2026-09`;

test("preview is isolated and public setup/status stay honest", async ({ page, request }) => {
  expect((await request.get("http://127.0.0.1:3101/preview")).status()).toBe(404);
  expect((await request.get(`${base}/preview/unknown`)).status()).toBe(404);
  await page.goto(`${base}/setup`);
  await expect(page.getByText("Configure these server settings before setup:", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Setup code", { exact: true })).toBeVisible();
  await page.goto(`${base}/status`);
  await expect(page).toHaveURL(`${base}/login`);

});

test("report month updates context, blocks future months, and returns focus", async ({ page }) => {
  await page.goto(example);
  const trigger = page.getByRole("button", { name: "Select reporting month, September 2026" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Select reporting month" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Sep", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "No report for August 2026" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select reporting month, August 2026" })).toBeFocused();
  await page.getByRole("button", { name: "Select reporting month, August 2026" }).click();
  await dialog.getByRole("button", { name: "Reset to current month" }).click();
  await expect(dialog).not.toBeVisible();
  // Future-month URL input also falls back to current month.
  await page.goto(`${base}/preview?month=9999-12`);
  await expect(page.getByRole("button", { name: /Select reporting month, December 9999/ })).toHaveCount(0);
  await page.getByRole("button", { name: /Select reporting month,/ }).click();
  await expect(dialog.getByRole("button", { name: "Show next year" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Show previous year" }).click();
  await expect(dialog.getByRole("button", { name: "Show next year" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: /Select reporting month,/ })).toBeFocused();
});

test("navigation persists collapse and traps the mobile drawer", async ({ page }, testInfo) => {
  await page.goto(example);
  if (testInfo.project.name === "desktop") {
    await page.getByRole("button", { name: "Collapse navigation" }).click();
    await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
    await page.reload();
    await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
    await expect(page.getByRole("link", { name: "Accounts", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Expand navigation" }).click();
  } else {
    await page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation", exact: true });
    await expect(drawer).toBeVisible();
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press("Tab");
      expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
    await page.getByRole("button", { name: "Open navigation" }).click();
  }
  await page.getByRole("link", { name: "Accounts", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Accounts is coming later" })).toBeVisible();
  await expect(page).toHaveURL(/month=2026-09/);
  await page.getByRole("link", { name: "Back to overview" }).click();
  if (testInfo.project.name === "mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Import data", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Imports are not available yet" })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
});

test("portfolio sorting and disclosure work on every viewport", async ({ page }) => {
  await page.goto(example);
  await expect(page.locator(".data-row").first()).toContainText("Shares");
  await page.getByRole("button", { name: "Sort present value ascending" }).click();
  await expect(page.locator(".data-row").first()).toContainText("Sovereign gold bonds");
  const expand = page.getByRole("button", { name: "Show Sovereign gold bonds details" });
  await expand.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#details-gold")).toBeVisible();
  await expect(page.locator("#details-gold")).toContainText("Illustrative manual price");
  await page.getByRole("button", { name: "Sort present value descending" }).click();
  await expect(page.locator("#details-gold")).toBeVisible();
  const salary = page.locator('[data-chart-mark][aria-label="Salary contributed 3 lakh 10 thousand rupees"]');
  await salary.focus();
  await expect(page.locator(".chart-tooltip")).toHaveText("Salary contributed 3 lakh 10 thousand rupees");
  await page.getByText("Read the cash-flow values", { exact: true }).click();
  await expect(page.getByText("Investment principal and debt repayments are shown separately from expenses.")).toBeVisible();
});

test("profile and notifications have honest actions and restore focus", async ({ page }) => {
  await page.goto(example);
  await page.getByRole("button", { name: "Open sample profile" }).click();
  await expect(page.getByText("No account is signed in.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open sample profile" })).toBeFocused();
  await page.getByRole("button", { name: "View notifications" }).click();
  await expect(page.getByText("There are no notifications in this preview.")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("button", { name: "View notifications" })).toBeFocused();
});

test("quality states preserve context, unknown values and retry behavior", async ({ page }) => {
  await page.goto(example);
  const state = page.getByRole("combobox", { name: "Preview state" });
  for (const name of ["paused", "stale", "incomplete"] as const) {
    await state.selectOption(name);
    await expect(page.locator(".quality")).toHaveClass(new RegExp(`quality-${name}`));
    await expect(page.locator("[data-report-release]")).toHaveAttribute("data-report-release", "synthetic-september-v1");
  }
  await expect(page.locator(".kpi-card").first().getByLabel(/Unknown:/)).toBeVisible();
  await state.selectOption("loading"); await expect(page.getByRole("status")).toHaveText("Loading your report…");
  await state.selectOption("error"); await expect(page.getByRole("alert").filter({ hasText: "This report couldn’t be loaded" })).toBeVisible();
  await page.getByRole("button", { name: "Retry example" }).click();
  await expect(page.locator(".quality-complete")).toBeVisible();
  await state.selectOption("edge");
  await expect(page.getByText("−₹1,42,800", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Sort present value ascending" }).click();
  await expect(page.locator(".data-row").last()).toContainText("unavailable valuation");
});

test("desktop and mobile visual evidence", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto(example);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ animations: "disabled", scale: "css", path: testInfo.outputPath("overview.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (testInfo.project.name === "desktop") {
    await page.getByRole("button", { name: "Collapse navigation" }).click();
    await page.screenshot({ animations: "disabled", scale: "css", path: testInfo.outputPath("collapsed.png"), fullPage: true });
    await page.setViewportSize({ width: 900, height: 1000 });
    await page.screenshot({ animations: "disabled", scale: "css", path: testInfo.outputPath("tablet.png"), fullPage: true });
  } else {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.screenshot({ animations: "disabled", scale: "css", path: testInfo.outputPath("drawer.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /Select reporting month,/ }).click();
    await page.screenshot({ animations: "disabled", scale: "css", path: testInfo.outputPath("month-picker.png") });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 320, height: 740 });
    await page.getByRole("combobox", { name: "Preview state" }).selectOption("edge");
    await page.screenshot({ animations: "disabled", scale: "css", path: testInfo.outputPath("narrow-edge.png"), fullPage: true });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
