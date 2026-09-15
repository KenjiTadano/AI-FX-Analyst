import { expect, test } from "@playwright/test";
import { assertNoOverflow } from "./helpers/mock";
import { openDashboard } from "./helpers/goto";

test.describe("responsive", () => {
  test("11 mobile 390x844 overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page, { analysis: "long-condition" });
    await expect(page.getByTestId("daily-plan-pair")).toHaveText("USD/JPY");
    await expect(page.getByTestId("daily-plan-action")).toBeVisible();
    await expect(page.getByTestId("daily-plan-message")).toBeVisible();
    await expect(page.getByTestId("daily-plan-direction")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Entry条件" })).toBeVisible();
    await expect(page.getByTestId("daily-plan").getByText("156.20を下抜けたあと")).toBeVisible();
    await assertNoOverflow(page);
  });

  test("12 desktop 1280x900 overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDashboard(page, { analysis: "sell-wait" });
    await expect(page.getByTestId("daily-plan-hero")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Entry条件" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Risk", exact: true })).toBeVisible();
    await assertNoOverflow(page);
  });
});
