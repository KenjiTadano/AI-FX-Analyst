import { expect, test, type Page } from "@playwright/test";
import { advanceExistingRefresh, assertNoOverflow } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

const forbidden = ["Entry OK", "GO", "Quality Score", "良いEntry", "悪いEntry", "おすすめ", "勝ちやすい"];

async function openTradeForm(page: Page) {
  await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "トレード" }).click();
  await expect(page.getByRole("heading", { name: "トレード記録" })).toBeVisible();
  await page.getByRole("button", { name: "トレードを記録" }).click();
  return page.getByRole("form", { name: "新規トレード登録" });
}

async function fillAndSave(page: Page, form: ReturnType<Page["getByRole"]>, notes: string) {
  await form.getByLabel("エントリー価格").fill("156.18");
  await form.getByLabel("取引数量（通貨）").fill("1000");
  await form.getByLabel("メモ").fill(notes);
  await form.getByRole("button", { name: "取引を保存" }).click();
  await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
}

async function openSavedTrade(page: Page, notes: string) {
  const record = page.locator(".trade-record").filter({ hasText: notes });
  await expect(record).toBeVisible();
  const details = record.getByText("エントリー時AI分析");
  if (await details.count()) await details.click();
  return record;
}

const liveOpts = {
  analysis: "trigger-price-above" as const,
  calendar: "empty" as const,
  marketPrice: 156.18,
  mtf: "all-bullish" as const,
  regime: "trending-bullish" as const,
  includeTrades: false,
};

