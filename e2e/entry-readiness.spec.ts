import { expect, test } from "@playwright/test";
import { assertNoOverflow, pairSelect } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

const forbiddenSignals = ["Entry OK", "今すぐ売る", "今すぐ買う", "エントリー可能", "売買OK"];

test.describe("entry readiness", () => {
  test("49 SELL + WAIT keeps WAIT", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByTestId("daily-plan-direction")).toHaveText("SELL");
    await expect(page.getByTestId("daily-plan-action")).toHaveText("WAIT");
    await expect(page.getByTestId("entry-readiness-check-direction")).toContainText("SELL");
    await expect(page.getByTestId("entry-readiness-action")).toHaveText("WAIT");
    await expect(page.getByTestId("entry-readiness-action-message")).toHaveText("現在のActionはWAITです");
    for (const text of forbiddenSignals) {
      await expect(page.getByTestId("entry-readiness").getByText(text)).toHaveCount(0);
    }
  });

  test("50 5/5 + WAIT remains WAIT", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait", calendar: "empty" });
    await expect(page.getByTestId("entry-readiness-count")).toHaveText("5 / 5 条件確認");
    await expect(page.getByTestId("entry-readiness-action")).toHaveText("WAIT");
    await expect(page.getByTestId("entry-readiness-action-message")).toHaveText("現在のActionはWAITです");
    await expect(page.getByTestId("entry-readiness-state")).toHaveText("条件を確認できます");
    await expect(page.getByTestId("entry-readiness").getByText("%")).toHaveCount(0);
    for (const text of forbiddenSignals) {
      await expect(page.getByText(text)).toHaveCount(0);
    }
  });

  test("51 Event unavailable is 未取得, not 重要イベントなし", async ({ page }) => {
    await openDashboard(page, { analysis: "event-unavailable", calendar: "unavailable" });
    await expect(page.getByTestId("entry-readiness-check-eventRisk")).toContainText("未取得");
    await expect(page.getByTestId("entry-readiness-check-eventRisk")).toContainText("イベント情報：取得できていません");
    await expect(page.getByTestId("entry-readiness").getByText("重要イベントなし")).toHaveCount(0);
    await expect(page.getByTestId("entry-readiness-count")).not.toHaveText("5 / 5 条件確認");
  });

  test("52 stale shows warning and reanalysis CTA", async ({ page }) => {
    await openDashboard(page, { analysis: "stale" });
    await expect(page.getByTestId("entry-readiness-check-analysis")).toContainText("注意");
    await expect(page.getByTestId("entry-readiness-check-analysis")).toContainText("分析を更新してください");
    await expect(page.getByTestId("entry-readiness").getByRole("button", { name: "AI総合分析を更新" })).toBeVisible();
  });

  test("53 Daily Loss Limit warning is first", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait", dailyLossLimitPercent: 1 });
    await expect(page.getByTestId("entry-readiness-warning")).toContainText("設定したDaily Loss Limitに到達しています");
    await expect(page.getByTestId("entry-readiness-state")).toHaveText("設定したDaily Loss Limitに到達しています");
    await expect(page.getByTestId("entry-readiness").getByText("取引禁止")).toHaveCount(0);
    await expect(page.getByTestId("entry-readiness-action")).toHaveText("WAIT");
  });

  test("54 pair switching fail closed", async ({ page }) => {
    await openDashboard(page, {
      analysis: "sell-wait",
      analyses: { "USD/JPY": "sell-wait", "EUR/JPY": "unavailable", "GBP/JPY": "unavailable" },
    });
    await expect(page.getByTestId("entry-readiness-condition-text")).toHaveText("156.20を下抜けた場合");
    await pairSelect(page).selectOption("EUR/JPY");
    await expect(page.getByTestId("daily-plan-pair")).toHaveText("EUR/JPY");
    await expect(page.getByTestId("entry-readiness-state")).toHaveText("AI分析を実行すると準備状況を確認できます");
    await expect(page.getByTestId("entry-readiness-check-analysis")).toContainText("未取得");
    await expect(page.getByTestId("entry-readiness").getByText("156.20を下抜けた場合")).toHaveCount(0);
    await expect(page.getByTestId("entry-readiness-action")).toHaveText("—");
  });

  test("55 mobile 390x844 overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, { analysis: "long-condition" });
    await expect(page.getByTestId("entry-readiness")).toBeVisible();
    await expect(page.getByTestId("entry-readiness-count")).toBeVisible();
    await expect(page.getByTestId("entry-readiness-entry-condition")).toBeVisible();
    await assertNoOverflow(page);
  });

  test("55b desktop 1280x900 overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByRole("heading", { name: "今日のトレード計画" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "エントリー準備度" })).toBeVisible();
    await expect(page.getByTestId("entry-readiness-disclaimer")).toContainText("勝率やエントリー推奨度を表すものではありません");
    await assertNoOverflow(page);
  });
});
