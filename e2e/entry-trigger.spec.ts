import { expect, test } from "@playwright/test";
import { assertNoOverflow, pairSelect } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

const forbidden = ["Entry OK", "今すぐ売る", "今すぐ買う", "エントリー可能", "売買OK"];

test.describe("structured entry trigger", () => {
  test("1 price trigger not_met", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below" });
    await expect(page.getByTestId("entry-trigger")).toBeVisible();
    await expect(page.getByTestId("entry-trigger-expression")).toHaveText("PRICE < 156.2");
    await expect(page.getByTestId("entry-trigger-status")).toContainText("条件未成立");
    await expect(page.getByTestId("entry-trigger")).toContainText("AI分析時に構造化された条件");
  });

  test("2 price trigger met", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", marketPrice: 156.1 });
    await expect(page.getByTestId("entry-trigger-status")).toContainText("条件成立を確認");
    await expect(page.getByTestId("entry-readiness-action")).toHaveText("WAIT");
    for (const text of forbidden) {
      await expect(page.getByTestId("entry-readiness").getByText(text, { exact: true })).toHaveCount(0);
    }
  });

  test("3 candle trigger met", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-candle-below", candleClose: 156.1 });
    await expect(page.getByTestId("entry-trigger-expression")).toHaveText("15min CLOSE < 156.2");
    await expect(page.getByTestId("entry-trigger-human")).toContainText("15分足の終値が156.2を下回る");
    await expect(page.getByTestId("entry-trigger-status")).toContainText("条件成立");
    await expect(page.getByTestId("entry-trigger-observed")).toHaveText("156.1");
  });

  test("4 trigger unavailable", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", marketStale: true });
    await expect(page.getByTestId("entry-trigger-status")).toContainText("判定データ不足");
    await expect(page.getByTestId("entry-trigger-status")).not.toHaveText("条件未成立");
  });

  test("5 trigger null fallback", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByTestId("entry-trigger")).toHaveCount(0);
    await expect(page.getByTestId("entry-readiness-condition-note")).toHaveText("条件成立の自動判定はしていません");
  });

  test("6 5/5 + WAIT + Trigger MET", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.1 });
    await expect(page.getByTestId("entry-readiness-count")).toHaveText("5 / 5 条件確認");
    await expect(page.getByTestId("daily-plan-direction")).toHaveText("SELL");
    await expect(page.getByTestId("entry-readiness-action")).toHaveText("WAIT");
    await expect(page.getByTestId("entry-readiness-action-message")).toHaveText("現在のActionはWAITです");
    await expect(page.getByTestId("entry-trigger-status")).toContainText("条件成立を確認");
    for (const text of forbidden) {
      await expect(page.getByText(text, { exact: true })).toHaveCount(0);
    }
  });

  test("7 stale + Trigger MET", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-stale", marketPrice: 156.1 });
    await expect(page.getByTestId("entry-trigger-status")).toContainText("条件成立");
    await expect(page.getByTestId("entry-readiness-state")).toHaveText("分析から時間が経過しています");
    await expect(page.getByTestId("entry-trigger-stale")).toContainText("分析が古いため再分析してください");
    await expect(page.getByTestId("entry-readiness").getByRole("button", { name: "AI総合分析を更新" })).toBeVisible();
  });

  test("8 DLL + Trigger MET", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", dailyLossLimitPercent: 1, marketPrice: 156.1 });
    await expect(page.getByTestId("entry-trigger-status")).toContainText("条件成立");
    await expect(page.getByTestId("entry-readiness-warning")).toContainText("設定したDaily Loss Limitに到達しています");
    await expect(page.getByTestId("entry-readiness").getByText("取引禁止")).toHaveCount(0);
    await expect(page.getByTestId("entry-readiness-action")).toHaveText("WAIT");
  });

  test("9 pair switch no residual trigger", async ({ page }) => {
    await openDashboard(page, {
      analysis: "trigger-price-below",
      analyses: { "USD/JPY": "trigger-price-below", "EUR/JPY": "unavailable", "GBP/JPY": "unavailable" },
    });
    await expect(page.getByTestId("entry-trigger-expression")).toContainText("156.2");
    await pairSelect(page).selectOption("EUR/JPY");
    await expect(page.getByTestId("daily-plan-pair")).toHaveText("EUR/JPY");
    await expect(page.getByTestId("entry-trigger")).toHaveCount(0);
    await expect(page.getByTestId("entry-readiness").getByText("156.2")).toHaveCount(0);
    await expect(page.getByTestId("entry-readiness").getByText("156.20")).toHaveCount(0);
  });

  test("10 mobile 390x844 overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, { analysis: "trigger-candle-below", candleClose: 156.1 });
    await expect(page.getByTestId("entry-trigger")).toBeVisible();
    await expect(page.getByTestId("entry-trigger-disclaimer")).toBeVisible();
    await assertNoOverflow(page);
  });

  test("11 desktop 1280x900 overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDashboard(page, { analysis: "trigger-price-below", marketPrice: 156.1, calendar: "empty" });
    await expect(page.getByRole("heading", { name: "エントリー準備度" })).toBeVisible();
    await expect(page.getByTestId("entry-trigger")).toBeVisible();
    await assertNoOverflow(page);
  });
});