test.describe("entry context", () => {
  test("1 Entry Context visible", async ({ page }) => {
    const { leaks } = await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review")).toBeVisible();
    await expect(form.getByText("ENTRY CONTEXT")).toBeVisible();
    await expect(form.getByRole("heading", { name: "エントリー判断コンテキスト" })).toBeVisible();
    expect(leaks).toEqual([]);
  });

  test("2 Direction + Action", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-direction")).toHaveText("BUY");
    await expect(form.getByTestId("pretrade-review-action")).toHaveText("WAIT");
  });

  test("3 BUY + WAIT valid", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await form.getByLabel("売買方向").selectOption("long");
    await expect(form.getByTestId("pretrade-review-direction")).toHaveText("BUY");
    await expect(form.getByTestId("pretrade-review-action")).toHaveText("WAIT");
    await expect(form.getByText("Entry OK")).toHaveCount(0);
    await expect(form.getByText("GO", { exact: true })).toHaveCount(0);
  });

  test("4 MTF", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-mtf")).toHaveText("方向一致");
  });

  test("5 HTF", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-htf")).toHaveText("上向き");
  });

  test("6 Regime trending", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-regime")).toHaveText("トレンド");
    await expect(form.getByTestId("pretrade-review-regime-trend")).toHaveText("上向き");
  });

  test("7 Regime range", async ({ page }) => {
    await openDashboard(page, { ...liveOpts, regime: "range" });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-regime")).toHaveText("レンジ");
  });

  test("8 Regime transition", async ({ page }) => {
    await openDashboard(page, { ...liveOpts, regime: "transition" });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-regime")).toHaveText("移行・不明瞭");
  });

  test("9 Volatility", async ({ page }) => {
    await openDashboard(page, { ...liveOpts, regime: "high-vol" });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-volatility")).toHaveText("高い");
  });

  test("10 Readiness 5/5", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-readiness")).toHaveText("5 / 5");
    await expect(form.getByText("Entry OK")).toHaveCount(0);
  });

  test("11 Trigger MET", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-trigger")).toHaveText("条件成立");
  });

  test("12 Trigger NOT_MET", async ({ page }) => {
    await openDashboard(page, {
      analysis: "trigger-price-below",
      calendar: "empty",
      marketPrice: 156.28,
      mtf: "all-bullish",
      regime: "trending-bullish",
      includeTrades: false,
    });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-trigger")).toHaveText("条件未成立");
  });

  test("13 Event Risk", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-event")).toHaveText("LOW");
  });

  test("14 Risk", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-risk")).not.toHaveText("未取得");
  });

  test("15 DLL", async ({ page }) => {
    await openDashboard(page, { ...liveOpts, dailyLossLimitPercent: 3 });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-dll")).toHaveText("未到達");
  });

  test("16 freshness", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-freshness")).toHaveText("最新分析");
  });

  test("17 no Entry OK", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review").getByText("Entry OK")).toHaveCount(0);
  });

  test("18 no GO", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review").getByText("GO", { exact: true })).toHaveCount(0);
  });

  test("19 no Quality Score", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review").getByText("Quality Score")).toHaveCount(0);
  });

  test("20 no good/bad", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    for (const text of forbidden) {
      await expect(form.getByTestId("pretrade-review").getByText(text, { exact: true })).toHaveCount(0);
    }
  });

  test("21 registration ON saves Regime", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await expect(form.getByTestId("regime-snapshot-preview")).toContainText("トレンド");
    await fillAndSave(page, form, "T030-on");
    const record = await openSavedTrade(page, "T030-on");
    await expect(record.getByTestId("entry-context")).toBeVisible();
    await expect(record.getByTestId("regime-snapshot-kind")).toHaveText("トレンド");
    await expect(record.getByTestId("pretrade-action")).toHaveText("WAIT");
  });

  test("22 registration OFF no snapshot", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await form.getByLabel("現在のAI分析をこの取引に保存").uncheck();
    await expect(form.getByTestId("regime-snapshot-preview")).toHaveCount(0);
    await fillAndSave(page, form, "T030-off");
    const record = page.locator(".trade-record").filter({ hasText: "T030-off" });
    await expect(record.getByTestId("regime-snapshot")).toHaveCount(0);
    await expect(record.getByTestId("regime-snapshot-missing")).toBeVisible();
    await expect(record.getByTestId("pretrade-missing")).toBeVisible();
  });

  test("23 historical Regime fixed", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await fillAndSave(page, form, "T030-fixed");
    const record = await openSavedTrade(page, "T030-fixed");
    await expect(record.getByTestId("regime-snapshot-kind")).toHaveText("トレンド");
  });

  test("24 Live Regime change ignored", async ({ page }) => {
    await page.clock.install({ toFake: ["setTimeout"] });
    await page.clock.resume();
    const { setMarket } = await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await fillAndSave(page, form, "T030-live-change");
    setMarket({ regime: "range" });
    await advanceExistingRefresh(page);
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "分析" }).click();
    await expect(page.getByTestId("regime-kind")).toHaveText("レンジ");
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "トレード" }).click();
    const record = await openSavedTrade(page, "T030-live-change");
    await expect(record.getByTestId("regime-snapshot-kind")).toHaveText("トレンド");
  });

  test("25 CLOSED result does not rewrite", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await fillAndSave(page, form, "T030-close");
    const open = page.locator(".trade-record").filter({ hasText: "T030-close" });
    await open.getByRole("button", { name: "決済を記録" }).click();
    const closeForm = page.getByRole("form", { name: "決済記録" });
    await closeForm.getByLabel("決済価格").fill("157.2");
    await closeForm.getByRole("button", { name: "決済を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    const closed = page.locator(".trade-record").filter({ hasText: "T030-close" });
    await expect(closed.getByTestId("post-trade-review-result")).toHaveText("利益");
    await expect(closed.getByTestId("regime-snapshot-kind")).toHaveText("トレンド");
    await expect(closed.getByTestId("pretrade-action")).toHaveText("WAIT");
    await expect(closed.getByTestId("entry-context")).toBeVisible();
    await expect(closed.getByRole("heading", { name: "エントリー判断コンテキスト" })).toBeVisible();
  });

  test("26 legacy no Regime", async ({ page }) => {
    await openDashboard(page, { tradeSet: "entry-context", regime: "trending-bullish" });
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "トレード" }).click();
    const item = page.locator(".trade-record").filter({ hasText: "t030-legacy" });
    await expect(item.getByTestId("mtf-snapshot")).toBeVisible();
    await expect(item.getByTestId("pretrade-action")).toHaveText("WAIT");
    await expect(item.getByTestId("regime-snapshot-missing")).toHaveText("相場環境は保存されていません");
    await expect(item.getByTestId("regime-kind")).toHaveCount(0);
  });

  test("27 malformed Regime isolated", async ({ page }) => {
    await openDashboard(page, { tradeSet: "entry-context" });
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "トレード" }).click();
    const item = page.locator(".trade-record").filter({ hasText: "t030-malformed" });
    await expect(item.getByTestId("mtf-snapshot")).toBeVisible();
    await expect(item.getByTestId("pretrade-action")).toHaveText("WAIT");
    await expect(item.getByTestId("regime-snapshot-missing")).toBeVisible();
  });

  test("28 pair mismatch isolated", async ({ page }) => {
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await form.getByLabel("記録する通貨ペア").selectOption("EUR/JPY");
    await expect(form.getByTestId("regime-snapshot-preview")).toHaveCount(0);
    await expect(form.getByTestId("pretrade-review-regime")).toHaveText("未取得");
    await fillAndSave(page, form, "T030-eur");
    const record = page.locator(".trade-record").filter({ hasText: "T030-eur" });
    await expect(record.getByTestId("regime-snapshot-missing")).toBeVisible();
  });

  test("29 no extra Twelve request", async ({ page }) => {
    const { leaks } = await openDashboard(page, liveOpts);
    await openTradeForm(page);
    expect(leaks.filter(url => /twelvedata/i.test(url))).toEqual([]);
  });

  test("30 no extra OpenAI", async ({ page }) => {
    const { leaks } = await openDashboard(page, liveOpts);
    await openTradeForm(page);
    expect(leaks.filter(url => /openai/i.test(url))).toEqual([]);
  });

  test("31 no external real network", async ({ page }) => {
    const { leaks } = await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await fillAndSave(page, form, "T030-net");
    expect(leaks).toEqual([]);
  });

  test("32 390 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review")).toBeVisible();
    await assertNoOverflow(page);
  });

  test("33 1280 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDashboard(page, liveOpts);
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review")).toBeVisible();
    await assertNoOverflow(page);
  });
});
