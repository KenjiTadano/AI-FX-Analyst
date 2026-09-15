import { expect, test } from "@playwright/test";
import { openDashboard } from "./helpers/goto";

test.describe("dashboard regression", () => {
  test("1 Dashboard smoke", async ({ page }) => {
    const { leaks, errors } = await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByRole("heading", { name: "今日のトレード計画" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "AI総合判定" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "テクニカル分析" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "マーケット材料" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "トレード" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "成績" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "通貨ペア" })).toHaveValue("USD/JPY");
    expect(leaks).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("20 existing Dashboard regression", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByRole("heading", { name: "資金・リスク管理" })).toBeVisible();
    await expect(page.getByText("TWELVE DATA / CLOSED CANDLES")).toBeVisible();
    await expect(page.getByRole("heading", { name: "なぜ？" })).toBeVisible();
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "チャート読取" }).click();
    await expect(page.getByRole("heading", { name: "チャート読取" })).toBeVisible();
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "トレード" }).click();
    await expect(page.getByRole("heading", { name: "トレード記録" })).toBeVisible();
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "成績" }).click();
    await expect(page.getByRole("heading", { name: "表示期間" })).toBeVisible();
  });

  test("16 GBP/JPY pair smoke", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await page.locator("#currency-pair").selectOption("GBP/JPY");
    await expect(page.getByTestId("daily-plan-pair")).toHaveText("GBP/JPY");
  });
});
