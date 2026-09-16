import { expect, test } from "@playwright/test";
import { assertNoOverflow } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

const rec = ["おすすめ", "Entry OK", "GO", "勝ちパターン", "悪いEntry", "良いEntry", "狙うべき"];
const causal = ["alignedだから", "mixedだから負け", "4/4を待つべき", "逆らうと負ける", "この条件なら勝てる"];

async function openMtfPerformance(
  page: Parameters<typeof openDashboard>[0],
  extra: Parameters<typeof openDashboard>[1] = { tradeSet: "mtf-performance" },
) {
  const hooks = await openDashboard(page, { analysis: "sell-wait", ...extra });
  await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "成績" }).click();
  await expect(page.getByTestId("mtf-performance")).toBeVisible();
  return hooks;
}

test.describe("mtf performance", () => {
  test("1 MTF Performance section visible", async ({ page }) => {
    await openMtfPerformance(page);
    await expect(page.getByRole("heading", { name: "エントリー時MTF別の過去実績" })).toBeVisible();
    await expect(page.getByText("MULTI-TIMEFRAME PERFORMANCE")).toBeVisible();
  });

  test("2 no trades state", async ({ page }) => {
    await openMtfPerformance(page, { tradeSet: "default" });
    await expect(page.getByTestId("mtf-performance-empty")).toHaveText("この期間には、エントリー時MTFが保存された決済済み取引がありません。");
    await expect(page.getByTestId("mtf-performance-alignment")).toHaveCount(0);
  });

  test("3 coverage", async ({ page }) => {
    await openMtfPerformance(page);
    const coverage = page.getByTestId("mtf-performance-coverage");
    await expect(coverage).toContainText("MTF Snapshot Coverage");
    await expect(coverage).toContainText("MTF保存あり 35 / 40");
    await expect(coverage).toContainText("87.5%");
  });

  test("4 legacy excluded from groups", async ({ page }) => {
    await openMtfPerformance(page);
    await expect(page.getByTestId("mtf-performance-coverage")).toContainText("MTF保存あり 35 / 40");
    await expect(page.getByTestId("mtf-performance-alignment-aligned_bullish")).not.toContainText("40件");
  });

  test("5 valid insufficient separate", async ({ page }) => {
    await openMtfPerformance(page);
    await expect(page.getByTestId("mtf-performance-alignment-insufficient")).toContainText("データ不足");
    await expect(page.getByTestId("mtf-performance-alignment-insufficient")).toContainText("10件");
  });

  test("6 all unavailable valid", async ({ page }) => {
    await openMtfPerformance(page);
    await expect(page.getByTestId("mtf-performance-htf-unavailable")).toContainText("未取得");
    await expect(page.getByTestId("mtf-performance-htf-unavailable")).toContainText("5件");
  });

  test("7 aligned bullish", async ({ page }) => {
    await openMtfPerformance(page);
    await expect(page.getByTestId("mtf-performance-alignment-aligned_bullish")).toContainText("全時間軸で上向き");
    await expect(page.getByTestId("mtf-performance-alignment-aligned_bullish")).toContainText("10件");
  });

  test("8 aligned bearish", async ({ page }) => {
    await openMtfPerformance(page);
    await expect(page.getByTestId("mtf-performance-alignment-aligned_bearish")).toContainText("全時間軸で下向き");
  });

  test("9 mixed", async ({ page }) => {
    await openMtfPerformance(page);
    await expect(page.getByTestId("mtf-performance-alignment-mixed")).toContainText("時間軸で方向が混在");
  });

  test("10 HTF groups", async ({ page }) => {
    await openMtfPerformance(page);
    await expect(page.getByTestId("mtf-performance-htf-bullish")).toContainText("上向き");
    await expect(page.getByTestId("mtf-performance-htf-bearish")).toContainText("下向き");
    await expect(page.getByTestId("mtf-performance-htf-neutral")).toContainText("中立");
    await expect(page.getByTestId("mtf-performance-htf-unavailable")).toContainText("未取得");
  });

  test("11 AI aligned", async ({ page }) => {
    await openMtfPerformance(page);
    await expect(page.getByTestId("mtf-performance-ai-aligned_with_ai")).toContainText("方向一致");
  });

  test("12 AI contrary", async ({ page }) => {
    await openMtfPerformance(page);
    await expect(page.getByTestId("mtf-performance-ai-contrary_to_ai")).toContainText("逆方向");
    await expect(page.getByTestId("mtf-performance-ai-contrary_to_ai")).not.toContainText("悪い");
  });

  test("13 Action WAIT + direction classification", async ({ page }) => {
    await openMtfPerformance(page);
    await expect(page.getByTestId("mtf-performance-ai-aligned_with_ai")).toBeVisible();
    await expect(page.getByTestId("mtf-performance")).not.toContainText("ルール違反");
    await expect(page.getByTestId("mtf-performance")).not.toContainText("WAITを無視");
  });

  test("14 sample insufficient", async ({ page }) => {
    await openMtfPerformance(page);
    await expect(page.getByTestId("mtf-performance-htf-neutral").getByText("参考値")).toBeVisible();
  });

  test("15 PF —", async ({ page }) => {
    await openMtfPerformance(page);
    await expect(page.getByTestId("mtf-performance-alignment-aligned_bullish")).toContainText("PF —");
  });

  test("16 period all", async ({ page }) => {
    await openMtfPerformance(page);
    await expect(page.getByTestId("mtf-performance-period")).toContainText("全期間");
  });

  test("17 period 30d", async ({ page }) => {
    await openMtfPerformance(page);
    const allText = await page.getByTestId("mtf-performance-alignment-aligned_bullish").textContent();
    await page.getByTestId("performance-period-30d").click();
    await expect(page.getByTestId("mtf-performance-period")).toContainText("直近30日");
    await expect(page.getByTestId("mtf-performance-alignment-aligned_bullish")).not.toHaveText(allText ?? "");
  });

  test("18 period 90d", async ({ page }) => {
    await openMtfPerformance(page);
    await page.getByTestId("performance-period-90d").click();
    await expect(page.getByTestId("mtf-performance-period")).toContainText("直近90日");
    const d90 = await page.getByTestId("mtf-performance-coverage").textContent();
    await page.getByTestId("performance-period-30d").click();
    await expect(page.getByTestId("mtf-performance-coverage")).not.toHaveText(d90 ?? "");
  });

  test("19 current Live change no historical change", async ({ page }) => {
    await openMtfPerformance(page, { tradeSet: "mtf-performance", mtf: "all-bearish" });
    await expect(page.getByTestId("mtf-performance-alignment-aligned_bullish")).toContainText("10件");
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "分析" }).click();
    await expect(page.getByTestId("mtf-alignment")).toHaveText("すべての時間軸が下向きです");
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "成績" }).click();
    await expect(page.getByTestId("mtf-performance-alignment-aligned_bullish")).toContainText("10件");
  });

  test("20 current AI change no historical change", async ({ page }) => {
    const { setAnalysis } = await openMtfPerformance(page, { tradeSet: "mtf-performance", analysis: "sell-wait" });
    const before = await page.getByTestId("mtf-performance-ai-aligned_with_ai").textContent();
    setAnalysis("buy-wait");
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "分析" }).click();
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "成績" }).click();
    await expect(page.getByTestId("mtf-performance-ai-aligned_with_ai")).toHaveText(before ?? "");
  });

  test("21 no recommendation wording", async ({ page }) => {
    await openMtfPerformance(page);
    const panel = page.getByTestId("mtf-performance");
    for (const text of rec) await expect(panel.getByText(text, { exact: true })).toHaveCount(0);
  });

  test("22 no causal wording", async ({ page }) => {
    await openMtfPerformance(page);
    const panel = page.getByTestId("mtf-performance");
    for (const text of causal) await expect(panel.getByText(text)).toHaveCount(0);
  });

  test("23 390px no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMtfPerformance(page);
    await expect(page.getByTestId("mtf-performance")).toBeVisible();
    await assertNoOverflow(page);
  });

  test("24 1280px layout", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openMtfPerformance(page);
    await expect(page.getByTestId("mtf-performance-alignment-aligned_bullish")).toBeVisible();
    await assertNoOverflow(page);
  });

  test("25 no real external network", async ({ page }) => {
    const { leaks } = await openMtfPerformance(page);
    expect(leaks).toEqual([]);
  });
});
