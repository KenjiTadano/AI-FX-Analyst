import { expect, type Page } from "@playwright/test";
import { installDashboardMocks, type DashboardScenario } from "./mock";

export async function openDashboard(page: Page, scenario: DashboardScenario = {}) {
  const { leaks } = await installDashboardMocks(page, scenario);
  const errors: string[] = [];
  page.on("pageerror", error => {
    if (!/hydration|ResizeObserver|AbortError|WebSocket connection/i.test(error.message)) errors.push(error.message);
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今日のトレード計画" })).toBeVisible();
  await expect(page.getByTestId("daily-plan")).toBeVisible();
  await expect(page.getByText("認証確認中…")).toHaveCount(0);
  return { leaks, errors };
}
