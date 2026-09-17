import { expect, test, type Page } from "@playwright/test";
import { assertNoOverflow } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

const forbidden = ["良いR", "悪いR", "成功R", "失敗R", "理想的", "最低ライン", "おすすめ", "Entry OK", "GO"];

async function openTrades(page: Page) {
  await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "トレード" }).click();
  await expect(page.getByRole("heading", { name: "トレード記録" })).toBeVisible();
}

async function openTradeForm(page: Page) {
  await openTrades(page);
  await page.getByRole("button", { name: "トレードを記録" }).click();
  return page.getByRole("form", { name: "新規トレード登録" });
}

function record(page: Page, notes: string) {
  return page.locator(".trade-record").filter({ hasText: notes });
}

test.describe("exit plan and r-multiple", () => {
  test("1 SL field", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", includeTrades: false });
    const form = await openTradeForm(page);
    await expect(form.getByLabel("初期損切り")).toBeVisible();
    await expect(form.getByTestId("exit-plan-sl-field")).toBeVisible();
  });

  test("2 TP field", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", includeTrades: false });
    const form = await openTradeForm(page);
    await expect(form.getByLabel("初期利確")).toBeVisible();
    await expect(form.getByTestId("exit-plan-tp-field")).toBeVisible();
  });

  test("3 AI prefill when available", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-above", marketPrice: 156.18, includeTrades: false });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("exit-plan-sl-field")).toHaveValue("155.9");
    await expect(form.getByTestId("exit-plan-tp-field")).toHaveValue("157.2");
    await expect(form.getByTestId("exit-plan-prefill-note")).toContainText("現在のAI分析から初期値を入力しています");
  });

  test("4 fields editable", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-above", marketPrice: 156.18, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await form.getByTestId("exit-plan-tp-field").fill("155.80");
    await expect(form.getByTestId("exit-plan-sl-field")).toHaveValue("154.90");
    await expect(form.getByTestId("exit-plan-tp-field")).toHaveValue("155.80");
  });

  test("5 BUY valid preview", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("売買方向").selectOption("long");
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await form.getByTestId("exit-plan-tp-field").fill("155.80");
    await expect(form.getByTestId("exit-plan-preview-risk")).toHaveText("30.0 pips");
    await expect(form.getByTestId("exit-plan-preview-rr")).toHaveText("2.00R");
  });

  test("6 SELL valid preview", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("売買方向").selectOption("short");
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByTestId("exit-plan-sl-field").fill("155.50");
    await form.getByTestId("exit-plan-tp-field").fill("154.60");
    await expect(form.getByTestId("exit-plan-preview-risk")).toHaveText("30.0 pips");
    await expect(form.getByTestId("exit-plan-preview-rr")).toHaveText("2.00R");
  });

  test("7 invalid BUY SL", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("売買方向").selectOption("long");
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByTestId("exit-plan-sl-field").fill("155.50");
    await expect(form.getByTestId("exit-plan-sl-field-error")).toContainText("買いの初期損切りはエントリー価格より下");
    await form.getByLabel("取引数量（通貨）").fill("1000");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toHaveCount(0);
  });

  test("8 invalid SELL SL", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("売買方向").selectOption("short");
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await expect(form.getByTestId("exit-plan-sl-field-error")).toContainText("売りの初期損切りはエントリー価格より上");
  });

  test("9 optional empty SL", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByLabel("取引数量（通貨）").fill("1000");
    await form.getByLabel("メモ").fill("T031-empty-sl");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    await expect(record(page, "T031-empty-sl").getByTestId("exit-plan-missing")).toHaveText("初期Exit Planは保存されていません");
  });

  test("10 optional TP", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByLabel("取引数量（通貨）").fill("1000");
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await form.getByLabel("メモ").fill("T031-sl-only");
    await expect(form.getByTestId("exit-plan-preview-risk")).toHaveText("30.0 pips");
    await expect(form.getByTestId("exit-plan-preview-rr")).toHaveText("—");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    await expect(record(page, "T031-sl-only").getByTestId("exit-plan-tp")).toHaveText("—");
    await expect(record(page, "T031-sl-only").getByTestId("exit-plan-planned-rr")).toHaveText("—");
  });

  test("11 risk pips preview", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await expect(form.getByTestId("exit-plan-preview-risk")).toHaveText("30.0 pips");
  });

  test("12 planned RR preview", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await form.getByTestId("exit-plan-tp-field").fill("155.80");
    await expect(form.getByTestId("exit-plan-preview-rr")).toHaveText("2.00R");
  });

  test("13 no good/bad wording", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-above", marketPrice: 156.18, includeTrades: false });
    const form = await openTradeForm(page);
    for (const text of forbidden) await expect(form.getByText(text, { exact: true })).toHaveCount(0);
  });

  test("14 no Entry OK", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-above", marketPrice: 156.18, includeTrades: false });
    const form = await openTradeForm(page);
    await expect(form.getByText("Entry OK")).toHaveCount(0);
  });

  test("15 registration saves Exit Plan", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByLabel("取引数量（通貨）").fill("1000");
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await form.getByTestId("exit-plan-tp-field").fill("155.80");
    await form.getByLabel("メモ").fill("T031-save");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    const item = record(page, "T031-save");
    await expect(item.getByTestId("exit-plan")).toBeVisible();
    await expect(item.getByTestId("exit-plan-sl")).toHaveText("154.9");
    await expect(item.getByTestId("exit-plan-risk")).toHaveText("30.0 pips");
    await expect(item.getByTestId("exit-plan-planned-rr")).toHaveText("2.00R");
    await expect(item.getByTestId("exit-plan-realized-r")).toHaveText("未決済");
  });

  test("16 AI toggle OFF still saves", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-above", calendar: "empty", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("現在のAI分析をこの取引に保存").uncheck();
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByLabel("取引数量（通貨）").fill("1000");
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await form.getByTestId("exit-plan-tp-field").fill("155.80");
    await form.getByLabel("メモ").fill("T031-toggle-off");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    const item = record(page, "T031-toggle-off");
    await expect(item.getByText("エントリー時AI分析：保存なし")).toBeVisible();
    await expect(item.getByTestId("exit-plan-sl")).toHaveText("154.9");
  });

  test("17 legacy no plan", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    const item = record(page, "t025-legacy");
    await expect(item.getByTestId("exit-plan-missing")).toHaveText("初期Exit Planは保存されていません");
    await expect(item.getByTestId("exit-plan-realized-r")).toHaveText("—");
  });

  test("18 OPEN plan display", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByLabel("取引数量（通貨）").fill("1000");
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await form.getByTestId("exit-plan-tp-field").fill("155.80");
    await form.getByLabel("メモ").fill("T031-open");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    const item = record(page, "T031-open");
    await expect(item.getByText("EXIT PLAN", { exact: true })).toBeVisible();
    await expect(item.getByTestId("exit-plan-entry")).toContainText("155.2");
    await expect(item.getByTestId("exit-plan-realized-r")).toHaveText("未決済");
  });

  test("19 CLOSED plan display", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByLabel("取引数量（通貨）").fill("1000");
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await form.getByTestId("exit-plan-tp-field").fill("155.80");
    await form.getByLabel("メモ").fill("T031-closed");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    await record(page, "T031-closed").getByRole("button", { name: "決済を記録" }).click();
    const closeForm = page.getByRole("form", { name: "決済記録" });
    await closeForm.getByLabel("決済価格").fill("155.80");
    await closeForm.getByRole("button", { name: "決済を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    const item = record(page, "T031-closed");
    await expect(item.getByText("EXIT PLAN / RESULT")).toBeVisible();
    await expect(item.getByTestId("exit-plan-exit")).toContainText("155.8");
    await expect(item.getByTestId("post-trade-review-realized-r")).toHaveText("+2.00R");
  });

  test("20 +2R BUY", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("売買方向").selectOption("long");
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByLabel("取引数量（通貨）").fill("1000");
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await form.getByTestId("exit-plan-tp-field").fill("155.80");
    await form.getByLabel("メモ").fill("T031-buy-2r");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    await record(page, "T031-buy-2r").getByRole("button", { name: "決済を記録" }).click();
    await page.getByRole("form", { name: "決済記録" }).getByLabel("決済価格").fill("155.80");
    await page.getByRole("form", { name: "決済記録" }).getByRole("button", { name: "決済を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    await expect(record(page, "T031-buy-2r").getByTestId("exit-plan-realized-r")).toHaveText("+2.00R");
  });

  test("21 +2R SELL", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("売買方向").selectOption("short");
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByLabel("取引数量（通貨）").fill("1000");
    await form.getByTestId("exit-plan-sl-field").fill("155.50");
    await form.getByTestId("exit-plan-tp-field").fill("154.60");
    await form.getByLabel("メモ").fill("T031-sell-2r");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    await record(page, "T031-sell-2r").getByRole("button", { name: "決済を記録" }).click();
    await page.getByRole("form", { name: "決済記録" }).getByLabel("決済価格").fill("154.60");
    await page.getByRole("form", { name: "決済記録" }).getByRole("button", { name: "決済を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    await expect(record(page, "T031-sell-2r").getByTestId("exit-plan-realized-r")).toHaveText("+2.00R");
  });

  test("22 -1.5R", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByLabel("取引数量（通貨）").fill("1000");
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await form.getByLabel("メモ").fill("T031-loss");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    await record(page, "T031-loss").getByRole("button", { name: "決済を記録" }).click();
    await page.getByRole("form", { name: "決済記録" }).getByLabel("決済価格").fill("154.75");
    await page.getByRole("form", { name: "決済記録" }).getByRole("button", { name: "決済を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    await expect(record(page, "T031-loss").getByTestId("exit-plan-realized-r")).toHaveText("-1.50R");
  });

  test("23 0R", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByLabel("取引数量（通貨）").fill("1000");
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await form.getByLabel("メモ").fill("T031-be");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    await record(page, "T031-be").getByRole("button", { name: "決済を記録" }).click();
    await page.getByRole("form", { name: "決済記録" }).getByLabel("決済価格").fill("155.20");
    await page.getByRole("form", { name: "決済記録" }).getByRole("button", { name: "決済を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    await expect(record(page, "T031-be").getByTestId("exit-plan-realized-r")).toHaveText("0.00R");
  });

  test("24 no clamp", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByLabel("取引数量（通貨）").fill("1000");
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await form.getByTestId("exit-plan-tp-field").fill("155.80");
    await form.getByLabel("メモ").fill("T031-noclamp");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    await record(page, "T031-noclamp").getByRole("button", { name: "決済を記録" }).click();
    await page.getByRole("form", { name: "決済記録" }).getByLabel("決済価格").fill("156.40");
    await page.getByRole("form", { name: "決済記録" }).getByRole("button", { name: "決済を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    await expect(record(page, "T031-noclamp").getByTestId("exit-plan-realized-r")).toHaveText("+4.00R");
  });

  test("25 missing plan R —", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    await expect(record(page, "t025-profit").getByTestId("post-trade-review-realized-r")).toHaveText("—");
  });

  test("26 edit preserves", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByLabel("取引数量（通貨）").fill("1000");
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await form.getByLabel("メモ").fill("T031-edit");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    await record(page, "T031-edit").getByRole("button", { name: "編集" }).click();
    const edit = page.getByRole("form", { name: "取引編集" });
    await edit.getByLabel("メモ").fill("T031-edit-after");
    await edit.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    await expect(record(page, "T031-edit-after").getByTestId("exit-plan-sl")).toHaveText("154.9");
  });

  test("27 close preserves", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByLabel("取引数量（通貨）").fill("1000");
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await form.getByLabel("メモ").fill("T031-close-keep");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    const before = await record(page, "T031-close-keep").getByTestId("exit-plan-sl").textContent();
    await record(page, "T031-close-keep").getByRole("button", { name: "決済を記録" }).click();
    await page.getByRole("form", { name: "決済記録" }).getByLabel("決済価格").fill("155.80");
    await page.getByRole("form", { name: "決済記録" }).getByRole("button", { name: "決済を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    await expect(record(page, "T031-close-keep").getByTestId("exit-plan-sl")).toHaveText(before ?? "");
  });

  test("28 current AI change ignored", async ({ page }) => {
    const { setAnalysis } = await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByLabel("取引数量（通貨）").fill("1000");
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await form.getByLabel("メモ").fill("T031-ai-ignore");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    setAnalysis("trigger-price-above");
    await expect(record(page, "T031-ai-ignore").getByTestId("exit-plan-sl")).toHaveText("154.9");
  });

  test("29 R coverage", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "成績" }).click();
    await expect(page.getByTestId("r-coverage")).toContainText("/");
  });

  test("30 Average R", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "成績" }).click();
    await expect(page.getByTestId("average-r")).toBeVisible();
    await expect(page.getByTestId("average-r")).not.toHaveText("");
  });

  test("31 Total R", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "成績" }).click();
    await expect(page.getByTestId("total-r")).toBeVisible();
  });

  test("32 cloud mapping if E2E supports", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByLabel("取引数量（通貨）").fill("1000");
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await form.getByLabel("メモ").fill("T031-cloud");
    await form.getByRole("button", { name: "取引を保存" }).click();
    await expect(page.getByText(/クラウドへ保存しました/)).toBeVisible();
    await expect(record(page, "T031-cloud").getByTestId("exit-plan")).toBeVisible();
  });

  test("33 malformed fail-soft", async ({ page }) => {
    await openDashboard(page, { tradeSet: "posttrade-review" });
    await openTrades(page);
    const item = record(page, "t031-malformed");
    await expect(item).toBeVisible();
    await expect(item.getByTestId("post-trade-review")).toBeVisible();
    await expect(item.getByTestId("exit-plan-realized-r")).toHaveText("—");
  });

  test("34 Readiness 5", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-above", calendar: "empty", marketPrice: 156.18 });
    await expect(page.getByTestId("entry-readiness")).toBeVisible();
    await expect(page.getByTestId("entry-readiness-count")).toHaveText("5 / 5 条件確認");
  });

  test("35 Trigger unchanged", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-above", calendar: "empty", marketPrice: 156.18, includeTrades: false });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-trigger")).toBeVisible();
  });

  test("36 Action WAIT preserved", async ({ page }) => {
    await openDashboard(page, { analysis: "trigger-price-above", calendar: "empty", marketPrice: 156.18, includeTrades: false });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("pretrade-review-action")).toHaveText("WAIT");
  });

  test("37 no extra external network", async ({ page }) => {
    const { leaks } = await openDashboard(page, { analysis: "unavailable", includeTrades: false });
    await openTradeForm(page);
    expect(leaks).toEqual([]);
  });

  test("38 390 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await form.getByLabel("エントリー価格", { exact: true }).fill("155.20");
    await form.getByTestId("exit-plan-sl-field").fill("154.90");
    await expect(form.getByTestId("exit-plan-preview")).toBeVisible();
    await assertNoOverflow(page);
  });

  test("39 1280 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDashboard(page, { analysis: "unavailable", marketPrice: 155.2, includeTrades: false });
    const form = await openTradeForm(page);
    await expect(form.getByTestId("exit-plan-preview")).toBeVisible();
    await assertNoOverflow(page);
  });
});
