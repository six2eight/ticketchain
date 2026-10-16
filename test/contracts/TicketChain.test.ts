import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, keccak256, parseEther, toHex, zeroAddress } from "viem";

const { viem, networkHelpers } = await network.create();
const publicClient = await viem.getPublicClient();
const [admin, relayer, organizer, buyer1, buyer2, buyer3, staff, stranger] =
  await viem.getWalletClients();

const BASE_URI = "http://localhost:3000/metadata/";
const PRICE = parseEther("0.1");
const RESALE_CAP = parseEther("0.15");
const DAY = 24n * 60n * 60n;
const RELAYER_ROLE = keccak256(toHex("RELAYER_ROLE"));

type Wallet = NonNullable<typeof admin>;

function must<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}

const w = {
  admin: must(admin) as Wallet,
  relayer: must(relayer) as Wallet,
  organizer: must(organizer) as Wallet,
  buyer1: must(buyer1) as Wallet,
  buyer2: must(buyer2) as Wallet,
  buyer3: must(buyer3) as Wallet,
  staff: must(staff) as Wallet,
  stranger: must(stranger) as Wallet,
};

async function deploy() {
  const tc = await viem.deployContract("TicketChain", [BASE_URI]);
  await tc.write.grantRole([RELAYER_ROLE, w.relayer.account.address]);
  return tc;
}

type TC = Awaited<ReturnType<typeof deploy>>;

async function startTimeIn(seconds: bigint): Promise<bigint> {
  return BigInt(await networkHelpers.time.latest()) + seconds;
}

/** Creates event #1 as organizer with defaults; returns its start time. */
async function createDefaultEvent(
  tc: TC,
  opts: { price?: bigint; maxSupply?: number; resaleCap?: bigint } = {},
): Promise<bigint> {
  const startTime = await startTimeIn(DAY);
  await tc.write.createEvent(
    [
      "Dhaka Tech Fest 2026",
      opts.price ?? PRICE,
      opts.maxSupply ?? 100,
      startTime,
      opts.resaleCap ?? RESALE_CAP,
    ],
    { account: w.organizer.account },
  );
  return startTime;
}

async function buy(tc: TC, buyer: Wallet, eventId = 1n, value = PRICE) {
  await tc.write.buyTicket([eventId], { account: buyer.account, value });
}

