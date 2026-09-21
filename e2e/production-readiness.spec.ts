import { expect, test } from "@playwright/test";
import { assertNoOverflow } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

test.describe("production readiness", () => {
  test("market provider error stays usable and is not a trade signal", async ({ page }) => {
    const { leaks } = await openDashboard(page, { analysis: "unavailable", marketUnavailable: true });
    await expect(page.getByText("市場データを取得できませんでした").first()).toBeVisible();
    await expect(page.getByTestId("daily-plan-status")).toBeVisible();
    const status = await page.getByTestId("daily-plan-status").innerText();
    expect(status).not.toMatch(/^BUY$|^SELL$/);
    expect(leaks).toEqual([]);
  });

  test("AI unavailable is not converted into BUY or SELL", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable" });
    await expect(page.getByText("現在AI総合分析を取得できません").first()).toBeVisible();
    const action = await page.getByTestId("daily-plan-action").innerText();
    expect(action.trim()).not.toMatch(/^BUY$|^SELL$/);
    await expect(page.getByTestId("daily-plan-status")).toHaveText("未取得");
    await expect(page.getByText("AIがWAITと判断")).toHaveCount(0);
  });

  test("mobile and desktop have no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, { analysis: "sell-wait" });
    await assertNoOverflow(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await assertNoOverflow(page);
  });
});
