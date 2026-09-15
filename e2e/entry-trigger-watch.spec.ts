import { expect, test, type Page } from "@playwright/test";
import { advanceExistingRefresh, assertNoOverflow, pairSelect } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

const forbidden = ["Entry OK", "今すぐ売る", "今すぐ買う", "エントリー可能", "売買OK", "チャンス！", "今です", "たった今成立", "新しく成立"];

async function installRefreshClock(page: Page) {
  await page.clock.install({ toFake: ["setTimeout"] });
  await page.clock.resume();
}

test.describe("entry trigger watch", () => {
  test("1 waiting + distance 8 pips", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", marketPrice: 156.28 });
    await expect(page.getByTestId("entry-trigger-watch")).toBeVisible();
    await expect(page.getByRole("heading", { name: "ENTRY TRIGGER WATCH" })).toBeVisible();
    await expect(page.getByTestId("entry-trigger-watch-direction")).toHaveText("SELL");
    await expect(page.getByTestId("entry-trigger-watch-action")).toHaveText("WAIT");
    await expect(page.getByTestId("entry-trigger-watch-status")).toContainText("条件待ち");
    await expect(page.getByTestId("entry-trigger-watch-distance")).toContainText("あと 8 pips");
    await expect(page.getByTestId("entry-trigger-watch-distance-disclaimer")).toContainText("成立確率やエントリー推奨度ではありません");
    await expect(page.getByTestId("entry-readiness").getByText("%到達")).toHaveCount(0);
    await expect(page.getByTestId("entry-readiness").getByText("%達成")).toHaveCount(0);
  });

  test("2 price trigger met", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", marketPrice: 156.1 });
    await expect(page.getByTestId("entry-trigger-watch-status")).toContainText("条件成立");
    await expect(page.getByTestId("entry-trigger-watch-distance")).toHaveCount(0);
    await expect(page.getByTestId("entry-readiness-action")).toHaveText("WAIT");
    await expect(page.getByTestId("entry-trigger-watch-notice")).toHaveCount(0);
  });

  test("3 candle waiting + distance", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-candle-below", candleClose: 156.28 });
    await expect(page.getByTestId("entry-trigger-expression")).toHaveText("15min CLOSE < 156.2");
    await expect(page.getByTestId("entry-trigger-watch-status")).toContainText("条件待ち");
    await expect(page.getByTestId("entry-trigger-watch-distance")).toContainText("あと 8 pips");
    await expect(page.getByTestId("entry-trigger-observed")).toContainText("156.28");
  });

  test("4 candle met", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-candle-below", candleClose: 156.1 });
    await expect(page.getByTestId("entry-trigger-watch-status")).toContainText("条件成立");
    await expect(page.getByTestId("entry-trigger-observed")).toHaveText("156.1");
    await expect(page.getByTestId("entry-trigger-watch-distance")).toHaveCount(0);
  });

  test("5 equality = waiting + 0 pips", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", marketPrice: 156.2 });
    await expect(page.getByTestId("entry-trigger-watch-status")).toContainText("条件待ち");
    await expect(page.getByTestId("entry-trigger-watch-distance")).toContainText("あと 0 pips");
    await expect(page.getByTestId("entry-trigger-watch-status")).not.toHaveText("条件成立");
  });

  test("6 unavailable = 判定データ待ち", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", marketStale: true });
    await expect(page.getByTestId("entry-trigger-watch-status")).toContainText("判定データ待ち");
    await expect(page.getByTestId("entry-trigger-watch-distance")).toHaveCount(0);
    await expect(page.getByTestId("entry-trigger-status")).toContainText("現在価格の判定データを待っています");
  });

  test("7 SELL + WAIT + MET remains WAIT", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", marketPrice: 156.1 });
    await expect(page.getByTestId("entry-trigger-watch-direction")).toHaveText("SELL");
    await expect(page.getByTestId("entry-trigger-watch-action")).toHaveText("WAIT");
    await expect(page.getByTestId("entry-readiness-action")).toHaveText("WAIT");
    await expect(page.getByTestId("entry-trigger-watch-status")).toContainText("条件成立");
  });

  test("8 5/5 + WAIT + MET remains WAIT", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.1 });
    await expect(page.getByTestId("entry-readiness-count")).toHaveText("5 / 5 条件確認");
    await expect(page.getByTestId("entry-trigger-watch-status")).toContainText("条件成立");
    await expect(page.getByTestId("entry-readiness-action")).toHaveText("WAIT");
    await expect(page.getByTestId("entry-readiness-action-message")).toHaveText("現在のActionはWAITです");
    for (const text of forbidden) {
      await expect(page.getByTestId("entry-readiness").getByText(text, { exact: true })).toHaveCount(0);
    }
  });

  test("9 stale + MET warning remains", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-stale", marketPrice: 156.1 });
    await expect(page.getByTestId("entry-trigger-watch-status")).toContainText("条件成立");
    await expect(page.getByTestId("entry-trigger-stale")).toContainText("分析が古いため再分析してください");
    await expect(page.getByTestId("entry-readiness-action")).toHaveText("WAIT");
    await expect(page.getByTestId("entry-readiness").getByRole("button", { name: "AI総合分析を更新" })).toBeVisible();
  });

  test("10 DLL + MET warning remains", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", dailyLossLimitPercent: 1, marketPrice: 156.1 });
    await expect(page.getByTestId("entry-trigger-watch-status")).toContainText("条件成立");
    await expect(page.getByTestId("entry-readiness-warning")).toContainText("設定したDaily Loss Limitに到達しています");
    await expect(page.getByTestId("entry-readiness").getByText("取引禁止")).toHaveCount(0);
    await expect(page.getByTestId("entry-readiness-action")).toHaveText("WAIT");
  });

  test("11 Event high + MET warning remains", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "high", marketPrice: 156.1 });
    await expect(page.getByTestId("entry-trigger-watch-status")).toContainText("条件成立");
    await expect(page.getByTestId("entry-readiness-warning")).toBeVisible();
    await expect(page.getByTestId("entry-readiness-check-eventRisk")).toContainText("注意");
    await expect(page.getByTestId("daily-plan-event")).toBeVisible();
    await expect(page.getByTestId("entry-readiness-action")).toHaveText("WAIT");
  });

  test("12 pair switch resets Watch", async ({ page }) => {
    await openDashboard(page, {
      analysis: "trigger-price-below",
      marketPrice: 156.28,
      analyses: { "USD/JPY": "trigger-price-below", "EUR/JPY": "unavailable", "GBP/JPY": "unavailable" },
    });
    await expect(page.getByTestId("entry-trigger-watch-distance")).toContainText("8 pips");
    await pairSelect(page).selectOption("EUR/JPY");
    await expect(page.getByTestId("daily-plan-pair")).toHaveText("EUR/JPY");
    await expect(page.getByTestId("entry-trigger-watch")).toHaveCount(0);
    await expect(page.getByTestId("entry-trigger-watch-notice")).toHaveCount(0);
    await pairSelect(page).selectOption("USD/JPY");
    await expect(page.getByTestId("entry-trigger-watch")).toBeVisible();
    await expect(page.getByTestId("entry-trigger-watch-notice")).toHaveCount(0);
  });

  test("13 reanalysis/trigger identity change no stale transition", async ({ page }) => {
    await installRefreshClock(page);
    const { setMarket, setAnalysis } = await openDashboard(page, { analysis: "trigger-stale", marketPrice: 156.28 });
    await expect(page.getByTestId("entry-trigger-watch-status")).toContainText("条件待ち");
    setMarket({ price: 156.1 });
    await advanceExistingRefresh(page);
    await expect.poll(async () => page.getByTestId("entry-trigger-watch-status").innerText()).toContain("条件成立");
    await expect(page.getByTestId("entry-trigger-watch-notice")).toBeVisible();
    setAnalysis("trigger-price-below");
    await page.getByTestId("entry-readiness-warning").getByRole("button", { name: "AI総合分析を更新" }).click();
    await expect.poll(async () => page.getByTestId("entry-trigger-stale").count()).toBe(0);
    await expect(page.getByTestId("entry-trigger-watch-status")).toContainText("条件成立");
    await expect(page.getByTestId("entry-trigger-watch-notice")).toHaveCount(0);
  });

  test("14 initial met no newly met", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", marketPrice: 156.1 });
    await expect(page.getByTestId("entry-trigger-watch-status")).toContainText("条件成立");
    await expect(page.getByTestId("entry-trigger-watch-notice")).toHaveCount(0);
    for (const text of ["たった今成立", "新しく成立", "チャンス", "今です"]) {
      await expect(page.getByTestId("entry-readiness").getByText(text)).toHaveCount(0);
    }
  });

  test("15 not_met → met transition notice", async ({ page }) => {
    await installRefreshClock(page);
    const { setMarket } = await openDashboard(page, { analysis: "trigger-price-below", marketPrice: 156.28 });
    await expect(page.getByTestId("entry-trigger-watch-status")).toContainText("条件待ち");
    await expect(page.getByTestId("entry-trigger-watch-notice")).toHaveCount(0);
    setMarket({ price: 156.1 });
    await advanceExistingRefresh(page);
    await expect.poll(async () => page.getByTestId("entry-trigger-watch-status").innerText()).toContain("条件成立");
    const notice = page.getByTestId("entry-trigger-watch-notice");
    await expect(notice).toHaveText("エントリー条件の成立を確認しました");
    await expect(notice).toHaveAttribute("role", "status");
    await expect(page.getByTestId("entry-readiness-action")).toHaveText("WAIT");
  });

  test("16 390x844 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, { analysis: "trigger-candle-below", candleClose: 156.28 });
    await expect(page.getByTestId("entry-trigger-watch")).toBeVisible();
    await expect(page.getByTestId("entry-trigger-watch-distance")).toBeVisible();
    await expect(page.getByTestId("entry-trigger-watch-distance-disclaimer")).toBeVisible();
    await assertNoOverflow(page);
  });

  test("17 1280x900 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDashboard(page, { analysis: "trigger-price-below", marketPrice: 156.28, calendar: "empty" });
    await expect(page.getByRole("heading", { name: "エントリー準備度" })).toBeVisible();
    await expect(page.getByTestId("entry-trigger-watch")).toBeVisible();
    await assertNoOverflow(page);
  });
});
