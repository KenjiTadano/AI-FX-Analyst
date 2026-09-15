import { expect, test } from "@playwright/test";
import { assertNoOverflow, pairSelect } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

const rec = ["エントリー", "チャンス", "おすすめ", "Entry OK", "GO"];

test.describe("multi-timeframe analysis", () => {
  test("1 MTF card visible", async ({ page }) => {
    await openDashboard(page);
    await expect(page.getByRole("heading", { name: "マルチタイムフレーム分析" })).toBeVisible();
    await expect(page.getByTestId("multi-timeframe")).toHaveAttribute("aria-label", "マルチタイムフレーム分析");
  });

  test("2 USDJPY 4 timeframe", async ({ page }) => {
    await openDashboard(page, { mtf: "all-bullish" });
    await expect(page.getByTestId("mtf-row-1day")).toBeVisible();
    await expect(page.getByTestId("mtf-row-4h")).toBeVisible();
    await expect(page.getByTestId("mtf-row-1h")).toBeVisible();
    await expect(page.getByTestId("mtf-row-15m")).toBeVisible();
    await expect(page.getByTestId("daily-plan-pair")).toHaveText("USD/JPY");
  });

  test("3 EURJPY switch", async ({ page }) => {
    await openDashboard(page, { mtfByPair: { "USD/JPY": "all-bullish", "EUR/JPY": "all-bearish" } });
    await expect(page.getByTestId("mtf-bias")).toHaveText("上向き");
    await pairSelect(page).selectOption("EUR/JPY");
    await expect(page.getByTestId("daily-plan-pair")).toHaveText("EUR/JPY");
    await expect(page.getByTestId("mtf-bias")).toHaveText("下向き");
  });

  test("4 GBPJPY switch", async ({ page }) => {
    await openDashboard(page, { mtfByPair: { "USD/JPY": "all-bullish", "GBP/JPY": "mixed" } });
    await pairSelect(page).selectOption("GBP/JPY");
    await expect(page.getByTestId("daily-plan-pair")).toHaveText("GBP/JPY");
    await expect(page.getByTestId("mtf-alignment")).toHaveText("時間軸で方向が混在しています");
  });

  test("5 all bullish", async ({ page }) => {
    await openDashboard(page, { mtf: "all-bullish" });
    await expect(page.getByTestId("mtf-alignment")).toHaveText("すべての時間軸が上向きです");
    for (const tf of ["1day", "4h", "1h", "15m"]) {
      await expect(page.getByTestId(`mtf-trend-${tf}`)).toHaveText("上向き");
    }
  });

  test("6 all bearish", async ({ page }) => {
    await openDashboard(page, { mtf: "all-bearish" });
    await expect(page.getByTestId("mtf-alignment")).toHaveText("すべての時間軸が下向きです");
  });

  test("7 mixed", async ({ page }) => {
    await openDashboard(page, { mtf: "mixed" });
    await expect(page.getByTestId("mtf-alignment")).toHaveText("時間軸で方向が混在しています");
    await expect(page.getByTestId("mtf-bias")).toHaveText("上向き");
  });

  test("8 partial 3/4", async ({ page }) => {
    await openDashboard(page, { mtf: "partial" });
    await expect(page.getByTestId("mtf-status")).toHaveText("3 / 4 timeframes");
    await expect(page.getByTestId("mtf-trend-15m")).toHaveText("未取得");
  });

  test("9 one unavailable", async ({ page }) => {
    await openDashboard(page, { mtf: "one-unavailable" });
    await expect(page.getByTestId("mtf-alignment")).toHaveText("判定に必要な時間軸が不足しています");
    await expect(page.getByTestId("mtf-trend-1day")).toHaveText("上向き");
  });

  test("10 all unavailable", async ({ page }) => {
    await openDashboard(page, { mtf: "all-unavailable" });
    await expect(page.getByTestId("mtf-unavailable-all")).toHaveText("マルチタイムフレーム分析を取得できません");
    await expect(page.getByTestId("mtf-status")).toHaveText("0 / 4 timeframes");
  });

  test("11 higher bias bullish", async ({ page }) => {
    await openDashboard(page, { mtf: "htf-bullish" });
    await expect(page.getByTestId("mtf-bias")).toHaveText("上向き");
  });

  test("12 higher bias bearish", async ({ page }) => {
    await openDashboard(page, { mtf: "htf-bearish" });
    await expect(page.getByTestId("mtf-bias")).toHaveText("下向き");
  });

  test("13 higher bias unavailable", async ({ page }) => {
    await openDashboard(page, { mtf: "htf-unavailable" });
    await expect(page.getByTestId("mtf-bias")).toHaveText("未取得");
  });

  test("14 conflict display", async ({ page }) => {
    await openDashboard(page, { mtf: "mixed" });
    await expect(page.getByTestId("mtf-conflicts")).toBeVisible();
    await expect(page.getByTestId("mtf-conflict-0")).toContainText("上位足は上向きですが");
  });

  test("15 conflict cap", async ({ page }) => {
    await openDashboard(page, { mtf: "mixed" });
    await expect(page.locator("[data-testid^='mtf-conflict-']")).toHaveCount(2);
  });

  test("16 no recommendation wording", async ({ page }) => {
    await openDashboard(page, { mtf: "all-bullish" });
    const card = page.getByTestId("multi-timeframe");
    for (const text of rec) await expect(card.getByText(text, { exact: true })).toHaveCount(0);
  });

  test("17 4/4 data status", async ({ page }) => {
    await openDashboard(page, { mtf: "all-bullish" });
    await expect(page.getByTestId("mtf-status")).toHaveText("4 / 4 timeframes");
  });

  test("18 3/4 data status", async ({ page }) => {
    await openDashboard(page, { mtf: "partial" });
    await expect(page.getByTestId("mtf-status")).toHaveText("3 / 4 timeframes");
  });

  test("19 pair switch no stale previous pair", async ({ page }) => {
    await openDashboard(page, { mtfByPair: { "USD/JPY": "all-bullish", "EUR/JPY": "all-bearish" } });
    await expect(page.getByTestId("mtf-trend-1day")).toHaveText("上向き");
    await pairSelect(page).selectOption("EUR/JPY");
    await expect(page.getByTestId("mtf-trend-1day")).toHaveText("下向き");
    await expect(page.getByTestId("mtf-alignment")).toHaveText("すべての時間軸が下向きです");
  });

  test("20 MTF + normal AI analysis", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait", mtf: "all-bullish" });
    await expect(page.getByTestId("multi-timeframe")).toBeVisible();
    await expect(page.getByRole("heading", { name: "AI総合判定" })).toBeVisible();
  });

  test("21 MTF + chart-assisted AI", async ({ page }) => {
    await openDashboard(page, { analysis: "chart-evidence", mtf: "all-bullish" });
    await expect(page.getByTestId("multi-timeframe")).toBeVisible();
    await expect(page.getByTestId("ai-chart-evidence")).toBeVisible();
  });

  test("22 MTF unavailable + AI still works", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait", mtf: "all-unavailable" });
    await expect(page.getByTestId("mtf-unavailable-all")).toBeVisible();
    await expect(page.getByRole("heading", { name: "AI総合判定" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "今日のトレード計画" })).toBeVisible();
  });

  test("23 no raw candles in AI request", async ({ page }) => {
    const bodies: string[] = [];
    page.on("request", request => {
      if (/\/api\/analysis/.test(request.url())) bodies.push(request.postData() ?? request.url());
    });
    await openDashboard(page, { analysis: "chart-evidence", mtf: "all-bullish" });
    assertNoCandles(bodies);
  });

  test("24 no extra OpenAI request", async ({ page }) => {
    const { leaks } = await openDashboard(page, { mtf: "all-bullish" });
    expect(leaks.filter(url => /openai/i.test(url))).toEqual([]);
  });

  test("25 no real external network", async ({ page }) => {
    const { leaks } = await openDashboard(page, { mtf: "mixed" });
    expect(leaks).toEqual([]);
  });

  test("26 390x844 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, { mtf: "mixed" });
    await expect(page.getByTestId("multi-timeframe")).toBeVisible();
    await assertNoOverflow(page);
  });

  test("27 1280x900 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDashboard(page, { mtf: "all-bullish" });
    await expect(page.getByTestId("multi-timeframe")).toBeVisible();
    await assertNoOverflow(page);
  });
});

function assertNoCandles(bodies: string[]) {
  for (const body of bodies) {
    expect(body.includes('"candles"')).toBe(false);
  }
}
