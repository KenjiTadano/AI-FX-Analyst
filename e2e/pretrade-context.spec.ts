import { expect, test, type Page } from "@playwright/test";
import { advanceExistingRefresh, assertNoOverflow, pairSelect } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

async function openTradeForm(page: Page) {
  await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "トレード" }).click();
  await expect(page.getByRole("heading", { name: "トレード記録" })).toBeVisible();
  await page.getByRole("button", { name: "トレードを記録" }).click();
  return page.getByRole("form", { name: "新規トレード登録" });
}

async function fillAndSave(page: Page, form: ReturnType<Page["getByRole"]>, notes = "T022") {
  await form.getByLabel("エントリー価格").fill("156.18");
  await form.getByLabel("取引数量（通貨）").fill("1000");
  await form.getByLabel("メモ").fill(notes);
  await form.getByRole("button", { name: "取引を保存" }).click();
  await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
}

async function openSavedTrade(page: Page, notes = "T022") {
  const record = page.locator(".trade-record").filter({ hasText: notes });
  await expect(record).toBeVisible();
  const details = record.getByText("エントリー時AI分析");
  if (await details.count()) await details.click();
  return record;
}

test.describe("pre-trade context snapshot", () => {
  test("1 Trade登録 preview", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-preview")).toBeVisible();
    await expect(form.getByTestId("pretrade-review-direction")).toHaveText("SELL");
    await expect(form.getByTestId("pretrade-review-action")).toHaveText("WAIT");
    await expect(form.getByTestId("pretrade-review-readiness")).toHaveText("5 / 5");
    await expect(form.getByTestId("pretrade-review-trigger")).toHaveText("条件成立");
    await expect(form.getByText("現在のActionはWAITです。")).toBeVisible();
  });

  test("2 SELL + WAIT + MET snapshot save", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    const record = await openSavedTrade(page);
    await expect(record.getByTestId("pretrade-context")).toBeVisible();
    await expect(record.getByTestId("pretrade-direction")).toHaveText("SELL");
    await expect(record.getByTestId("pretrade-action")).toHaveText("WAIT");
    await expect(record.getByTestId("pretrade-trigger-status")).toHaveText("条件成立");
    await expect(record.getByTestId("pretrade-source-note")).toHaveText("エントリー時点の保存情報");
    await expect(record.getByText("正しいEntry")).toHaveCount(0);
    await expect(record.getByText("ルール遵守")).toHaveCount(0);
  });

  test("3 5/5 preserved", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    const record = await openSavedTrade(page);
    await expect(record.getByTestId("pretrade-readiness")).toHaveText("5 / 5");
  });

  test("4 Trigger observedValue saved", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    const record = await openSavedTrade(page);
    await expect(record.getByTestId("pretrade-observed")).toHaveText("156.18");
  });

  test("5 Trigger checkedAt saved", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    const record = await openSavedTrade(page);
    await expect(record.getByTestId("pretrade-checked-at")).not.toHaveText("");
    await expect(record.getByText("ローソク足確定")).toHaveCount(0);
    await expect(record.getByText("判定確認時刻")).toBeVisible();
  });

  test("6 Event unavailable shown 未取得", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-event-unavailable", calendar: "unavailable", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    const record = await openSavedTrade(page);
    await expect(record.getByTestId("pretrade-event")).toHaveText("未取得");
    await expect(record.getByTestId("pretrade-event")).not.toHaveText("LOW");
  });

  test("7 stale saved", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-stale", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    const record = await openSavedTrade(page);
    await expect(record.getByTestId("pretrade-stale")).toContainText("分析期限切れの状態で登録");
  });

  test("8 DLL reached saved", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18, dailyLossLimitPercent: 1 });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    const record = await openSavedTrade(page);
    await expect(record.getByTestId("pretrade-dll")).toContainText("Daily Loss Limit到達時に登録");
  });

  test("9 toggle OFF no context", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await form.getByLabel("現在のAI分析をこの取引に保存").uncheck();
    await expect(form.getByTestId("pretrade-preview")).toHaveCount(0);
    await fillAndSave(page, form, "T022-off");
    const record = page.locator(".trade-record").filter({ hasText: "T022-off" });
    await expect(record.getByTestId("pretrade-context")).toHaveCount(0);
    await expect(record.getByTestId("pretrade-missing")).toBeVisible();
  });

  test("10 edit preserves context", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    const record = page.locator(".trade-record").filter({ hasText: "T022" });
    await record.getByRole("button", { name: "編集" }).click();
    await page.getByRole("form", { name: "取引編集" }).getByLabel("メモ").fill("T022-edited");
    await page.getByRole("form", { name: "取引編集" }).getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    const edited = await openSavedTrade(page, "T022-edited");
    await expect(edited.getByTestId("pretrade-action")).toHaveText("WAIT");
    await expect(edited.getByTestId("pretrade-trigger-status")).toHaveText("条件成立");
  });

  test("11 close preserves context", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    const record = page.locator(".trade-record").filter({ hasText: "T022" });
    await record.getByRole("button", { name: "決済を記録" }).click();
    const closeForm = page.getByRole("form", { name: "決済記録" });
    await closeForm.getByLabel("決済価格").fill("155.9");
    await closeForm.getByRole("button", { name: "決済を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    const closed = page.locator(".trade-record").filter({ hasText: "T022" });
    await closed.getByText("エントリー時AI分析").click();
    await expect(closed.getByTestId("pretrade-action")).toHaveText("WAIT");
    await expect(closed.getByTestId("pretrade-trigger-status")).toHaveText("条件成立");
  });

  test("12 current market changes but journal snapshot unchanged", async ({ page }) => {
    await page.clock.install({ toFake: ["setTimeout"] });
    await page.clock.resume();
    const { setMarket } = await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    setMarket({ price: 157.5 });
    await advanceExistingRefresh(page);
    const record = await openSavedTrade(page);
    await expect(record.getByTestId("pretrade-observed")).toHaveText("156.18");
  });

  test("13 reanalysis changes live but snapshot unchanged", async ({ page }) => {
    await page.clock.install({ toFake: ["setTimeout"] });
    await page.clock.resume();
    const { setAnalysis } = await openDashboard(page, { analysis: "trigger-stale", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    setAnalysis("sell-wait");
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "分析" }).click();
    await page.getByTestId("entry-readiness-warning").getByRole("button", { name: "AI総合分析を更新" }).click();
    await expect(page.getByTestId("entry-trigger-watch")).toHaveCount(0);
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "トレード" }).click();
    const record = await openSavedTrade(page);
    await expect(record.getByTestId("pretrade-trigger-status")).toHaveText("条件成立");
  });

  test("14 pair mismatch no foreign context", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await form.getByLabel("記録する通貨ペア").selectOption("EUR/JPY");
    await expect(form.getByTestId("pretrade-preview")).toHaveCount(0);
    await fillAndSave(page, form, "T022-eur");
    const record = page.locator(".trade-record").filter({ hasText: "T022-eur" });
    await expect(record.getByTestId("pretrade-context")).toHaveCount(0);
    await expect(record.getByTestId("pretrade-missing")).toBeVisible();
    await expect(record.getByText("PRICE < 156.2")).toHaveCount(0);
  });

  test("15 legacy trade no context", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "トレード" }).click();
    const record = page.locator(".trade-record").filter({ hasText: "e2e" }).first();
    await record.getByText("エントリー時AI分析").click();
    await expect(record.getByTestId("pretrade-missing")).toBeVisible();
    await expect(record.getByTestId("pretrade-context")).toHaveCount(0);
  });

  test("16 390x844", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    const record = await openSavedTrade(page);
    await expect(record.getByTestId("pretrade-context")).toBeVisible();
    await assertNoOverflow(page);
  });

  test("17 1280x900", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await fillAndSave(page, form);
    const record = await openSavedTrade(page);
    await expect(record.getByTestId("pretrade-context")).toBeVisible();
    await assertNoOverflow(page);
  });
});
