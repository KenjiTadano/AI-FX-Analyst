import { expect, test, type Page } from "@playwright/test";
import { advanceExistingRefresh, assertNoOverflow } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

const rec = ["チャンス", "おすすめ", "Entry OK", "GO", "買い推奨", "勝ちパターン", "正しいEntry"];

async function openTradeForm(page: Page) {
  await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "トレード" }).click();
  await expect(page.getByRole("heading", { name: "トレード記録" })).toBeVisible();
  await page.getByRole("button", { name: "トレードを記録" }).click();
  return page.getByRole("form", { name: "新規トレード登録" });
}

async function fillAndSave(page: Page, form: ReturnType<Page["getByRole"]>, notes = "T027") {
  await form.getByLabel("エントリー価格").fill("156.18");
  await form.getByLabel("取引数量（通貨）").fill("1000");
  await form.getByLabel("メモ").fill(notes);
  await form.getByRole("button", { name: "取引を保存" }).click();
  await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
}

async function openSavedTrade(page: Page, notes = "T027") {
  const record = page.locator(".trade-record").filter({ hasText: notes });
  await expect(record).toBeVisible();
  const details = record.getByText("エントリー時AI分析");
  if (await details.count()) await details.click();
  return record;
}

test.describe("mtf snapshot", () => {
  test("1 register preview copies live MTF", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18, mtf: "all-bullish", includeTrades: false });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("mtf-snapshot-preview")).toContainText("上向き");
    await expect(form.getByTestId("mtf-snapshot-preview")).toContainText("すべての時間軸が上向きです");
  });

  test("2 all-bullish saved to journal", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18, mtf: "all-bullish", includeTrades: false });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    const record = await openSavedTrade(page);
    await expect(record.getByTestId("mtf-snapshot")).toBeVisible();
    await expect(record.getByTestId("mtf-snapshot-bias")).toHaveText("上向き");
    await expect(record.getByTestId("mtf-snapshot-alignment")).toHaveText("すべての時間軸が上向きです");
    await expect(record.getByTestId("mtf-snapshot-trend-1day")).toHaveText("上向き");
    await expect(record.getByTestId("mtf-snapshot-trend-15m")).toHaveText("上向き");
  });

  test("3 mixed saved with conflict", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18, mtf: "mixed", includeTrades: false });
    const form = await openTradeForm(page);
    await fillAndSave(page, form, "T027-mixed");
    const record = await openSavedTrade(page, "T027-mixed");
    await expect(record.getByTestId("mtf-snapshot-alignment")).toHaveText("時間軸で方向が混在しています");
    await expect(record.getByTestId("mtf-snapshot-conflicts")).toBeVisible();
  });

  test("4 toggle OFF still stores MTF via market context", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18, mtf: "all-bullish", includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("現在のAI分析をこの取引に保存").uncheck();
    await expect(form.getByTestId("mtf-snapshot-preview")).toHaveCount(0);
    await fillAndSave(page, form, "T027-off");
    const record = page.locator(".trade-record").filter({ hasText: "T027-off" });
    // Task104: AI snapshot optional; market context still captures deterministic MTF.
    await expect(record.getByTestId("market-context-snapshot")).toBeVisible();
    await expect(record.getByTestId("market-context-mtf")).toHaveText("saved");
    await expect(record.getByTestId("mtf-snapshot")).toBeVisible();
    await expect(record.getByTestId("mtf-snapshot-alignment")).toHaveText("すべての時間軸が上向きです");
  });

  test("5 pair mismatch does not copy USD MTF onto EUR trade", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18, mtf: "all-bullish", includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("記録する通貨ペア").selectOption("EUR/JPY");
    await expect(form.getByTestId("mtf-snapshot-preview")).toHaveCount(0);
    await fillAndSave(page, form, "T027-eur");
    const record = page.locator(".trade-record").filter({ hasText: "T027-eur" });
    await expect(record.getByTestId("mtf-snapshot-missing")).toBeVisible();
  });

  test("6 edit preserves stored MTF", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18, mtf: "all-bullish", includeTrades: false });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    const record = page.locator(".trade-record").filter({ hasText: "T027" });
    await record.getByRole("button", { name: "編集" }).click();
    await page.getByRole("form", { name: "取引編集" }).getByLabel("メモ").fill("T027-edited");
    await page.getByRole("form", { name: "取引編集" }).getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    const edited = await openSavedTrade(page, "T027-edited");
    await expect(edited.getByTestId("mtf-snapshot-alignment")).toHaveText("すべての時間軸が上向きです");
  });

  test("7 close shows stored MTF in Post-Trade Review", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18, mtf: "all-bullish", includeTrades: false });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    const record = page.locator(".trade-record").filter({ hasText: "T027" });
    await record.getByRole("button", { name: "決済を記録" }).click();
    const closeForm = page.getByRole("form", { name: "決済記録" });
    await closeForm.getByLabel("決済価格").fill("157.2");
    await closeForm.getByRole("button", { name: "決済を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    const closed = page.locator(".trade-record").filter({ hasText: "T027" });
    await expect(closed.getByTestId("post-trade-review")).toBeVisible();
    await expect(closed.getByTestId("post-trade-review-result")).toHaveText("利益");
    await expect(closed.getByTestId("mtf-snapshot")).toBeVisible();
    await expect(closed.getByTestId("mtf-snapshot-alignment")).toHaveText("すべての時間軸が上向きです");
    await expect(closed.getByTestId("mtf-snapshot-note")).toContainText("再評価していません");
  });

  test("8 live MTF change does not rewrite journal", async ({ page }) => {
    await page.clock.install({ toFake: ["setTimeout"] });
    await page.clock.resume();
    const { setMarket } = await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18, mtf: "all-bullish", includeTrades: false });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    setMarket({ mtf: "all-bearish" });
    await advanceExistingRefresh(page);
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "分析" }).click();
    await expect(page.getByTestId("mtf-alignment")).toHaveText("すべての時間軸が下向きです");
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "トレード" }).click();
    const record = await openSavedTrade(page);
    await expect(record.getByTestId("mtf-snapshot-alignment")).toHaveText("すべての時間軸が上向きです");
  });

  test("9 legacy closed trade shows missing MTF", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "トレード" }).click();
    const item = page.locator(".trade-record").filter({ hasText: "t025-profit" });
    await expect(item.getByTestId("post-trade-review")).toBeVisible();
    await expect(item.getByTestId("mtf-snapshot-missing")).toBeVisible();
    await expect(item.getByTestId("mtf-snapshot")).toHaveCount(0);
  });

  test("10 no recommendation wording", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18, mtf: "all-bullish", includeTrades: false });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    const record = await openSavedTrade(page);
    for (const text of rec) await expect(record.getByText(text, { exact: true })).toHaveCount(0);
  });

  test("11 no extra OpenAI or Twelve Data", async ({ page }) => {
    const { leaks } = await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18, mtf: "mixed", includeTrades: false });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    expect(leaks).toEqual([]);
  });

  test("12 390x844 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18, mtf: "mixed", includeTrades: false });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    const record = await openSavedTrade(page);
    await expect(record.getByTestId("mtf-snapshot")).toBeVisible();
    await assertNoOverflow(page);
  });

  test("13 1280x900 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18, mtf: "all-bullish", includeTrades: false });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    const record = await openSavedTrade(page);
    await expect(record.getByTestId("mtf-snapshot")).toBeVisible();
    await assertNoOverflow(page);
  });
});
