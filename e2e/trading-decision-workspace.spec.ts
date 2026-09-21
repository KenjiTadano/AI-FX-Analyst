import { expect, test } from "@playwright/test";
import { assertNoOverflow } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

test.describe("trading decision workspace", () => {
  test("1 workspace renders with decision summary fields", async ({ page }) => {
    const { leaks } = await openDashboard(page);
    await expect(page.getByTestId("trading-decision-workspace")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Trading Decision Workspace" })).toBeVisible();
    await expect(page.getByTestId("tdw-pair")).toBeVisible();
    await expect(page.getByTestId("tdw-rate")).toBeVisible();
    await expect(page.getByTestId("tdw-freshness")).toBeVisible();
    await expect(page.getByTestId("tdw-direction")).toBeVisible();
    await expect(page.getByTestId("tdw-action")).toBeVisible();
    await expect(page.getByTestId("tdw-confidence")).toBeVisible();
    await expect(page.getByTestId("tdw-ai-status")).toBeVisible();
    await expect(page.getByTestId("tdw-readiness")).toBeVisible();
    await expect(page.getByTestId("tdw-trigger")).toBeVisible();
    await expect(page.getByTestId("tdw-event-risk")).toBeVisible();
    expect(leaks).toEqual([]);
  });

  test("2 Direction and Action are separate fields", async ({ page }) => {
    await openDashboard(page);
    await expect(page.getByTestId("tdw-direction")).toBeVisible();
    await expect(page.getByTestId("tdw-action")).toBeVisible();
    const direction = await page.getByTestId("tdw-direction").innerText();
    const action = await page.getByTestId("tdw-action").innerText();
    expect(direction.length).toBeGreaterThan(0);
    expect(action.length).toBeGreaterThan(0);
  });

  test("3 market context and similar history layers", async ({ page }) => {
    await openDashboard(page);
    await expect(page.getByTestId("tdw-layer-market")).toBeVisible();
    await expect(page.getByTestId("tdw-mtf-15m")).toBeVisible();
    await expect(page.getByTestId("tdw-mtf-1h")).toBeVisible();
    await expect(page.getByTestId("tdw-mtf-4h")).toBeVisible();
    await expect(page.getByTestId("tdw-mtf-1day")).toBeVisible();
    await expect(page.getByTestId("tdw-regime")).toBeVisible();
    await expect(page.getByTestId("tdw-layer-history")).toBeVisible();
    const history = await page.getByTestId("tdw-layer-history").innerText();
    expect(history).not.toMatch(/期待値|P\/L \+|平均R|勝率\s*\d/);
  });

  test("4 existing detail sections remain below workspace", async ({ page }) => {
    await openDashboard(page);
    await expect(page.getByTestId("ia-decision-workspace")).toBeVisible();
    await expect(page.getByTestId("ia-analysis")).toBeVisible();
    await expect(page.getByTestId("daily-plan")).toBeVisible();
    await expect(page.getByTestId("entry-readiness")).toBeVisible();
    await expect(page.getByTestId("ia-market-detail")).toBeVisible();
    await expect(page.getByTestId("similar-historical-context")).toBeVisible();
  });

  test("5 no recommendation / composite language", async ({ page }) => {
    await openDashboard(page);
    const body = await page.getByTestId("trading-decision-workspace").innerText();
    expect(body).toContain("新しい売買判定やスコアは追加していません");
    expect(body).not.toContain("エントリーしてください");
    expect(body).not.toContain("Trade now");
    expect(body).not.toContain("期待値");
    expect(body).not.toMatch(/勝率\s*\d/);
  });

  test("6 mobile 390x844 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page);
    await expect(page.getByTestId("trading-decision-workspace")).toBeVisible();
    await assertNoOverflow(page);
  });

  test("7 jump links are keyboard focusable", async ({ page }) => {
    await openDashboard(page);
    const jump = page.getByTestId("tdw-jump-ai");
    await expect(jump).toBeVisible();
    await jump.focus();
    await expect(jump).toBeFocused();
  });
});