describe("TicketChain", () => {
  let tc: TC;

  beforeEach(async () => {
    tc = await deploy();
  });

  describe("createEvent", () => {
    it("creates an event and emits EventCreated", async () => {
      const startTime = await startTimeIn(DAY);
      await viem.assertions.emitWithArgs(
        tc.write.createEvent(["Fest", PRICE, 100, startTime, RESALE_CAP], {
          account: w.organizer.account,
        }),
        tc,
        "EventCreated",
        [1n, getAddress(w.organizer.account.address), "Fest", PRICE, 100, startTime, RESALE_CAP],
      );

      const [org, price, cap, maxSupply, sold, start, exists] = await tc.read.events([1n]);
      assert.equal(org, getAddress(w.organizer.account.address));
      assert.equal(price, PRICE);
      assert.equal(cap, RESALE_CAP);
      assert.equal(maxSupply, 100);
      assert.equal(sold, 0);
      assert.equal(start, startTime);
      assert.equal(exists, true);
      assert.equal(await tc.read.nextEventId(), 2n);
    });

    it("allows resale disabled (cap 0) and a cap equal to price", async () => {
      const startTime = await startTimeIn(DAY);
      await tc.write.createEvent(["A", PRICE, 1, startTime, 0n]);
      await tc.write.createEvent(["B", PRICE, 1, startTime, PRICE]);
      assert.equal(await tc.read.nextEventId(), 3n);
    });

    it("reverts on maxSupply 0", async () => {
      const startTime = await startTimeIn(DAY);
      await viem.assertions.revertWithCustomError(
        tc.write.createEvent(["X", PRICE, 0, startTime, 0n]),
        tc,
        "InvalidParams",
      );
    });

    it("reverts on startTime in the past or now", async () => {
      const now = BigInt(await networkHelpers.time.latest());
      await viem.assertions.revertWithCustomError(
        tc.write.createEvent(["X", PRICE, 1, now - 1n, 0n]),
        tc,
        "InvalidParams",
      );
      // the next block's timestamp is now + 1; a startTime equal to it is not in the future
      await networkHelpers.time.setNextBlockTimestamp(now + 10n);
      await viem.assertions.revertWithCustomError(
        tc.write.createEvent(["X", PRICE, 1, now + 10n, 0n]),
        tc,
        "InvalidParams",
      );
    });

    it("reverts when resaleCap is below price", async () => {
      const startTime = await startTimeIn(DAY);
      await viem.assertions.revertWithCustomError(
        tc.write.createEvent(["X", PRICE, 1, startTime, PRICE - 1n]),
        tc,
        "InvalidParams",
      );
    });
  });

  describe("buyTicket", () => {
    beforeEach(async () => {
      await createDefaultEvent(tc, { maxSupply: 2 });
    });

    it("mints with the correct price and credits the organizer", async () => {
      await viem.assertions.emitWithArgs(
        tc.write.buyTicket([1n], { account: w.buyer1.account, value: PRICE }),
        tc,
        "TicketPurchased",
        [1n, 1n, getAddress(w.buyer1.account.address), PRICE],
      );
      assert.equal(await tc.read.ownerOf([1n]), getAddress(w.buyer1.account.address));
      assert.equal(await tc.read.ticketEvent([1n]), 1n);
      assert.equal(await tc.read.pendingWithdrawals([w.organizer.account.address]), PRICE);
      const [, , , , sold] = await tc.read.events([1n]);
      assert.equal(sold, 1);
    });

    it("reverts on wrong payment", async () => {
      await viem.assertions.revertWithCustomError(
        tc.write.buyTicket([1n], { account: w.buyer1.account, value: PRICE - 1n }),
        tc,
        "WrongPayment",
      );
      await viem.assertions.revertWithCustomError(
        tc.write.buyTicket([1n], { account: w.buyer1.account, value: PRICE + 1n }),
        tc,
        "WrongPayment",
      );
    });

    it("reverts when sold out", async () => {
      await buy(tc, w.buyer1);
      await buy(tc, w.buyer2);
      await viem.assertions.revertWithCustomError(
        tc.write.buyTicket([1n], { account: w.buyer3.account, value: PRICE }),
        tc,
        "SoldOut",
      );
    });

    it("reverts after start time", async () => {
      await networkHelpers.time.increase(DAY);
      await viem.assertions.revertWithCustomError(
        tc.write.buyTicket([1n], { account: w.buyer1.account, value: PRICE }),
        tc,
        "SalesClosed",
      );
    });

    it("reverts for an unknown event", async () => {
      await viem.assertions.revertWithCustomError(
        tc.write.buyTicket([99n], { account: w.buyer1.account, value: PRICE }),
        tc,
        "EventNotFound",
      );
    });
  });

  describe("staff", () => {
    beforeEach(async () => {
      await createDefaultEvent(tc);
    });

    it("organizer can add and remove staff", async () => {
      await viem.assertions.emitWithArgs(
        tc.write.addStaff([1n, w.staff.account.address], { account: w.organizer.account }),
        tc,
        "StaffUpdated",
        [1n, getAddress(w.staff.account.address), true],
      );
      assert.equal(await tc.read.isStaff([1n, w.staff.account.address]), true);

      await viem.assertions.emitWithArgs(
        tc.write.removeStaff([1n, w.staff.account.address], { account: w.organizer.account }),
        tc,
        "StaffUpdated",
        [1n, getAddress(w.staff.account.address), false],
      );
      assert.equal(await tc.read.isStaff([1n, w.staff.account.address]), false);
    });

    it("only the organizer can manage staff", async () => {
      await viem.assertions.revertWithCustomError(
        tc.write.addStaff([1n, w.staff.account.address], { account: w.stranger.account }),
        tc,
        "NotOrganizer",
      );
      await viem.assertions.revertWithCustomError(
        tc.write.removeStaff([1n, w.staff.account.address], { account: w.stranger.account }),
        tc,
        "NotOrganizer",
      );
    });

    it("reverts for an unknown event", async () => {
      await viem.assertions.revertWithCustomError(
        tc.write.addStaff([99n, w.staff.account.address], { account: w.organizer.account }),
        tc,
        "EventNotFound",
      );
    });
  });

  describe("resale", () => {
    beforeEach(async () => {
      await createDefaultEvent(tc);
      await buy(tc, w.buyer1); // token 1
    });

    it("lists at or below the cap", async () => {
      await viem.assertions.emitWithArgs(
        tc.write.listForResale([1n, RESALE_CAP], { account: w.buyer1.account }),
        tc,
        "TicketListed",
        [1n, getAddress(w.buyer1.account.address), RESALE_CAP],
      );
      const [seller, price] = await tc.read.listings([1n]);
      assert.equal(seller, getAddress(w.buyer1.account.address));
      assert.equal(price, RESALE_CAP);
    });

    it("reverts when listing above the cap", async () => {
      await viem.assertions.revertWithCustomError(
        tc.write.listForResale([1n, RESALE_CAP + 1n], { account: w.buyer1.account }),
        tc,
        "PriceAboveCap",
      );
    });

    it("reverts when a non-owner lists", async () => {
      await viem.assertions.revertWithCustomError(
        tc.write.listForResale([1n, PRICE], { account: w.buyer2.account }),
        tc,
        "NotOwner",
      );
    });

    it("reverts when resale is disabled", async () => {
      const startTime = await startTimeIn(DAY);
      await tc.write.createEvent(["NoResale", PRICE, 10, startTime, 0n], {
        account: w.organizer.account,
      });
      await buy(tc, w.buyer1, 2n); // token 2
      await viem.assertions.revertWithCustomError(
        tc.write.listForResale([2n, PRICE], { account: w.buyer1.account }),
        tc,
        "ResaleDisabled",
      );
    });

    it("reverts when listing after the event started", async () => {
      await networkHelpers.time.increase(DAY);
      await viem.assertions.revertWithCustomError(
        tc.write.listForResale([1n, PRICE], { account: w.buyer1.account }),
        tc,
        "SalesClosed",
      );
    });

    it("buyResale moves the token and credits the seller", async () => {
      await tc.write.listForResale([1n, RESALE_CAP], { account: w.buyer1.account });

      await viem.assertions.emitWithArgs(
        tc.write.buyResale([1n], { account: w.buyer2.account, value: RESALE_CAP }),
        tc,
        "TicketResold",
        [
          1n,
          getAddress(w.buyer1.account.address),
          getAddress(w.buyer2.account.address),
          RESALE_CAP,
        ],
      );
      assert.equal(await tc.read.ownerOf([1n]), getAddress(w.buyer2.account.address));
      assert.equal(await tc.read.pendingWithdrawals([w.buyer1.account.address]), RESALE_CAP);
      const [seller] = await tc.read.listings([1n]);
      assert.equal(seller, zeroAddress);
    });

    it("buyResale rejects wrong payment, the seller, and unlisted tokens", async () => {
      await viem.assertions.revertWithCustomError(
        tc.write.buyResale([1n], { account: w.buyer2.account, value: PRICE }),
        tc,
        "NotListed",
      );
      await tc.write.listForResale([1n, PRICE], { account: w.buyer1.account });
      await viem.assertions.revertWithCustomError(
        tc.write.buyResale([1n], { account: w.buyer2.account, value: PRICE + 1n }),
        tc,
        "WrongPayment",
      );
      await viem.assertions.revertWithCustomError(
        tc.write.buyResale([1n], { account: w.buyer1.account, value: PRICE }),
        tc,
        "InvalidParams",
      );
    });

    it("seller can cancel a listing; others cannot", async () => {
      await tc.write.listForResale([1n, PRICE], { account: w.buyer1.account });
      await viem.assertions.revertWithCustomError(
        tc.write.cancelListing([1n], { account: w.buyer2.account }),
        tc,
        "NotOwner",
      );
      await viem.assertions.emitWithArgs(
        tc.write.cancelListing([1n], { account: w.buyer1.account }),
        tc,
        "ListingCancelled",
        [1n],
      );
      await viem.assertions.revertWithCustomError(
        tc.write.cancelListing([1n], { account: w.buyer1.account }),
        tc,
        "NotListed",
      );
      await viem.assertions.revertWithCustomError(
        tc.write.buyResale([1n], { account: w.buyer2.account, value: PRICE }),
        tc,
        "NotListed",
      );
    });
  });

  describe("transfers", () => {
    beforeEach(async () => {
      await createDefaultEvent(tc);
      await buy(tc, w.buyer1);
    });

    it("direct transferFrom reverts", async () => {
      await viem.assertions.revertWithCustomError(
        tc.write.transferFrom([w.buyer1.account.address, w.buyer2.account.address, 1n], {
          account: w.buyer1.account,
        }),
        tc,
        "TransfersDisabled",
      );
    });

    it("safeTransferFrom reverts, even when approved", async () => {
      await tc.write.approve([w.buyer2.account.address, 1n], { account: w.buyer1.account });
      await viem.assertions.revertWithCustomError(
        tc.write.safeTransferFrom([w.buyer1.account.address, w.buyer2.account.address, 1n], {
          account: w.buyer2.account,
        }),
        tc,
        "TransfersDisabled",
      );
    });
  });

  describe("checkIn", () => {
    beforeEach(async () => {
      await createDefaultEvent(tc);
      await tc.write.addStaff([1n, w.staff.account.address], { account: w.organizer.account });
      await buy(tc, w.buyer1); // 1
      await buy(tc, w.buyer2); // 2
      await buy(tc, w.buyer3); // 3
    });

    it("works for staff, organizer and relayer", async () => {
      await viem.assertions.emitWithArgs(
        tc.write.checkIn([1n], { account: w.staff.account }),
        tc,
        "TicketCheckedIn",
        [1n, 1n, getAddress(w.staff.account.address)],
      );
      await tc.write.checkIn([2n], { account: w.organizer.account });
      await tc.write.checkIn([3n], { account: w.relayer.account });
      for (const id of [1n, 2n, 3n]) assert.equal(await tc.read.used([id]), true);
    });

    it("reverts for a random wallet", async () => {
      await viem.assertions.revertWithCustomError(
        tc.write.checkIn([1n], { account: w.stranger.account }),
        tc,
        "NotAuthorized",
      );
    });

    it("reverts for removed staff", async () => {
      await tc.write.removeStaff([1n, w.staff.account.address], { account: w.organizer.account });
      await viem.assertions.revertWithCustomError(
        tc.write.checkIn([1n], { account: w.staff.account }),
        tc,
        "NotAuthorized",
      );
    });

    it("reverts when checked in twice", async () => {
      await tc.write.checkIn([1n], { account: w.relayer.account });
      await viem.assertions.revertWithCustomError(
        tc.write.checkIn([1n], { account: w.relayer.account }),
        tc,
        "TicketUsed",
      );
    });

    it("reverts for a non-existent token", async () => {
      await viem.assertions.revertWithCustomError(
        tc.write.checkIn([99n], { account: w.relayer.account }),
        tc,
        "ERC721NonexistentToken",
      );
    });

    it("used ticket cannot be listed and its listing is removed", async () => {
      await tc.write.listForResale([1n, PRICE], { account: w.buyer1.account });
      await tc.write.checkIn([1n], { account: w.staff.account });

      const [seller] = await tc.read.listings([1n]);
      assert.equal(seller, zeroAddress);
      await viem.assertions.revertWithCustomError(
        tc.write.listForResale([1n, PRICE], { account: w.buyer1.account }),
        tc,
        "TicketUsed",
      );
      await viem.assertions.revertWithCustomError(
        tc.write.buyResale([1n], { account: w.buyer2.account, value: PRICE }),
        tc,
        "NotListed",
      );
    });
  });

  describe("withdraw", () => {
    beforeEach(async () => {
      await createDefaultEvent(tc);
    });

    it("organizer and seller receive the correct amounts", async () => {
      await buy(tc, w.buyer1);
      await buy(tc, w.buyer2);
      await tc.write.listForResale([1n, RESALE_CAP], { account: w.buyer1.account });
      await tc.write.buyResale([1n], { account: w.buyer3.account, value: RESALE_CAP });

      await viem.assertions.balancesHaveChanged(
        tc.write.withdraw({ account: w.organizer.account }),
        [{ address: w.organizer.account.address, amount: 2n * PRICE }],
      );
      await viem.assertions.balancesHaveChanged(tc.write.withdraw({ account: w.buyer1.account }), [
        { address: w.buyer1.account.address, amount: RESALE_CAP },
      ]);
      assert.equal(await publicClient.getBalance({ address: tc.address }), 0n);
      assert.equal(await tc.read.pendingWithdrawals([w.organizer.account.address]), 0n);
    });

    it("emits Withdrawal", async () => {
      await buy(tc, w.buyer1);
      await viem.assertions.emitWithArgs(
        tc.write.withdraw({ account: w.organizer.account }),
        tc,
        "Withdrawal",
        [getAddress(w.organizer.account.address), PRICE],
      );
    });

    it("reverts with nothing to withdraw", async () => {
      await viem.assertions.revertWithCustomError(
        tc.write.withdraw({ account: w.stranger.account }),
        tc,
        "NothingToWithdraw",
      );
    });

    it("is reentrancy-safe", async () => {
      const attacker = await viem.deployContract("ReentrantWithdrawer", [tc.address]);
      const startTime = await startTimeIn(DAY);
      await attacker.write.createEvent([PRICE, startTime]); // event 2, organizer = attacker
      await buy(tc, w.buyer1, 2n);
      await buy(tc, w.buyer2, 2n);

      // The re-entrant call reverts, so the outer transfer fails and nothing leaves the contract.
      await viem.assertions.revertWithCustomError(attacker.write.attack(), tc, "TransferFailed");
      assert.equal(await tc.read.pendingWithdrawals([attacker.address]), 2n * PRICE);
      assert.equal(await publicClient.getBalance({ address: tc.address }), 2n * PRICE);
    });
  });

  describe("metadata & admin", () => {
    it("tokenURI returns base + id", async () => {
      await createDefaultEvent(tc);
      await buy(tc, w.buyer1);
      assert.equal(await tc.read.tokenURI([1n]), `${BASE_URI}1`);
    });

    it("admin can set the base URI; others cannot", async () => {
      await createDefaultEvent(tc);
      await buy(tc, w.buyer1);
      await tc.write.setBaseURI(["https://example.com/m/"]);
      assert.equal(await tc.read.tokenURI([1n]), "https://example.com/m/1");
      await viem.assertions.revertWithCustomError(
        tc.write.setBaseURI(["x"], { account: w.stranger.account }),
        tc,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("supports ERC721 and AccessControl interfaces", async () => {
      assert.equal(await tc.read.supportsInterface(["0x80ac58cd"]), true); // ERC721
      assert.equal(await tc.read.supportsInterface(["0x7965db0b"]), true); // AccessControl
    });
  });
});
