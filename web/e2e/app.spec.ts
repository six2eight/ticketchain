import { expect, test } from "@playwright/test";

import { openAs, shot, STAFF } from "./helpers";

test.describe.configure({ mode: "serial" });

test("organizer creates an event and adds staff", async ({ browser }) => {
  const page = await openAs(browser, "Organizer (#2)", "#/organizer");
  await page.getByLabel("Name").fill("Playwright Fest");
  await page.getByLabel("Tickets").fill("50");
  await page.getByRole("button", { name: "Create event (wallet tx)" }).click();
  await expect(page.getByText("Create event: confirmed")).toBeVisible();

  const manage = page.getByTestId("manage-1");
  await expect(manage).toContainText("Playwright Fest");
  await expect(page.getByTestId("sold-1")).toHaveText("0/50");

  await manage.getByLabel("Staff wallet for event 1").fill(STAFF);
  await manage.getByRole("button", { name: "Add staff" }).click();
  await expect(manage.getByText("Add staff: confirmed")).toBeVisible();
  await expect(manage.getByText("0x976e…0aa9")).toBeVisible();

  await manage.getByText("Off-chain details").click();
  await manage.getByLabel("Venue").fill("ICCB, Dhaka");
  await manage.getByRole("button", { name: "Save details" }).click();
  await expect(manage.getByText("Saved")).toBeVisible();
  await shot(page, "organizer");
});

test("buyer buys a ticket, shows the rotating QR and staff admits it once", async ({ browser }) => {
  const buyer = await openAs(browser, "Buyer 1 (#3)");
  await expect(buyer.getByTestId("event-1")).toContainText("Playwright Fest");
  await expect(buyer.getByTestId("event-1")).toContainText("ICCB, Dhaka");
  await shot(buyer, "events");
  await buyer.getByTestId("event-1").getByRole("button", { name: "View" }).click();
  await expect(buyer.getByTestId("tickets-left")).toHaveText("50");
  await buyer.getByRole("button", { name: /Buy ticket/ }).click();
  await expect(buyer.getByText("Buy ticket: confirmed")).toBeVisible();
  await expect(buyer.getByTestId("tickets-left")).toHaveText("49");

  await buyer.getByRole("link", { name: "My Tickets" }).click();
  const card = buyer.getByTestId("ticket-1");
  await expect(card).toBeVisible();
  await expect(buyer.getByTestId("status-1")).toHaveText("Valid");
  await card.getByRole("button", { name: "Show door QR" }).click();
  await card.getByRole("button", { name: "Enable QR (one signature)" }).click();
  await expect(card.getByAltText("Check-in QR for ticket #1")).toBeVisible();
  await shot(buyer, "my-ticket-qr");
  const qr = buyer.getByTestId("qr-text-1");
  await expect(qr).not.toHaveValue("");
  const qrText = await qr.inputValue();

  const staff = await openAs(browser, "Staff (#6)", "#/scanner");
  await expect(staff.getByLabel("Event to scan")).toHaveValue("1");
  await staff.getByLabel("QR text").fill(qrText);
  await staff.getByRole("button", { name: "Verify" }).click();
  const result = staff.getByTestId("scan-result");
  await expect(result).toHaveAttribute("data-result", "ACCEPTED");
  await expect(result).toContainText("ADMIT");
  await shot(staff, "scanner-accepted");

  // Screenshot replay of the same QR.
  await staff.getByRole("button", { name: "Verify" }).click();
  await expect(result).toHaveAttribute("data-reason", "QR_REPLAYED");
  await shot(staff, "scanner-rejected");

  // The relayer marks it used on-chain; the indexer updates the ticket.
  await expect(buyer.getByTestId("status-1")).toHaveText("Used", { timeout: 30_000 });
  await expect(card.getByRole("button", { name: "Show door QR" })).toHaveCount(0);

  await staff.getByLabel("QR text").fill("hello");
  await staff.getByRole("button", { name: "Verify" }).click();
  await expect(result).toHaveAttribute("data-reason", "QR_MALFORMED");
});

test("resale respects the price cap and moves the ticket", async ({ browser }) => {
  const seller = await openAs(browser, "Buyer 2 (#4)", "#/events/1");
  await seller.getByRole("button", { name: /Buy ticket/ }).click();
  await expect(seller.getByText("Buy ticket: confirmed")).toBeVisible();
  await seller.getByRole("link", { name: "My Tickets" }).click();
  const card = seller.getByTestId("ticket-2");
  await card.getByText(/Sell this ticket/).click();
  await card.getByLabel("Resale price in ETH").fill("0.02");
  await expect(card.getByText("Above the organizer's price cap.")).toBeVisible();
  await expect(card.getByRole("button", { name: "List" })).toBeDisabled();
  await card.getByLabel("Resale price in ETH").fill("0.015");
  await card.getByRole("button", { name: "List" }).click();
  await expect(card.getByText("Listed for resale at")).toBeVisible({ timeout: 30_000 });

  const buyer = await openAs(browser, "Buyer 3 (#5)", "#/market");
  const listing = buyer.getByTestId("listing-2");
  await expect(listing).toContainText("0.015 ETH");
  await shot(buyer, "market");
  await listing.getByRole("button", { name: "Buy" }).click();
  await expect(listing.getByText("Buy resale ticket: confirmed")).toBeVisible();

  await buyer.getByRole("link", { name: "My Tickets" }).click();
  await expect(buyer.getByTestId("ticket-2")).toBeVisible({ timeout: 30_000 });
  await seller.reload();
  await expect(seller.getByText("You have no tickets yet.")).toBeVisible({ timeout: 30_000 });
});

test("organizer sees stats and withdraws revenue", async ({ browser }) => {
  const page = await openAs(browser, "Organizer (#2)", "#/organizer");
  await expect(page.getByTestId("sold-1")).toHaveText("2/50");
  await expect(page.getByTestId("checked-in-1")).toHaveText("1");
  await expect(page.getByTestId("withdrawable")).toHaveText("0.02 ETH");
  await page.getByRole("button", { name: "Withdraw" }).click();
  await expect(page.getByText("Withdraw: confirmed")).toBeVisible();
  await expect(page.getByTestId("withdrawable")).toHaveText("0 ETH");
  await shot(page, "organizer-stats");
});

test("pages that need a session ask the user to connect", async ({ page }) => {
  await page.goto("/#/tickets");
  await expect(page.getByText("Connect a wallet to continue.")).toBeVisible();
  await page.goto("/#/scanner");
  await expect(page.getByText("Connect a wallet to continue.")).toBeVisible();
});
