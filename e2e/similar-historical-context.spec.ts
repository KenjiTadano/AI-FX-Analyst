import { expect, test } from "@playwright/test";
import { assertNoOverflow } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

test.describe("similar historical context", () => {
  test("1 panel visible with disclaimers on Analysis market section", async ({ page }) => {
    const { leaks } = await openDashboard(page, { tradeSet: "performance-intelligence" });
    await expect(page.getByTestId("ia-market-detail")).toBeVisible();
    await expect(page.getByTestId("similar-historical-context")).toBeVisible();
    await expect(page.getByRole("heading", { name: "類似する過去コンテキスト" })).toBeVisible();
    await expect(page.getByTestId("similar-disclaimer")).toContainText("同じ結果になることを意味しません");
    await expect(page.getByTestId("similar-outcome-note")).toContainText("類似度の計算には使用していません");
    await expect(page.getByTestId("similar-current-pair")).toContainText("USD/JPY");
    const body = await page.getByTestId("similar-historical-context").innerText();
    expect(body).not.toContain("上がりそう");
    expect(body).not.toContain("期待値が高い");
    expect(body).not.toContain("買いに有利");
    expect(body).not.toMatch(/勝率\s*\d/);
    expect(leaks).toEqual([]);
  });

  test("2 empty or list state is explicit", async ({ page }) => {
    await openDashboard(page, { tradeSet: "performance-intelligence" });
    const empty = page.getByTestId("similar-empty");
    const list = page.getByTestId("similar-match-list");
    const emptyVisible = await empty.isVisible().catch(() => false);
    const listVisible = await list.isVisible().catch(() => false);
    expect(emptyVisible || listVisible).toBe(true);
    if (emptyVisible) {
      const text = await empty.innerText();
      expect(
        /現在のMarket Context|Original|同じ通貨ペア|比較可能な項目|類似度/.test(text),
      ).toBe(true);
    }
  });

  test("3 mobile 390x844 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, { tradeSet: "performance-intelligence" });
    await expect(page.getByTestId("similar-historical-context")).toBeVisible();
    await assertNoOverflow(page);
  });
});
