import { expect, test } from "@playwright/test";
import { openDashboard } from "./helpers/goto";

test.describe("performance regression", () => {
  test("13 Performance smoke", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "成績" }).click();
    await expect(page.getByRole("heading", { name: "トレード振り返り" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "分析時点からEntryまで" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "AI方向とEntry位置" })).toBeVisible();
  });

  test("14 period 30d changes the same fixture set", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "成績" }).click();
    await expect(page.getByRole("heading", { name: "トレード振り返り" })).toBeVisible();
    const summary = page.getByTestId("period-summary");
    await expect(summary).toContainText("全期間");
    const allText = await summary.textContent();
    await page.getByTestId("performance-period-30d").click();
    await expect(summary).toContainText("直近30日");
    await expect(summary).not.toHaveText(allText ?? "");
  });

  test("15 period 90d changes the same fixture set", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "成績" }).click();
    await expect(page.getByRole("heading", { name: "トレード振り返り" })).toBeVisible();
    const summary = page.getByTestId("period-summary");
    await page.getByTestId("performance-period-90d").click();
    await expect(summary).toContainText("直近90日");
    const d90 = await summary.textContent();
    await page.getByTestId("performance-period-30d").click();
    await expect(summary).toContainText("直近30日");
    await expect(summary).not.toHaveText(d90 ?? "");
  });

  test("16 Entry Timing is Trade-side not AI-direction", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "成績" }).click();
    await expect(page.getByRole("heading", { name: "トレード振り返り" })).toBeVisible();
    await expect(page.getByText("Trade side基準の値動きです")).toBeVisible();
    await expect(page.getByText("directionalEntryMovePips").first()).toBeVisible();
    await page.getByTestId("performance-period-30d").click();
    await expect(page.getByRole("heading", { name: "分析時点からEntryまで" })).toBeVisible();
  });

  test("17 AI Entry Context categories", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "成績" }).click();
    await expect(page.getByRole("heading", { name: "トレード振り返り" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "AI方向に進んだ後", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "AI方向と逆に動いた後" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "分析価格付近" })).toBeVisible();
    await expect(page.getByText("AI directionSignal 基準です")).toBeVisible();
  });

  test("18 WAIT direction snapshot still classifies AI Entry Context", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "成績" }).click();
    await expect(page.getByRole("heading", { name: "トレード振り返り" })).toBeVisible();
    await expect(page.getByText("Action（BUY/SELL/WAIT）とは別に方向だけを見ます")).toBeVisible();
    await expect(page.getByRole("heading", { name: "AI方向に進んだ後", exact: true })).toBeVisible();
  });

  test("19 contrary trade vs AI-direction move context are not mixed", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await page.getByRole("navigation", { name: "ダッシュボード表示" }).getByRole("button", { name: "成績" }).click();
    await expect(page.getByRole("heading", { name: "トレード振り返り" })).toBeVisible();
    await expect(page.getByText("Task015の「Trade方向に対する値動き」とは別指標です")).toBeVisible();
    await expect(page.getByRole("heading", { name: "AI方向に進んだ後", exact: true })).toBeVisible();
  });
});
