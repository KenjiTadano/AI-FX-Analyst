import { expect, test, type Page } from "@playwright/test";
import { advanceExistingRefresh, assertNoOverflow } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

const forbidden = ["Entry OK", "GO", "今すぐ買う", "今すぐ売る", "正しいEntry", "ルール遵守", "取引禁止"];

async function openTradeForm(page: Page) {
  await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "トレード" }).click();
  await expect(page.getByRole("heading", { name: "トレード記録" })).toBeVisible();
  await page.getByRole("button", { name: "トレードを記録" }).click();
  return page.getByRole("form", { name: "新規トレード登録" });
}

async function fillAndSave(page: Page, form: ReturnType<Page["getByRole"]>, notes = "T024") {
  await form.getByLabel("エントリー価格").fill("156.18");
  await form.getByLabel("取引数量（通貨）").fill("1000");
  await form.getByLabel("メモ").fill(notes);
  const submit = form.getByRole("button", { name: "取引を保存" });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
}

async function openSavedTrade(page: Page, notes = "T024") {
  const record = page.locator(".trade-record").filter({ hasText: notes });
  await expect(record).toBeVisible();
  const details = record.getByText("エントリー時AI分析");
  if (await details.count()) await details.click();
  return record;
}

test.describe("pre-trade review", () => {
  test("1 Review visible", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review")).toBeVisible();
    await expect(form.getByText("PRE-TRADE REVIEW")).toBeVisible();
    await expect(form.getByRole("heading", { name: "エントリー前の最終確認" })).toBeVisible();
    await expect(form.getByTestId("pretrade-review-disclaimer")).toBeVisible();
  });

  test("2 SELL + WAIT + MET", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await form.getByLabel("売買方向").selectOption("short");
    await expect(form.getByTestId("pretrade-review-intent")).toContainText("SELLで登録予定");
    await expect(form.getByTestId("pretrade-review-direction")).toHaveText("SELL");
    await expect(form.getByTestId("pretrade-review-action")).toHaveText("WAIT");
    await expect(form.getByTestId("pretrade-review-trigger")).toHaveText("条件成立");
    await expect(form.getByTestId("pretrade-review-warning-action_wait")).toContainText("現在のActionはWAITです。");
    await fillAndSave(page, form, "T024-sell-wait");
    const record = await openSavedTrade(page, "T024-sell-wait");
    await expect(record.getByTestId("pretrade-direction")).toHaveText("SELL");
    await expect(record.getByTestId("pretrade-action")).toHaveText("WAIT");
    await expect(record.getByTestId("pretrade-trigger-status")).toHaveText("条件成立");
  });

  test("3 BUY + WAIT + MET", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-above", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await form.getByLabel("売買方向").selectOption("long");
    await expect(form.getByTestId("pretrade-review-intent")).toContainText("BUYで登録予定");
    await expect(form.getByTestId("pretrade-review-direction")).toHaveText("BUY");
    await expect(form.getByTestId("pretrade-review-action")).toHaveText("WAIT");
    await expect(form.getByTestId("pretrade-review-trigger")).toHaveText("条件成立");
    await fillAndSave(page, form, "T024-buy-wait");
    const record = await openSavedTrade(page, "T024-buy-wait");
    await expect(record.getByTestId("pretrade-direction")).toHaveText("BUY");
    await expect(record.getByTestId("pretrade-action")).toHaveText("WAIT");
    await expect(record.getByTestId("pretrade-trigger-status")).toHaveText("条件成立");
  });

  test("4 readiness 5/5", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-readiness")).toHaveText("5 / 5");
    await expect(form.getByText("Entry OK")).toHaveCount(0);
  });

  test("5 Trigger not_met warning", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.28 });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-trigger")).toHaveText("条件未成立");
    await expect(form.getByTestId("pretrade-review-warning-trigger_not_met")).toBeVisible();
    await expect(form.getByRole("button", { name: "取引を保存" })).toBeEnabled();
  });

  test("6 equality 0 pips still not_met", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.2 });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-trigger")).toHaveText("条件未成立");
    await expect(form.getByTestId("pretrade-review-distance")).toContainText("0 pips");
    await expect(form.getByText("条件成立", { exact: true })).toHaveCount(0);
  });

  test("7 Trigger unavailable", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketStale: true });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-trigger")).toHaveText("判定データ不足");
    await expect(form.getByTestId("pretrade-review-warning-trigger_unavailable")).toBeVisible();
  });

  test("8 Event HIGH", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "high", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-event")).toHaveText("HIGH");
    await expect(form.getByTestId("pretrade-review-warning-event_high")).toContainText("重要イベントリスクが高い状態です。");
    await expect(form.getByRole("button", { name: "取引を保存" })).toBeEnabled();
  });

  test("9 Event unavailable", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-event-unavailable", calendar: "unavailable", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-event")).toHaveText("未取得");
    await expect(form.getByTestId("pretrade-review-event")).not.toHaveText("LOW");
    await expect(form.getByTestId("pretrade-review-warning-event_unavailable")).toBeVisible();
  });

  test("10 stale", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-stale", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-freshness")).toHaveText("期限切れ分析");
    await expect(form.getByTestId("pretrade-review-warning-analysis_stale")).toBeVisible();
  });

  test("11 DLL reached", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18, dailyLossLimitPercent: 1 });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-warning-daily_loss_limit_reached")).toContainText("設定したDaily Loss Limitに到達しています");
    await expect(form.getByText("取引禁止")).toHaveCount(0);
    await expect(form.getByRole("button", { name: "取引を保存" })).toBeEnabled();
  });

  test("12 direction conflict", async ({ page }) => {
    await openDashboard(page, { analysis: "review-sell", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await form.getByLabel("売買方向").selectOption("long");
    await expect(form.getByTestId("pretrade-review-trade-side")).toHaveText("BUY");
    await expect(form.getByTestId("pretrade-review-direction")).toHaveText("SELL");
    await expect(form.getByTestId("pretrade-review-warning-direction_conflict")).toContainText("登録予定の方向とAI方向が異なります");
    await expect(form.getByText("間違った方向です")).toHaveCount(0);
  });

  test("13 toggle ON save message", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await expect(form.getByLabel("現在のAI分析をこの取引に保存")).toBeChecked();
    await expect(form.getByTestId("pretrade-review-save-message")).toContainText("取引登録時点の情報として保存されます");
  });

  test("14 toggle OFF not-save message", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await form.getByLabel("現在のAI分析をこの取引に保存").uncheck();
    await expect(form.getByTestId("pretrade-review")).toBeVisible();
    await expect(form.getByTestId("pretrade-review-save-message")).toContainText("取引履歴には保存されません");
    await expect(form.getByTestId("pretrade-review-warning-context_not_saved")).toBeVisible();
  });

  test("15 toggle OFF saved snapshot null", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await form.getByLabel("現在のAI分析をこの取引に保存").uncheck();
    await fillAndSave(page, form, "T024-off");
    const record = page.locator(".trade-record").filter({ hasText: "T024-off" });
    await expect(record.getByTestId("pretrade-context")).toHaveCount(0);
    await expect(record.getByTestId("pretrade-missing")).toBeVisible();
  });

  test("16 combined warnings still submit enabled", async ({ page }) => {
    await openDashboard(page, {
      analysis: "trigger-stale",
      calendar: "high",
      marketPrice: 156.28,
      dailyLossLimitPercent: 1,
    });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-warning-daily_loss_limit_reached")).toBeVisible();
    await expect(form.getByTestId("pretrade-review-warning-analysis_stale")).toBeVisible();
    await expect(form.getByTestId("pretrade-review-warning-event_high")).toBeVisible();
    await expect(form.getByTestId("pretrade-review-warning-action_wait")).toBeVisible();
    await expect(form.getByTestId("pretrade-review-warning-trigger_not_met")).toBeVisible();
    await expect(form.getByRole("button", { name: "取引を保存" })).toBeEnabled();
    await fillAndSave(page, form, "T024-combined");
    const record = await openSavedTrade(page, "T024-combined");
    await expect(record.getByTestId("pretrade-action")).toHaveText("WAIT");
    await expect(record.getByTestId("pretrade-trigger-status")).toHaveText("条件未成立");
  });

  test("17 review → registered snapshot consistency", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await form.getByLabel("売買方向").selectOption("short");
    const direction = await form.getByTestId("pretrade-review-direction").innerText();
    const action = await form.getByTestId("pretrade-review-action").innerText();
    const readiness = await form.getByTestId("pretrade-review-readiness").innerText();
    const trigger = await form.getByTestId("pretrade-review-trigger").innerText();
    const event = await form.getByTestId("pretrade-review-event").innerText();
    await fillAndSave(page, form, "T024-consistent");
    const record = await openSavedTrade(page, "T024-consistent");
    await expect(record.getByTestId("pretrade-direction")).toHaveText(direction);
    await expect(record.getByTestId("pretrade-action")).toHaveText(action);
    await expect(record.getByTestId("pretrade-readiness")).toHaveText(readiness);
    await expect(record.getByTestId("pretrade-trigger-status")).toHaveText(trigger);
    await expect(record.getByTestId("pretrade-event")).toHaveText(event);
  });

  test("18 market/live context update changes Review", async ({ page }) => {
    await page.clock.install({ toFake: ["setTimeout"] });
    await page.clock.resume();
    const { setMarket } = await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-trigger")).toHaveText("条件成立");
    setMarket({ price: 156.28 });
    await advanceExistingRefresh(page);
    await expect(form.getByTestId("pretrade-review-trigger")).toHaveText("条件未成立");
  });

  test("19 pair switch/mismatch no foreign context", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await form.getByLabel("記録する通貨ペア").selectOption("EUR/JPY");
    await expect(form.getByTestId("pretrade-review")).toBeVisible();
    await expect(form.getByTestId("pretrade-review-warning-context_unavailable")).toContainText("現在のAI判断状況を確認できません");
    await expect(form.getByText("PRICE < 156.2")).toHaveCount(0);
    await fillAndSave(page, form, "T024-eur");
    const record = page.locator(".trade-record").filter({ hasText: "T024-eur" });
    await expect(record.getByTestId("pretrade-context")).toHaveCount(0);
    await expect(record.getByTestId("pretrade-missing")).toBeVisible();
  });

  test("20 analysis unavailable still submit", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review")).toBeVisible();
    await expect(form.getByTestId("pretrade-review-warning-context_unavailable")).toBeVisible();
    await expect(form.getByRole("button", { name: "取引を保存" })).toBeEnabled();
    await fillAndSave(page, form, "T024-no-ai");
    const record = page.locator(".trade-record").filter({ hasText: "T024-no-ai" });
    await expect(record.getByTestId("pretrade-missing")).toBeVisible();
  });

  test("21 no forbidden Entry OK / GO / recommendation wording", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    for (const text of forbidden) {
      await expect(form.getByTestId("pretrade-review").getByText(text, { exact: true })).toHaveCount(0);
    }
  });

  test("22 390x844 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review")).toBeVisible();
    await assertNoOverflow(page);
  });

  test("23 1280x900 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18 });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review")).toBeVisible();
    await assertNoOverflow(page);
  });
});
