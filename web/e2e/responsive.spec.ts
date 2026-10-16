import { expect, test } from "@playwright/test";

test("mobile layout has no horizontal scroll and keeps the nav usable", async ({ page }) => {
  for (const path of ["#/events", "#/market", "#/organizer", "#/scanner"]) {
    await page.goto(`/${path}`);
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav).toBeVisible();
    await expect(page.locator("main")).not.toContainText("Loading");
    // Every tab is on screen without scrolling the nav.
    for (const tab of await nav.getByRole("link").all()) await expect(tab).toBeInViewport();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
  }
  await page.goto("/#/events");
  await expect(page.locator("main")).not.toContainText("Loading");
  await page.screenshot({ path: "test-results/screens/mobile-events.png", fullPage: true });
});
