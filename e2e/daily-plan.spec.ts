import { expect, test } from "@playwright/test";
import { pairSelect } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

test.describe("daily trading plan", () => {
  test("2 SELL + WAIT keeps direction and action separate", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByTestId("daily-plan-direction")).toHaveText("SELL");
    await expect(page.getByTestId("daily-plan-action")).toHaveText("WAIT");
    await expect(page.getByTestId("daily-plan-message")).toHaveText("今はエントリーせず待つ");
    await expect(page.getByTestId("daily-plan-direction-note")).toContainText("下方向");
    await expect(page.getByText("今すぐ売る")).toHaveCount(0);
  });

  test("3 BUY + WAIT keeps WAIT", async ({ page }) => {
    await openDashboard(page, { analysis: "buy-wait" });
    await expect(page.getByTestId("daily-plan-direction")).toHaveText("BUY");
    await expect(page.getByTestId("daily-plan-action")).toHaveText("WAIT");
    await expect(page.getByTestId("daily-plan-message")).toHaveText("今はエントリーせず待つ");
    await expect(page.getByText("今すぐ買う")).toHaveCount(0);
  });

  test("4 review BUY", async ({ page }) => {
    await openDashboard(page, { analysis: "review-buy" });
    await expect(page.getByTestId("daily-plan-action")).toHaveText("BUY");
    await expect(page.getByTestId("daily-plan-message")).toHaveText("BUY条件を確認");
    await expect(page.getByText("今すぐ買う")).toHaveCount(0);
  });

  test("5 review SELL", async ({ page }) => {
    await openDashboard(page, { analysis: "review-sell" });
    await expect(page.getByTestId("daily-plan-action")).toHaveText("SELL");
    await expect(page.getByTestId("daily-plan-message")).toHaveText("SELL条件を確認");
    await expect(page.getByText("今すぐ売る")).toHaveCount(0);
  });

  test("6 pair switching fail closed", async ({ page }) => {
    await openDashboard(page, {
      analysis: "sell-wait",
      analyses: { "USD/JPY": "sell-wait", "EUR/JPY": "unavailable", "GBP/JPY": "unavailable" },
    });
    await expect(page.getByTestId("daily-plan-entry")).toContainText("SELL検討条件");
    await expect(page.getByTestId("daily-plan").getByText("156.20を下抜けた場合")).toBeVisible();
    await pairSelect(page).selectOption("EUR/JPY");
    await expect(page.getByTestId("daily-plan-pair")).toHaveText("EUR/JPY");
    await expect(page.getByTestId("daily-plan-message")).toHaveText("AI分析を実行すると今日の計画を表示できます");
    await expect(page.getByTestId("daily-plan-direction")).toHaveText("NEUTRAL");
    await expect(page.getByTestId("daily-plan-action")).toHaveText("—");
    await expect(page.getByTestId("daily-plan-entry")).toHaveText("Entry条件：データなし");
    await expect(page.getByTestId("daily-plan").getByText("156.20を下抜けた場合")).toHaveCount(0);
    await expect(page.getByTestId("daily-plan-chart-badge")).toHaveCount(0);
  });

  test("7 stale outranks BUY", async ({ page }) => {
    await openDashboard(page, { analysis: "stale" });
    await expect(page.getByTestId("daily-plan-message")).toHaveText("分析から時間が経過しています");
    await expect(page.getByTestId("daily-plan-status")).toHaveText("分析期限切れ");
  });

  test("8 Daily Loss Limit reached", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait", dailyLossLimitPercent: 1 });
    await expect(page.getByTestId("daily-plan-message")).toHaveText("設定したDaily Loss Limitに到達しています");
    await expect(page.getByText("取引禁止")).toHaveCount(0);
  });

  test("9 Today's Results uses local day and all pairs", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByText("全通貨ペア")).toBeVisible();
    await expect(page.getByTestId("daily-plan-today-count")).toHaveText("2件");
    await expect(page.getByTestId("daily-plan-today-closed")).toHaveText("1件");
    await expect(page.getByTestId("daily-plan-today-pnl")).toHaveText(/[-−－].*[1-9]/);
  });

  test("10 chart evidence badge", async ({ page }) => {
    await openDashboard(page, { analysis: "chart-evidence" });
    await expect(page.getByTestId("daily-plan-chart-badge")).toHaveText("チャート解析を含む");
  });

  test("22 entry condition comes from fixture only", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByTestId("daily-plan").getByText("156.20を下抜けた場合")).toBeVisible();
    await expect(page.getByText("現在のAI分析に含まれる条件")).toBeVisible();
  });

  test("23 missing SL/TP is not invented", async ({ page }) => {
    await openDashboard(page, { analysis: "no-sl-tp" });
    await expect(page.getByTestId("daily-plan-entry")).toHaveText("Entry条件：データなし");
    await expect(page.getByTestId("daily-plan").getByText("Stop Loss")).toHaveCount(0);
    await expect(page.getByTestId("daily-plan").getByText("Take Profit")).toHaveCount(0);
  });

  test("24 Event Risk uses calendar fixture not FRED", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByTestId("daily-plan-event")).not.toHaveText(/本日21:30/);
    await expect(page.getByTestId("daily-plan-event")).toContainText("米CPI");
    await expect(page.getByText("FRED実績を未来の発表時刻には使いません")).toBeVisible();
  });

  test("25 confidence disclaimer", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByTestId("daily-plan-confidence-disclaimer")).toContainText("勝率を保証する値ではありません");
  });

  test("26 no auto trading copy", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByTestId("daily-plan-no-auto")).toContainText("注文は自動送信されません");
  });
});
