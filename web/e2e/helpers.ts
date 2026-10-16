import { expect, type Browser, type Page } from "@playwright/test";

export const STAFF = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";

export type Role =
  "Organizer (#2)" | "Buyer 1 (#3)" | "Buyer 2 (#4)" | "Buyer 3 (#5)" | "Staff (#6)";

/** Opens a fresh browser context, connects a Hardhat dev wallet and signs in with SIWE. */
export async function openAs(browser: Browser, role: Role, path = "#/events"): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error(`[${role}] page error:`, err.message));
  await page.goto(`/${path}`);
  await page.getByLabel("Dev wallet").selectOption({ label: role });
  await expect(page.getByTestId("connected-address")).toContainText(role);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("signed-in")).toBeVisible();
  return page;
}

export async function shot(page: Page, name: string) {
  await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}
