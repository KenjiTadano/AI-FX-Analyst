import { expect, test, type Page } from "@playwright/test";
import { assertNoOverflow } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

const quality = ["良いEntry", "悪いEntry", "正しいEntry", "間違ったEntry", "ルール遵守", "ルール違反", "WAITを無視", "勝ちパターン"];

async function openTrades(page: Page) {
  await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "トレード" }).click();
  await expect(page.getByRole("heading", { name: "トレード記録" })).toBeVisible();
}

function record(page: Page, notes: string) {
  return page.locator(".trade-record").filter({ hasText: notes });
}

async function storedText(item: ReturnType<typeof record>, testId: string) {
  await expect(item.getByTestId(testId)).toHaveCount(1);
  return (await item.getByTestId(testId).textContent())?.trim() ?? "";
}

async function openTradeForm(page: Page) {
  await openTrades(page);
  await page.getByRole("button", { name: "トレードを記録" }).click();
  return page.getByRole("form", { name: "新規トレード登録" });
}

test.describe("post-trade review", () => {
  test("1 OPEN no Post Review", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    const open = record(page, "t025-open");
    await expect(open).toBeVisible();
    await expect(open.getByTestId("post-trade-review")).toHaveCount(0);
  });

  test("2 close Trade -> Review appears", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("売買方向").selectOption("short");
    await form.getByLabel("エントリー価格").fill("156.18");
    await form.getByLabel("取引数量（通貨）").fill("1000");
    await form.getByLabel("メモ").fill("T025-close");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    const open = record(page, "T025-close");
    await expect(open.getByTestId("post-trade-review")).toHaveCount(0);
    await expect(open.getByTestId("pretrade-action")).toHaveText("WAIT");
    const before = await storedText(open, "pretrade-trigger-status");
    await open.getByRole("button", { name: "決済を記録" }).click();
    const closeForm = page.getByRole("form", { name: "決済記録" });
    await closeForm.getByLabel("決済価格").fill("155.9");
    await closeForm.getByRole("button", { name: "決済を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    const closed = record(page, "T025-close");
    await expect(closed.getByTestId("post-trade-review")).toBeVisible();
    await expect(closed.getByTestId("pretrade-action")).toHaveText("WAIT");
    await expect(closed.getByTestId("pretrade-trigger-status")).toHaveText(before);
  });

  test("3 profit result", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    const item = record(page, "t025-profit");
    await expect(item.getByTestId("post-trade-review-result")).toHaveText("利益");
    await expect(item.getByTestId("post-trade-review-pnl")).toContainText("+");
  });

  test("4 loss result", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    const item = record(page, "t025-loss");
    await expect(item.getByTestId("post-trade-review-result")).toHaveText("損失");
  });

  test("5 flat result", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    const item = record(page, "t025-flat");
    await expect(item.getByTestId("post-trade-review-result")).toHaveText("損益なし");
  });

  test("6 holding duration", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    await expect(record(page, "t025-profit").getByTestId("post-trade-review-duration")).toHaveText("2時間35分");
    await expect(record(page, "t025-flat").getByTestId("post-trade-review-duration")).toHaveText("35分");
    await expect(record(page, "t025-buy-sell").getByTestId("post-trade-review-duration")).toHaveText("1日3時間");
  });

  test("7 SELL Trade + SELL direction", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    const item = record(page, "t025-profit");
    await expect(item.getByTestId("post-trade-review-side")).toHaveText("SELL");
    await expect(item.getByTestId("pretrade-direction")).toHaveText("SELL");
  });

  test("8 BUY Trade + SELL direction separate", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    const item = record(page, "t025-buy-sell");
    await expect(item.getByTestId("post-trade-review-side")).toHaveText("BUY");
    await expect(item.getByTestId("pretrade-direction")).toHaveText("SELL");
  });

  test("9 WAIT factual", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    const item = record(page, "t025-profit");
    await expect(item.getByTestId("pretrade-action")).toHaveText("WAIT");
    await expect(item.getByTestId("post-trade-review-labels")).toContainText("Action WAIT時に登録");
    await expect(item.getByText("WAITを無視")).toHaveCount(0);
  });

  test("10 readiness 5/5", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    await expect(record(page, "t025-profit").getByTestId("pretrade-readiness")).toHaveText("5 / 5");
    await expect(record(page, "t025-profit").getByText("Entry OK")).toHaveCount(0);
  });

  test("11 Trigger MET", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    await expect(record(page, "t025-profit").getByTestId("pretrade-trigger-status")).toHaveText("条件成立");
  });

  test("12 Trigger NOT_MET", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    await expect(record(page, "t025-equality").getByTestId("pretrade-trigger-status")).toHaveText("条件未成立");
  });

  test("13 equality 0 still NOT_MET", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    const item = record(page, "t025-equality");
    await expect(item.getByTestId("pretrade-trigger-status")).toHaveText("条件未成立");
    await expect(item.getByTestId("pretrade-distance")).toContainText("0 pips");
  });

  test("14 Event unavailable", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    const item = record(page, "t025-event");
    await expect(item.getByTestId("pretrade-event")).toHaveText("未取得");
    await expect(item.getByTestId("pretrade-event")).not.toHaveText("LOW");
    await expect(item.getByTestId("post-trade-review-result")).toHaveText("損失");
  });

  test("15 stale", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    await expect(record(page, "t025-stale").getByTestId("pretrade-freshness")).toHaveText("期限切れ分析");
  });

  test("16 DLL reached", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    const item = record(page, "t025-dll");
    await expect(item.getByTestId("pretrade-dll-state")).toHaveText("到達");
    await expect(item.getByText("ルール違反")).toHaveCount(0);
  });

  test("17 context labels", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    const labels = record(page, "t025-profit").getByTestId("post-trade-review-labels");
    await expect(labels).toContainText("Trigger条件成立時に登録");
    await expect(labels).toContainText("Action WAIT時に登録");
    await expect(labels).toContainText("最新分析時に登録");
    await expect(labels).toContainText("Event Risk LOW時に登録");
    await expect(labels).toContainText("Daily Loss Limit未到達時に登録");
  });

  test("18 legacy CLOSED result + context missing", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    const item = record(page, "t025-legacy");
    await expect(item.getByTestId("post-trade-review")).toBeVisible();
    await expect(item.getByTestId("pretrade-missing")).toContainText("保存されていません");
    await expect(item.getByTestId("post-trade-review-result")).toHaveText("利益");
  });

  test("19 pair mismatch context hidden", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    const item = record(page, "t025-mismatch");
    await expect(item.getByTestId("post-trade-review")).toBeVisible();
    await expect(item.getByTestId("pretrade-context")).toHaveCount(0);
    await expect(item.getByText("PRICE < 156.2")).toHaveCount(0);
    await expect(item.getByTestId("pretrade-missing")).toContainText("保存されていません");
  });

  test("20 profit fixture no positive quality wording", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    const item = record(page, "t025-profit").getByTestId("post-trade-review");
    for (const text of quality) await expect(item.getByText(text, { exact: true })).toHaveCount(0);
  });

  test("21 loss fixture no negative quality wording", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    const item = record(page, "t025-loss").getByTestId("post-trade-review");
    for (const text of quality) await expect(item.getByText(text, { exact: true })).toHaveCount(0);
  });

  test("22 snapshot unchanged after close", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-below", calendar: "empty", marketPrice: 156.18, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("売買方向").selectOption("short");
    await form.getByLabel("エントリー価格").fill("156.18");
    await form.getByLabel("取引数量（通貨）").fill("1000");
    await form.getByLabel("メモ").fill("T025-immutable");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    const open = record(page, "T025-immutable");
    const direction = await storedText(open, "pretrade-direction");
    const action = await storedText(open, "pretrade-action");
    const trigger = await storedText(open, "pretrade-trigger-status");
    await open.getByRole("button", { name: "決済を記録" }).click();
    const closeForm = page.getByRole("form", { name: "決済記録" });
    await closeForm.getByLabel("決済価格").fill("155.9");
    await closeForm.getByRole("button", { name: "決済を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    const closed = record(page, "T025-immutable");
    await expect(closed.getByTestId("pretrade-direction")).toHaveText(direction);
    await expect(closed.getByTestId("pretrade-action")).toHaveText(action);
    await expect(closed.getByTestId("pretrade-trigger-status")).toHaveText(trigger);
  });

  test("23 result edit/update context unchanged", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    const item = record(page, "t025-profit");
    const action = await storedText(item, "pretrade-action");
    const trigger = await storedText(item, "pretrade-trigger-status");
    await item.getByRole("button", { name: "編集" }).click();
    const form = page.getByRole("form", { name: "取引編集" });
    await form.getByLabel("決済価格").fill("155.5");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    const edited = record(page, "t025-profit");
    await expect(edited.getByTestId("pretrade-action")).toHaveText(action);
    await expect(edited.getByTestId("pretrade-trigger-status")).toHaveText(trigger);
    await expect(edited.getByTestId("post-trade-review")).toBeVisible();
  });

  test("24 390x844 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    await expect(record(page, "t025-profit").getByTestId("post-trade-review")).toBeVisible();
    await assertNoOverflow(page);
  });

  test("25 1280x900 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    await expect(record(page, "t025-profit").getByTestId("post-trade-review")).toBeVisible();
    await assertNoOverflow(page);
  });
});
