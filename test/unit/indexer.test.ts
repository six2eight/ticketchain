import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Indexer, type IndexerOptions } from "../../src/indexer/indexer.js";
import { applyEvent } from "../../src/indexer/projector.js";
import { silentLogger } from "../../src/lib/logger.js";
import { createTestDb, type TestDb } from "../helpers/db.js";
import { addr, ev, FakeChain } from "../helpers/fake-chain.js";

const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

let t: TestDb;
let chain: FakeChain;

function makeIndexer(overrides: Partial<IndexerOptions> = {}) {
  return new Indexer({
    db: t.db,
    chain,
    logger: silentLogger(),
    contractAddress: CONTRACT,
    startBlock: 1n,
    confirmations: 0,
    batchSize: 100,
    pollMs: 10,
    ...overrides,
  });
}

async function syncAll(indexer: Indexer) {
  for (let i = 0; i < 1000 && (await indexer.tick()); i++);
}

beforeEach(() => {
  t = createTestDb();
  chain = new FakeChain();
});
afterEach(() => t.cleanup());

/** Event 1 with staff, three tickets, one listing, one resale and one check-in. */
function mineScenario() {
  chain.mine(ev.created(1));
  chain.mine(ev.staff(1, addr.staff, true));
  chain.mine(ev.purchased(1, 1, addr.buyer1), ev.purchased(2, 1, addr.buyer2));
  chain.mine(ev.purchased(3, 1, addr.buyer3));
  chain.mine(ev.listed(2, addr.buyer2, 120n));
  chain.mine(ev.resold(2, addr.buyer2, addr.buyer3, 120n));
  chain.mine(ev.checkedIn(1, 1, addr.staff));
}

async function snapshot() {
  const [events, tickets, transfers, staff] = await Promise.all([
    t.db.event.findMany({ orderBy: { id: "asc" } }),
    t.db.ticket.findMany({ orderBy: { tokenId: "asc" } }),
    t.db.transfer.findMany({ orderBy: [{ block: "asc" }, { logIndex: "asc" }] }),
    t.db.staff.findMany(),
  ]);
  return {
    events: events.map(({ updatedAt: _u, ...e }) => e),
    tickets: tickets.map(({ usedAt, ...rest }) => ({ ...rest, used: usedAt !== null })),
    transfers: transfers.map(({ id: _id, ...rest }) => rest),
    staff,
  };
}

