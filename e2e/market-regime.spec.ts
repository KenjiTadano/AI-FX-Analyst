import { expect, test } from "@playwright/test";
import { assertNoOverflow, pairSelect } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

const rec = ["エントリー", "チャンス", "おすすめ", "Entry OK", "買い相場", "売り相場", "強い買い"];

test.describe("market regime analysis", () => {
  test("1 Market Regime card visible", async ({ page }) => {
    await openDashboard(page);
    await expect(page.getByRole("heading", { name: "相場環境" })).toBeVisible();
    await expect(page.getByTestId("market-regime")).toHaveAttribute("aria-label", "相場環境");
  });

  test("2 trending bullish", async ({ page }) => {
    await openDashboard(page, { regime: "trending-bullish", analysis: "sell-wait" });
    await expect(page.getByTestId("regime-kind")).toHaveText("トレンド");
    await expect(page.getByTestId("regime-trend")).toHaveText("上向き");
  });

  test("3 trending bearish", async ({ page }) => {
    await openDashboard(page, { regime: "trending-bearish", analysis: "sell-wait" });
    await expect(page.getByTestId("regime-kind")).toHaveText("トレンド");
    await expect(page.getByTestId("regime-trend")).toHaveText("下向き");
  });

  test("4 range", async ({ page }) => {
    await openDashboard(page, { regime: "range", analysis: "sell-wait" });
    await expect(page.getByTestId("regime-kind")).toHaveText("レンジ");
    await expect(page.getByTestId("regime-trend")).toHaveText("中立");
  });

  test("5 transition", async ({ page }) => {
    await openDashboard(page, { regime: "transition", analysis: "sell-wait" });
    await expect(page.getByTestId("regime-kind")).toHaveText("移行・不明瞭");
  });

  test("6 unavailable", async ({ page }) => {
    await openDashboard(page, { regime: "unavailable", analysis: "sell-wait" });
    await expect(page.getByTestId("regime-kind")).toHaveText("未取得");
    await expect(page.getByTestId("regime-unavailable")).toHaveText("相場環境を判定するための確定足データが不足しています");
  });

  test("7 high volatility", async ({ page }) => {
    await openDashboard(page, { regime: "high-vol", analysis: "sell-wait" });
    await expect(page.getByTestId("regime-volatility")).toHaveText("高い");
    await expect(page.getByTestId("regime-kind")).toHaveText("トレンド");
  });

  test("8 normal volatility", async ({ page }) => {
    await openDashboard(page, { regime: "normal-vol", analysis: "sell-wait" });
    await expect(page.getByTestId("regime-volatility")).toHaveText("通常");
  });

  test("9 low volatility", async ({ page }) => {
    await openDashboard(page, { regime: "low-vol", analysis: "sell-wait" });
    await expect(page.getByTestId("regime-volatility")).toHaveText("低い");
  });

  test("10 1H label", async ({ page }) => {
    await openDashboard(page, { regime: "trending-bullish" });
    await expect(page.getByTestId("regime-timeframe")).toHaveText("1H");
  });

  test("11 factual reasons", async ({ page }) => {
    await openDashboard(page, { regime: "trending-bullish" });
    const reasons = page.getByTestId("regime-reasons");
    await expect(reasons).toBeVisible();
    await expect(reasons).toContainText("1時間足の価格とSMA20・75・200が上向き順に並んでいます");
  });

  test("12 no recommendation wording", async ({ page }) => {
    await openDashboard(page, { regime: "high-vol", analysis: "sell-wait" });
    const card = page.getByTestId("market-regime");
    for (const text of rec) await expect(card.getByText(text, { exact: true })).toHaveCount(0);
  });

  test("13 Action WAIT preserved", async ({ page }) => {
    await openDashboard(page, { regime: "trending-bullish", analysis: "sell-wait" });
    await expect(page.getByTestId("regime-kind")).toHaveText("トレンド");
    await expect(page.getByTestId("daily-plan-action")).toHaveText("WAIT");
    await expect(page.getByTestId("entry-readiness-action")).toHaveText("WAIT");
  });

  test("14 Readiness remains 5", async ({ page }) => {
    await openDashboard(page, { regime: "trending-bullish", analysis: "sell-wait", calendar: "empty" });
    await expect(page.getByTestId("entry-readiness-count")).toHaveText("5 / 5 条件確認");
    await expect(page.locator("[data-testid^='entry-readiness-check-']")).toHaveCount(5);
  });

  test("15 Trigger unchanged", async ({ page }) => {
    await openDashboard(page, { regime: "range", analysis: "sell-wait" });
    await expect(page.getByTestId("entry-readiness")).toBeVisible();
    await expect(page.getByTestId("daily-plan-action")).toHaveText("WAIT");
  });

  test("16 Daily Plan unchanged", async ({ page }) => {
    await openDashboard(page, { regime: "trending-bullish", analysis: "sell-wait" });
    await expect(page.getByRole("heading", { name: "今日のトレード計画" })).toBeVisible();
    await expect(page.getByTestId("daily-plan-action")).toHaveText("WAIT");
    await expect(page.getByTestId("daily-plan-direction")).toHaveText("SELL");
  });

  test("17 MTF card unchanged", async ({ page }) => {
    await openDashboard(page, { mtf: "all-bullish", regime: "trending-bullish" });
    await expect(page.getByTestId("multi-timeframe")).toBeVisible();
    await expect(page.getByTestId("mtf-alignment")).toHaveText("すべての時間軸が上向きです");
    await expect(page.getByTestId("market-regime")).toBeVisible();
  });

  test("18 pair switch", async ({ page }) => {
    await openDashboard(page, {
      regimeByPair: { "USD/JPY": "trending-bullish", "EUR/JPY": "trending-bearish" },
      analysis: "sell-wait",
    });
    await expect(page.getByTestId("regime-trend")).toHaveText("上向き");
    await pairSelect(page).selectOption("EUR/JPY");
    await expect(page.getByTestId("daily-plan-pair")).toHaveText("EUR/JPY");
    await expect(page.getByTestId("regime-trend")).toHaveText("下向き");
  });

  test("19 pair mismatch", async ({ page }) => {
    await openDashboard(page, {
      regimeByPair: { "USD/JPY": "trending-bullish", "EUR/JPY": "range" },
      analysis: "sell-wait",
    });
    await expect(page.getByTestId("regime-kind")).toHaveText("トレンド");
    await pairSelect(page).selectOption("EUR/JPY");
    await expect(page.getByTestId("regime-kind")).toHaveText("レンジ");
    await expect(page.getByTestId("regime-kind")).not.toHaveText("トレンド");
  });

  test("20 insufficient data", async ({ page }) => {
    await openDashboard(page, { regime: "insufficient", analysis: "sell-wait" });
    await expect(page.getByTestId("regime-kind")).toHaveText("未取得");
    await expect(page.getByTestId("regime-unavailable")).toBeVisible();
  });

  test("21 forming candle ignored", async ({ page }) => {
    await openDashboard(page, { regime: "forming", analysis: "sell-wait" });
    await expect(page.getByTestId("regime-kind")).toHaveText("未取得");
  });

  test("22 AI request includes regime evidence", async ({ page }) => {
    const bodies: string[] = [];
    page.on("request", request => {
      if (/\/api\/analysis/.test(request.url())) bodies.push(request.postData() ?? request.url());
    });
    await openDashboard(page, { analysis: "chart-evidence", regime: "trending-bullish" });
    expect(bodies.length).toBeGreaterThan(0);
    await expect(page.getByTestId("regime-kind")).toHaveText("トレンド");
    await expect(page.getByRole("heading", { name: "AI総合判定" })).toBeVisible();
  });

  test("23 AI request raw candles absent", async ({ page }) => {
    const bodies: string[] = [];
    page.on("request", request => {
      if (/\/api\/analysis/.test(request.url())) bodies.push(request.postData() ?? request.url());
    });
    await openDashboard(page, { analysis: "chart-evidence", regime: "trending-bullish" });
    for (const body of bodies) expect(body.includes('"candles"')).toBe(false);
  });

  test("24 no extra OpenAI request", async ({ page }) => {
    const { leaks } = await openDashboard(page, { regime: "trending-bullish" });
    expect(leaks.filter(url => /openai/i.test(url))).toEqual([]);
  });

  test("25 no extra Twelve request", async ({ page }) => {
    const { leaks } = await openDashboard(page, { regime: "high-vol" });
    expect(leaks.filter(url => /twelvedata/i.test(url))).toEqual([]);
  });

  test("26 no external real network", async ({ page }) => {
    const { leaks } = await openDashboard(page, { regime: "range" });
    expect(leaks).toEqual([]);
  });

  test("27 390 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, { regime: "transition", analysis: "sell-wait" });
    await expect(page.getByTestId("market-regime")).toBeVisible();
    await assertNoOverflow(page);
  });

  test("28 1280 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDashboard(page, { regime: "trending-bullish", analysis: "sell-wait" });
    await expect(page.getByTestId("market-regime")).toBeVisible();
    await assertNoOverflow(page);
  });
});
