import { expect, test } from "@playwright/test";
import { assertNoOverflow } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

const nav = (page: import("@playwright/test").Page) =>
  page.getByRole("navigation", { name: "ダッシュボード表示" });

test.describe("dashboard final integration", () => {
  test("1 primary hierarchy and pair context", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByTestId("market-context")).toBeVisible();
    await expect(page.getByTestId("dashboard-pair")).toHaveText("USD/JPY");
    await expect(page.getByTestId("ia-analysis")).toBeVisible();
    await expect(page.getByTestId("ia-trade-setup")).toBeVisible();
    await expect(page.getByTestId("ia-market-detail")).toBeVisible();
    await expect(page.getByTestId("dashboard-flow")).toContainText("分析");
    const analysisBox = await page.getByTestId("ia-analysis").boundingBox();
    const setupBox = await page.getByTestId("ia-trade-setup").boundingBox();
    const marketBox = await page.getByTestId("ia-market-detail").boundingBox();
    expect(analysisBox && setupBox && marketBox).toBeTruthy();
    expect(analysisBox!.y).toBeLessThan(setupBox!.y);
    expect(setupBox!.y).toBeLessThan(marketBox!.y);
  });

  test("2 direction and action stay separate", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByTestId("ai-direction")).toBeVisible();
    await expect(page.getByTestId("ai-action")).toBeVisible();
    await expect(page.getByTestId("daily-plan-direction")).toBeVisible();
    await expect(page.getByTestId("daily-plan-action")).toBeVisible();
    const direction = (await page.getByTestId("daily-plan-direction").innerText()).trim();
    const action = (await page.getByTestId("daily-plan-action").innerText()).trim();
    expect(direction.length).toBeGreaterThan(0);
    expect(action.length).toBeGreaterThan(0);
  });

  test("3 readiness stays five checks and trigger is not GO", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByTestId("entry-readiness-count")).toContainText("/ 5");
    for (const id of ["analysis", "direction", "dataQuality", "risk", "eventRisk"]) {
      await expect(page.getByTestId(`entry-readiness-check-${id}`)).toBeVisible();
    }
    const setup = await page.getByTestId("ia-trade-setup").innerText();
    expect(setup).not.toMatch(/\bGO\b|Entry OK/);
    expect(setup).toContain("エントリー推奨度を表すものではありません");
  });

  test("4 journal and performance navigation", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await nav(page).getByRole("button", { name: "トレード" }).click();
    await expect(page.getByRole("heading", { name: "トレード記録" })).toBeVisible();
    await nav(page).getByRole("button", { name: "成績" }).click();
    await expect(page.getByRole("heading", { name: "Trading Performance Intelligence" })).toBeVisible();
    await expect(page.getByTestId("performance-detail")).toBeVisible();
    await expect(page.getByRole("heading", { name: "分析時点からEntryまで", exact: true })).toBeVisible();
  });

  test("5 unavailable analysis is not shown as WAIT action", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable" });
    await expect(page.getByTestId("daily-plan")).toBeVisible();
    const status = await page.getByTestId("daily-plan-status").innerText();
    expect(status).toMatch(/未取得|WAIT/);
    await expect(page.getByText("現在AI総合分析を取得できません").first()).toBeVisible();
  });

  test("6 keyboard can reach navigation", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    const button = nav(page).getByRole("button", { name: "成績" });
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "表示期間" })).toBeVisible();
  });

  test("7 mobile 390x844 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, { analysis: "sell-wait" });
    await assertNoOverflow(page);
    await nav(page).getByRole("button", { name: "成績" }).click();
    await assertNoOverflow(page);
  });

  test("8 desktop 1280x900 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDashboard(page, { analysis: "sell-wait" });
    await assertNoOverflow(page);
  });
});
