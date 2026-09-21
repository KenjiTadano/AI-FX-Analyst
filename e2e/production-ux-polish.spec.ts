import { expect, test } from "@playwright/test";
import { assertNoOverflow } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

const nav = (page: import("@playwright/test").Page) =>
  page.getByRole("navigation", { name: "ダッシュボード表示" });

test.describe("production UX polish", () => {
  test("1–11 Analysis workspace primary fields and Direction != Action", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByTestId("trading-decision-workspace")).toBeVisible();
    const workspace = page.getByTestId("ia-decision-workspace");
    const analysis = page.getByTestId("ia-analysis");
    const workspaceBox = await workspace.boundingBox();
    const analysisBox = await analysis.boundingBox();
    expect(workspaceBox && analysisBox).toBeTruthy();
    expect(workspaceBox!.y).toBeLessThan(analysisBox!.y);

    await expect(page.getByTestId("tdw-pair")).toBeVisible();
    await expect(page.getByTestId("tdw-rate")).toBeVisible();
    await expect(page.getByTestId("tdw-freshness")).toBeVisible();
    await expect(page.getByTestId("tdw-direction")).toBeVisible();
    await expect(page.getByTestId("tdw-action")).toBeVisible();
    await expect(page.getByTestId("tdw-readiness")).toBeVisible();
    await expect(page.getByTestId("tdw-trigger")).toBeVisible();
    await expect(page.getByTestId("tdw-event-risk")).toBeVisible();

    const direction = (await page.getByTestId("tdw-direction").innerText()).trim();
    const action = (await page.getByTestId("tdw-action").innerText()).trim();
    expect(direction.length).toBeGreaterThan(0);
    expect(action.length).toBeGreaterThan(0);
    expect(direction).not.toEqual(action);
  });

  test("12 AI unavailable is not WAIT judgment", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable" });
    await expect(page.getByTestId("tdw-ai-status")).toBeVisible();
    await expect(page.getByTestId("tdw-ai-unavailable-note")).toBeVisible();
    const note = await page.getByTestId("tdw-ai-unavailable-note").innerText();
    expect(note).toMatch(/WAIT/);
    expect(note).toMatch(/判断した結果ではありません|unavailable|error/);
  });

  test("13–17 MTF Regime Similar History summary without outcomes", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByTestId("tdw-layer-market")).toBeVisible();
    await expect(page.getByTestId("tdw-mtf")).toBeVisible();
    await expect(page.getByTestId("tdw-regime")).toBeVisible();
    await expect(page.getByTestId("tdw-layer-history")).toBeVisible();
    const history = await page.getByTestId("tdw-layer-history").innerText();
    expect(history).not.toMatch(/期待値|平均R|勝率\s*\d|P\/L \+/);
    await expect(page.getByTestId("tdw-jump-similar")).toBeVisible();
  });

  test("18 existing details remain accessible", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByTestId("ia-analysis")).toBeVisible();
    await expect(page.getByTestId("daily-plan")).toBeVisible();
    await expect(page.getByTestId("entry-readiness")).toBeVisible();
    await expect(page.getByTestId("ia-market-detail")).toBeVisible();
    await expect(page.getByTestId("similar-historical-context")).toBeVisible();
    await expect(page.getByTestId("tdw-jump-ai")).toBeVisible();
    await expect(page.getByTestId("tdw-jump-setup")).toBeVisible();
    await expect(page.getByTestId("tdw-jump-market")).toBeVisible();
  });

  test("20–21 no new score or recommendation language", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    const body = await page.getByTestId("trading-decision-workspace").innerText();
    expect(body).not.toMatch(/composite score|trade score|期待値|エントリーしてください|Trade now/i);
    expect(body).toContain("新しい売買判定やスコアは追加していません");
  });

  test("22–26 mobile Analysis Chart Trade Performance no overflow", async ({ page }) => {
    for (const size of [
      { width: 390, height: 844 },
      { width: 430, height: 932 },
    ]) {
      await page.setViewportSize(size);
      await openDashboard(page, { analysis: "sell-wait", tradeSet: "performance-intelligence" });
      await assertNoOverflow(page);
      await nav(page).getByRole("button", { name: "チャート読取" }).click();
      await assertNoOverflow(page);
      await nav(page).getByRole("button", { name: "トレード" }).click();
      await assertNoOverflow(page);
      await nav(page).getByRole("button", { name: "成績" }).click();
      await assertNoOverflow(page);
      await nav(page).getByRole("button", { name: "分析" }).click();
    }
  });

  test("27–30 tabs keyboard focus and status text", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, { analysis: "sell-wait" });
    const tabs = nav(page);
    await expect(tabs).toBeVisible();
    const performance = tabs.getByRole("button", { name: "成績" });
    await performance.focus();
    await expect(performance).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(performance).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("market-freshness-label")).toBeVisible();
    const freshness = await page.getByTestId("market-freshness-label").innerText();
    expect(freshness).toMatch(/FRESH|STALE|ERROR|LOADING/);
  });

  test("31–34 loading unavailable error stale states", async ({ page }) => {
    await openDashboard(page, { analysis: "unavailable", marketUnavailable: true });
    await expect(page.getByTestId("tdw-freshness")).toBeVisible();
    await expect(page.getByTestId("tdw-ai-status")).toBeVisible();
    await expect(page.getByTestId("market-freshness-label")).toBeVisible();

    await openDashboard(page, { analysis: "sell-wait", marketStale: true });
    await expect(page.getByTestId("market-freshness-label")).toHaveText("STALE");
    await expect(page.getByTestId("market-stale-note")).toBeVisible();
  });

  test("35 trade form remains usable on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, { analysis: "sell-wait" });
    await nav(page).getByRole("button", { name: "トレード" }).click();
    await expect(page.getByRole("heading", { name: "トレード記録" })).toBeVisible();
    await assertNoOverflow(page);
  });

  test("header is production branded without task labels", async ({ page }) => {
    await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByTestId("product-badge")).toHaveText(/Reference/);
    await expect(page.getByTestId("product-badge")).not.toContainText(/TASK|MVP|033/i);
    await expect(page.getByRole("link", { name: /AI-FX-Analyst/ })).toBeVisible();
    const header = await page.locator(".app-header").innerText();
    expect(header).not.toMatch(/TASK\s*033|MVP\s*\//i);
  });

  test("desktop 1440x900 no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDashboard(page, { analysis: "sell-wait", tradeSet: "performance-intelligence" });
    await assertNoOverflow(page);
    await nav(page).getByRole("button", { name: "成績" }).click();
    await assertNoOverflow(page);
  });
});