describe("Indexer", () => {
  it("syncs events, tickets, transfers and staff", async () => {
    mineScenario();
    const indexer = makeIndexer();
    await indexer.init();
    await syncAll(indexer);

    const s = await snapshot();
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({
      id: 1,
      organizer: addr.organizer,
      sold: 3,
      priceWei: "100",
    });
    expect(s.staff).toEqual([{ eventId: 1, wallet: addr.staff }]);
    expect(s.tickets.map((x) => [x.tokenId, x.owner, x.status, x.listedPriceWei])).toEqual([
      [1, addr.buyer1, "USED", null],
      [2, addr.buyer3, "VALID", null],
      [3, addr.buyer3, "VALID", null],
    ]);
    expect(s.transfers.map((x) => [x.tokenId, x.to, x.priceWei])).toEqual([
      [1, addr.buyer1, "100"],
      [2, addr.buyer2, "100"],
      [3, addr.buyer3, "100"],
      [2, addr.buyer3, "120"],
    ]);
    expect(indexer.status()).toMatchObject({ lastIndexedBlock: chain.head, lag: 0n });
    expect(await t.db.chainEvent.count()).toBe(8);
  });

  it("is idempotent: re-running from scratch and re-applying events changes nothing", async () => {
    mineScenario();
    const indexer = makeIndexer();
    await indexer.init();
    await syncAll(indexer);
    const before = await snapshot();

    // Re-index the same range again (e.g. state was lost but rows survived).
    await t.db.indexerState.update({ where: { id: 1 }, data: { lastIndexedBlock: 0n } });
    const again = makeIndexer();
    await again.init();
    await syncAll(again);
    expect(await snapshot()).toEqual(before);
    expect(await t.db.chainEvent.count()).toBe(8);

    // Apply every stored event a second time through the projector.
    const stored = await t.db.chainEvent.findMany({
      orderBy: [{ blockNumber: "asc" }, { logIndex: "asc" }],
    });
    await t.db.$transaction(async (tx) => {
      for (const e of stored) {
        await applyEvent(tx, { ...e, args: JSON.parse(e.args) as Record<string, unknown> });
      }
    });
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back a depth-1 reorg that removed a purchase", async () => {
    chain.mine(ev.created(1));
    chain.mine(ev.purchased(1, 1, addr.buyer1));
    const indexer = makeIndexer();
    await indexer.init();
    await syncAll(indexer);
    expect(await t.db.ticket.count()).toBe(1);

    chain.reorg(1);
    chain.mine(); // replacement block without the purchase
    await syncAll(indexer);

    expect(await t.db.ticket.count()).toBe(0);
    expect(await t.db.transfer.count()).toBe(0);
    expect((await t.db.event.findUniqueOrThrow({ where: { id: 1 } })).sold).toBe(0);
    expect(await t.db.chainEvent.count()).toBe(1);
    expect(indexer.status().lastIndexedBlock).toBe(chain.head);
  });

  it("rolls back a depth-3 reorg and replays the new branch", async () => {
    chain.mine(ev.created(1));
    chain.mine(ev.purchased(1, 1, addr.buyer1));
    const forkPoint = chain.head;
    chain.mine(ev.purchased(2, 1, addr.buyer2));
    chain.mine(ev.listed(1, addr.buyer1, 120n));
    chain.mine(ev.resold(1, addr.buyer1, addr.buyer3, 120n));

    const indexer = makeIndexer();
    await indexer.init();
    await syncAll(indexer);
    await t.db.event.update({ where: { id: 1 }, data: { description: "off-chain text" } });
    expect((await t.db.ticket.findUniqueOrThrow({ where: { tokenId: 1 } })).owner).toBe(
      addr.buyer3,
    );

    // New branch: token 2 goes to buyer3 instead, token 1 is never resold.
    chain.reorg(3);
    chain.mine(ev.purchased(2, 1, addr.buyer3));
    chain.mine();
    chain.mine();
    chain.mine();
    await syncAll(indexer);

    const s = await snapshot();
    expect(s.tickets.map((x) => [x.tokenId, x.owner, x.listedPriceWei])).toEqual([
      [1, addr.buyer1, null],
      [2, addr.buyer3, null],
    ]);
    expect(s.transfers.map((x) => [x.tokenId, x.to])).toEqual([
      [1, addr.buyer1],
      [2, addr.buyer3],
    ]);
    expect(s.events[0]).toMatchObject({ sold: 2, description: "off-chain text" });
    const remaining = await t.db.chainEvent.findMany({ where: { blockNumber: { gt: forkPoint } } });
    expect(remaining.map((e) => e.name)).toEqual(["TicketPurchased"]);
  });

  it("keeps an admitted ticket CHECKING_IN when its check-in event is rolled back", async () => {
    chain.mine(ev.created(1));
    chain.mine(ev.purchased(1, 1, addr.buyer1));
    const indexer = makeIndexer();
    await indexer.init();
    await syncAll(indexer);
    await t.db.ticket.update({ where: { tokenId: 1 }, data: { status: "CHECKING_IN" } });
    await t.db.txRequest.create({
      data: {
        idempotencyKey: "checkin:1",
        kind: "CHECKIN",
        to: CONTRACT,
        data: "0x",
        status: "CONFIRMED",
      },
    });

    chain.mine(ev.checkedIn(1, 1, addr.staff));
    await syncAll(indexer);
    expect((await t.db.ticket.findUniqueOrThrow({ where: { tokenId: 1 } })).status).toBe("USED");

    chain.reorg(1);
    chain.mine();
    await syncAll(indexer);
    expect((await t.db.ticket.findUniqueOrThrow({ where: { tokenId: 1 } })).status).toBe(
      "CHECKING_IN",
    );
  });

  it("halves the batch on range errors and grows it back", async () => {
    chain.mine(ev.created(1));
    chain.mineEmpty(40);
    chain.mine(ev.purchased(1, 1, addr.buyer1));
    chain.maxRange = 10;

    const indexer = makeIndexer({ batchSize: 64 });
    await indexer.init();
    await indexer.tick();
    // 64 -> 32 -> 16 -> 8 succeeds, then grows by 25 %.
    expect(chain.getLogsCalls.slice(0, 4).map(([f, to]) => Number(to - f) + 1)).toEqual([
      42, 32, 16, 8,
    ]);
    expect(indexer.currentBatchSize).toBe(10);

    await syncAll(indexer);
    expect(await t.db.ticket.count()).toBe(1);
    expect(indexer.status().lastIndexedBlock).toBe(chain.head);
  });

  it("respects confirmations", async () => {
    chain.mine(ev.created(1));
    chain.mine(ev.purchased(1, 1, addr.buyer1));
    chain.mineEmpty(2);
    const indexer = makeIndexer({ confirmations: 3 });
    await indexer.init();
    await syncAll(indexer);
    expect(indexer.status().lastIndexedBlock).toBe(1n);
    expect(await t.db.ticket.count()).toBe(0);
    chain.mine();
    await syncAll(indexer);
    expect(await t.db.ticket.count()).toBe(1);
  });

  it("resumes from lastIndexedBlock after a restart", async () => {
    chain.mine(ev.created(1));
    chain.mine(ev.purchased(1, 1, addr.buyer1));
    const first = makeIndexer();
    await first.init();
    await syncAll(first);

    chain.mine(ev.purchased(2, 1, addr.buyer2));
    chain.getLogsCalls = [];
    const second = makeIndexer();
    await second.init();
    await syncAll(second);

    expect(chain.getLogsCalls[0]).toEqual([3n, 3n]);
    expect(await t.db.ticket.count()).toBe(2);
  });

  it("recovers from transient RPC errors in the background loop", async () => {
    chain.mine(ev.created(1));
    chain.failNextGetLogs = 2;
    const indexer = makeIndexer();
    await indexer.init();
    indexer.start();
    await expect.poll(() => t.db.event.count(), { timeout: 10_000 }).toBe(1);
    await indexer.stop();
  });

  it("wipes chain-derived data when the contract address changes", async () => {
    chain.mine(ev.created(1));
    const indexer = makeIndexer();
    await indexer.init();
    await syncAll(indexer);
    await t.db.deviceKey.create({
      data: { tokenId: 1, deviceAddr: addr.buyer1, ownerAtReg: addr.buyer1, expiresAt: new Date() },
    });

    const other = makeIndexer({ contractAddress: "0x0000000000000000000000000000000000000Fff" });
    await other.init();
    expect(await t.db.event.count()).toBe(0);
    expect(await t.db.deviceKey.count()).toBe(0);
    expect(other.status().lastIndexedBlock).toBe(0n);
    await syncAll(other);
    expect(await t.db.event.count()).toBe(1);
  });

  it("starts over when the whole chain was replaced (local node restart)", async () => {
    chain.mine(ev.created(1));
    chain.mine(ev.purchased(1, 1, addr.buyer1));
    const indexer = makeIndexer();
    await indexer.init();
    await syncAll(indexer);

    chain = new FakeChain(); // same contract address, brand-new chain
    chain.mine(ev.created(1, { price: 7n }));
    chain.mineEmpty(2);
    const restarted = makeIndexer();
    await restarted.init();
    await syncAll(restarted);

    expect(await t.db.ticket.count()).toBe(0);
    expect((await t.db.event.findUniqueOrThrow({ where: { id: 1 } })).priceWei).toBe("7");
  });
});
