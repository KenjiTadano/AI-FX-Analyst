import { expect, test, type Page } from "@playwright/test";
import { assertNoOverflow } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

const forbidden = [
  "この条件で取引すると有利",
  "トレンド相場を狙うべき",
  "レンジを避けるべき",
  "勝ちパターン",
  "今後も期待できる",
  "優位性がある",
  "good context",
  "bad context",
  "high quality",
];

async function openPerformance(page: Page) {
  await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "成績" }).click();
  await expect(page.getByRole("heading", { name: "Trading Performance Intelligence" })).toBeVisible();
}

test.describe("performance intelligence", () => {
  test("1 panel visible with overview coverage R distribution", async ({ page }) => {
    const { leaks } = await openDashboard(page, { tradeSet: "performance-intelligence", regime: "trending" });
    await openPerformance(page);
    await expect(page.getByTestId("pi-overview")).toBeVisible();
    await expect(page.getByTestId("pi-closed-trades")).toBeVisible();
    await expect(page.getByTestId("pi-total-pnl")).toBeVisible();
    await expect(page.getByTestId("pi-average-pnl")).toBeVisible();
    await expect(page.getByTestId("pi-win-rate")).toBeVisible();
    await expect(page.getByTestId("pi-profit-factor")).toBeVisible();
    await expect(page.getByTestId("pi-average-r")).toBeVisible();
    await expect(page.getByTestId("pi-coverage")).toBeVisible();
    await expect(page.getByTestId("pi-coverage-pretrade")).toBeVisible();
    await expect(page.getByTestId("pi-coverage-mtf")).toBeVisible();
    await expect(page.getByTestId("pi-coverage-regime")).toBeVisible();
    await expect(page.getByTestId("pi-coverage-r")).toBeVisible();
    await expect(page.getByTestId("pi-r-distribution")).toBeVisible();
    for (const key of ["r_le_minus_1", "r_minus_1_to_0", "r_0_to_1", "r_1_to_2", "r_ge_2"]) {
      await expect(page.getByTestId(`pi-r-bucket-${key}`)).toBeVisible();
    }
    await expect(page.getByTestId("pi-market-context")).toBeVisible();
    await expect(page.getByTestId("pi-regime")).toBeVisible();
    await expect(page.getByTestId("pi-volatility")).toBeVisible();
    await expect(page.getByTestId("pi-observations")).toBeVisible();
    expect(leaks).toEqual([]);
  });

  test("2 period filter changes intelligence counts", async ({ page }) => {
    await openDashboard(page, { tradeSet: "performance-intelligence" });
    await openPerformance(page);
    const closed = page.getByTestId("pi-closed-trades");
    const allText = await closed.textContent();
    await page.getByTestId("performance-period-30d").click();
    await expect(page.getByTestId("period-summary")).toContainText("直近30日");
    await expect(closed).not.toHaveText(allText ?? "");
    await page.getByTestId("performance-period-90d").click();
    await expect(page.getByTestId("period-summary")).toContainText("直近90日");
    await expect(page.getByTestId("pi-overview")).toBeVisible();
  });

  test("3 missing != unavailable labels", async ({ page }) => {
    await openDashboard(page, { tradeSet: "performance-intelligence" });
    await openPerformance(page);
    await expect(page.getByTestId("pi-regime-missing-note")).toContainText("missing（未保存）");
    await expect(page.getByTestId("pi-regime-missing-note")).toContainText("保存時点 unavailable");
    await expect(page.getByTestId("pi-regime-context_missing")).toBeVisible();
    await expect(page.getByTestId("pi-regime-unavailable")).toBeVisible();
  });

  test("4 current live regime does not rewrite historical grouping", async ({ page }) => {
    await openDashboard(page, { tradeSet: "performance-intelligence", regime: "range" });
    await openPerformance(page);
    await expect(page.getByTestId("pi-regime-trending")).toBeVisible();
    await expect(page.getByTestId("pi-regime-range")).toBeVisible();
  });

  test("5 empty closed trades", async ({ page }) => {
    await openDashboard(page, { includeTrades: false });
    await openPerformance(page);
    await expect(page.getByTestId("pi-empty")).toContainText("この期間には決済済み取引がありません");
  });

  test("6 no forbidden recommendation wording", async ({ page }) => {
    await openDashboard(page, { tradeSet: "performance-intelligence" });
    await openPerformance(page);
    const body = await page.locator(".performance-intelligence-panel").innerText();
    for (const word of forbidden) {
      expect(body).not.toContain(word);
    }
  });

  test("7 existing Task014/015/016 sections remain", async ({ page }) => {
    await openDashboard(page, { tradeSet: "performance-intelligence" });
    await openPerformance(page);
    await expect(page.getByRole("heading", { name: "トレード振り返り" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "分析時点からEntryまで", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "AI方向とEntry位置", exact: true })).toBeVisible();
  });

  test("8 mobile 390x844 no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, { tradeSet: "performance-intelligence" });
    await openPerformance(page);
    await assertNoOverflow(page);
  });

  test("9 desktop 1280x900 no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDashboard(page, { tradeSet: "performance-intelligence" });
    await openPerformance(page);
    await assertNoOverflow(page);
  });

  test("10 v2 timeframe and technical sections visible", async ({ page }) => {
    await openDashboard(page, { tradeSet: "performance-intelligence" });
    await openPerformance(page);
    await expect(page.getByTestId("pi-r-multiple")).toBeVisible();
    await expect(page.getByTestId("pi-positive-r")).toBeVisible();
    await expect(page.getByTestId("pi-negative-r")).toBeVisible();
    await expect(page.getByTestId("pi-timeframe")).toBeVisible();
    await expect(page.getByTestId("pi-tf-15m")).toBeVisible();
    await expect(page.getByTestId("pi-tf-1h")).toBeVisible();
    await expect(page.getByTestId("pi-tf-4h")).toBeVisible();
    await expect(page.getByTestId("pi-tf-1day")).toBeVisible();
    await expect(page.getByTestId("pi-technical")).toBeVisible();
    await expect(page.getByTestId("pi-sma")).toBeVisible();
    await expect(page.getByTestId("pi-rsi")).toBeVisible();
    await expect(page.getByTestId("pi-cross")).toBeVisible();
  });
});
