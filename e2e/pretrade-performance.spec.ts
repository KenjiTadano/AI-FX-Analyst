import { expect, test, type Page } from "@playwright/test";
import { assertNoOverflow } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

async function openPerformance(page: Page, tradeSet: "default" | "pretrade-performance" | "pretrade-full" = "pretrade-performance") {
  await openDashboard(page, { analysis: "sell-wait", ...(tradeSet === "default" ? {} : { tradeSet }) });
  await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "成績" }).click();
  await expect(page.getByTestId("pretrade-performance")).toBeVisible();
}

test.describe("pre-trade context performance", () => {
  test("1 Performance section visible", async ({ page }) => {
    await openPerformance(page);
    await expect(page.getByRole("heading", { name: "エントリー時判断状況別の成績" })).toBeVisible();
    await expect(page.getByText("PRE-TRADE CONTEXT PERFORMANCE")).toBeVisible();
  });

  test("2 coverage full", async ({ page }) => {
    await openPerformance(page, "pretrade-full");
    const coverage = page.getByTestId("pretrade-performance-coverage");
    await expect(coverage).toContainText("Contextなし 0");
    await expect(coverage).toContainText("保存率 100.0%");
  });

  test("3 coverage partial", async ({ page }) => {
    await openPerformance(page, "pretrade-performance");
    const coverage = page.getByTestId("pretrade-performance-coverage");
    await expect(coverage).toContainText("Pre-Trade Contextあり");
    await expect(coverage).toContainText("Contextなし");
    await expect(coverage).not.toContainText("Contextなし 0");
  });

  test("4 no-context state", async ({ page }) => {
    await openPerformance(page, "default");
    await expect(page.getByTestId("pretrade-performance-no-context")).toBeVisible();
    await expect(page.getByTestId("pretrade-performance-no-context")).toContainText("エントリー時の判断状況が保存されていません");
    await expect(page.getByTestId("pretrade-performance-trigger")).toHaveCount(0);
  });

  test("5 Trigger MET group", async ({ page }) => {
    await openPerformance(page);
    await expect(page.getByTestId("pretrade-performance-trigger-met")).toContainText("条件成立");
  });

  test("6 Trigger NOT_MET group", async ({ page }) => {
    await openPerformance(page);
    await expect(page.getByTestId("pretrade-performance-trigger-not_met")).toContainText("条件未成立");
  });

  test("7 WAIT Action group", async ({ page }) => {
    await openPerformance(page);
    await expect(page.getByTestId("pretrade-performance-action-WAIT")).toContainText("WAIT");
  });

  test("8 stale group", async ({ page }) => {
    await openPerformance(page);
    await expect(page.getByTestId("pretrade-performance-freshness-stale")).toContainText("期限切れ分析");
  });

  test("9 Event unavailable group", async ({ page }) => {
    await openPerformance(page);
    await expect(page.getByTestId("pretrade-performance-event-unavailable")).toContainText("未取得");
    await expect(page.getByTestId("pretrade-performance-event-unavailable")).not.toContainText("LOW");
  });

  test("10 DLL reached group", async ({ page }) => {
    await openPerformance(page);
    await expect(page.getByTestId("pretrade-performance-dll-reached")).toContainText("Daily Loss Limit 到達");
  });

  test("11 insufficient sample label", async ({ page }) => {
    await openPerformance(page);
    await expect(page.getByTestId("pretrade-performance-freshness-stale").getByText("参考値")).toBeVisible();
  });

  test("12 sufficient sample metrics", async ({ page }) => {
    await openPerformance(page);
    const met = page.getByTestId("pretrade-performance-trigger-met");
    await expect(met).toContainText("勝率");
    await expect(met.getByText("過去の取引結果")).toBeVisible();
  });

  test("13 neutral comparison wording", async ({ page }) => {
    await openPerformance(page);
    const panel = page.getByTestId("pretrade-performance");
    await expect(page.getByTestId("pretrade-performance-comparisons")).toContainText("条件成立グループの平均損益");
    await expect(panel).not.toContainText("ルール遵守");
    await expect(panel).not.toContainText("ルール違反");
    await expect(panel).not.toContainText("正しいEntry");
    await expect(panel).not.toContainText("悪いEntry");
    await expect(panel).not.toContainText("Trigger成立を待つべき");
  });

  test("14 period all", async ({ page }) => {
    await openPerformance(page);
    await expect(page.getByTestId("pretrade-performance-period")).toContainText("全期間");
  });

  test("15 period 30d changes Task023", async ({ page }) => {
    await openPerformance(page);
    const met = page.getByTestId("pretrade-performance-trigger-met");
    const allText = await met.textContent();
    await page.getByTestId("performance-period-30d").click();
    await expect(page.getByTestId("pretrade-performance-period")).toContainText("直近30日");
    await expect(met).not.toHaveText(allText ?? "");
  });

  test("16 period 90d changes Task023", async ({ page }) => {
    await openPerformance(page);
    await page.getByTestId("performance-period-90d").click();
    await expect(page.getByTestId("pretrade-performance-period")).toContainText("直近90日");
    const d90 = await page.getByTestId("pretrade-performance-trigger-met").textContent();
    await page.getByTestId("performance-period-30d").click();
    await expect(page.getByTestId("pretrade-performance-period")).toContainText("直近30日");
    await expect(page.getByTestId("pretrade-performance-trigger-met")).not.toHaveText(d90 ?? "");
  });

  test("17 OPEN excluded", async ({ page }) => {
    await openPerformance(page, "pretrade-performance");
    await expect(page.getByTestId("pretrade-performance-coverage")).toContainText("分析対象 CLOSED trades 25");
    await expect(page.getByTestId("pretrade-performance-coverage")).toContainText("Pre-Trade Contextあり 18");
  });

  test("18 legacy excluded from context groups", async ({ page }) => {
    await openPerformance(page, "pretrade-performance");
    await expect(page.getByTestId("pretrade-performance-coverage")).not.toContainText("Contextなし 0");
    await expect(page.getByTestId("pretrade-performance-trigger-no_trigger")).toHaveCount(0);
  });

  test("19 390x844 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPerformance(page);
    await expect(page.getByTestId("pretrade-performance")).toBeVisible();
    await assertNoOverflow(page);
  });

  test("20 1280x900 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openPerformance(page);
    await expect(page.getByTestId("pretrade-performance")).toBeVisible();
    await assertNoOverflow(page);
  });
});
