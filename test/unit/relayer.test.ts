import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Hex } from "../../src/chain/ports.js";
import { silentLogger } from "../../src/lib/logger.js";
import { bump, parseAttempts, Relayer, type RelayerOptions } from "../../src/relayer/relayer.js";
import { testClock } from "../helpers/app.js";
import { createTestDb, type TestDb } from "../helpers/db.js";
import { FakeTxSender } from "../helpers/fake-sender.js";

const TO = "0x5fbdb2315678afecb367f032d93f642f64180aa3" as Hex;
const GWEI = 1_000_000_000n;

let t: TestDb;
let sender: FakeTxSender;
let clock: ReturnType<typeof testClock>;

function makeRelayer(overrides: Partial<RelayerOptions> = {}) {
  return new Relayer({
    db: t.db,
    sender,
    logger: silentLogger(),
    pollMs: 20,
    stuckMs: 30_000,
    maxFeePerGasWei: 200n * GWEI,
    lowBalanceWei: 5n * 10n ** 16n,
    clock,
    ...overrides,
  });
}

const job = (n: number) => ({
  idempotencyKey: `checkin:${n}`,
  kind: "CHECKIN",
  to: TO,
  data: `0x${n.toString(16).padStart(8, "0")}` as Hex,
});

const row = (key: string) => t.db.txRequest.findUniqueOrThrow({ where: { idempotencyKey: key } });

beforeEach(() => {
  t = createTestDb();
  sender = new FakeTxSender();
  clock = testClock(1_700_000_000_000);
});
afterEach(() => t.cleanup());

describe("Relayer", () => {
  it("enqueue is idempotent", async () => {
    const r = makeRelayer();
    const a = await r.enqueue(job(1));
    const b = await r.enqueue(job(1));
    const [c, d] = await Promise.all([r.enqueue(job(2)), r.enqueue(job(2))]);
    expect(b.id).toBe(a.id);
    expect(d.id).toBe(c.id);
    expect(await t.db.txRequest.count()).toBe(2);
  });

  it("sends queued jobs with sequential nonces and confirms them", async () => {
    sender.chainNonce = 5;
    const r = makeRelayer();
    for (const n of [1, 2, 3]) await r.enqueue(job(n));
    await r.processOnce();

    expect(sender.broadcasts.map((b) => b.nonce)).toEqual([5, 6, 7]);
    const rows = await t.db.txRequest.findMany({ orderBy: { id: "asc" } });
    // One round submits, then the monitor step of the same round finds the receipts.
    expect(rows.map((x) => [x.nonce, x.status])).toEqual([
      [5, "CONFIRMED"],
      [6, "CONFIRMED"],
      [7, "CONFIRMED"],
    ]);
    await r.processOnce();
    expect(sender.broadcasts).toHaveLength(3);
  });

  it("adds a 20 % gas buffer and records the attempt", async () => {
    const r = makeRelayer();
    await r.enqueue(job(1));
    await r.processOnce();
    const [attempt] = parseAttempts(await row("checkin:1"));
    expect(attempt).toMatchObject({
      nonce: 0,
      gas: "60000",
      maxFeePerGas: (10n * GWEI).toString(),
    });
  });

  it("bumps a stuck tx with the same nonce and >= 12.5 % higher fees", async () => {
    sender.autoMine = false;
    const r = makeRelayer();
    await r.enqueue(job(1));
    await r.processOnce();
    const first = parseAttempts(await row("checkin:1"));
    expect(first).toHaveLength(1);

    clock.advance(10_000);
    await r.processOnce();
    expect(parseAttempts(await row("checkin:1"))).toHaveLength(1); // not stuck yet

    clock.advance(25_000);
    await r.processOnce();
    const attempts = parseAttempts(await row("checkin:1"));
    expect(attempts).toHaveLength(2);
    const [a, b] = attempts as [(typeof attempts)[0], (typeof attempts)[0]];
    expect(b.nonce).toBe(a.nonce);
    expect(BigInt(b.maxFeePerGas) * 1000n).toBeGreaterThanOrEqual(BigInt(a.maxFeePerGas) * 1125n);
    expect(BigInt(b.maxPriorityFeePerGas) * 1000n).toBeGreaterThanOrEqual(
      BigInt(a.maxPriorityFeePerGas) * 1125n,
    );
    expect(b.hash).not.toBe(a.hash);

    sender.mine(); // the replacement wins
    await r.processOnce();
    const done = await row("checkin:1");
    expect(done.status).toBe("CONFIRMED");
    expect(done.lastHash).toBe(b.hash);
  });

  it("never bumps above RELAYER_MAX_FEE_GWEI", async () => {
    sender.autoMine = false;
    sender.fees = { maxFeePerGas: 190n * GWEI, maxPriorityFeePerGas: 2n * GWEI };
    const r = makeRelayer();
    await r.enqueue(job(1));
    await r.processOnce();
    for (let i = 0; i < 3; i++) {
      clock.advance(31_000);
      await r.processOnce();
    }
    const attempts = parseAttempts(await row("checkin:1"));
    expect(attempts.every((a) => BigInt(a.maxFeePerGas) <= 200n * GWEI)).toBe(true);
    expect(attempts.at(-1)!.maxFeePerGas).toBe((200n * GWEI).toString());
    expect(attempts).toHaveLength(2); // at the cap the last attempt is rebroadcast, not duplicated
    expect(bump(1000n)).toBe(1126n);
  });

  it("resyncs the nonce from the chain on 'nonce too low'", async () => {
    const r = makeRelayer();
    await r.enqueue(job(1));
    await r.processOnce();
    expect(sender.broadcasts.at(-1)?.nonce).toBe(0);

    sender.consumeNoncesExternally(3); // someone else used nonces 1..3
    await r.enqueue(job(2));
    await r.processOnce();

    expect(sender.broadcasts.at(-1)?.nonce).toBe(4);
    const second = await row("checkin:2");
    expect(second.nonce).toBe(4);
    expect(parseAttempts(second)).toHaveLength(1);
    await r.processOnce();
    expect((await row("checkin:2")).status).toBe("CONFIRMED");
  });

  it("resumes QUEUED and SUBMITTED work after a restart without duplicates", async () => {
    sender.autoMine = false;
    const before = makeRelayer();
    await before.enqueue(job(1));
    await before.processOnce(); // SUBMITTED, waiting in the mempool
    await before.enqueue(job(2)); // QUEUED, process "crashed" before sending

    const after = makeRelayer();
    await after.processOnce();
    expect(sender.broadcasts.map((b) => b.nonce)).toEqual([0, 1]);

    sender.mine();
    await after.processOnce();
    const rows = await t.db.txRequest.findMany({ orderBy: { id: "asc" } });
    expect(rows.map((x) => x.status)).toEqual(["CONFIRMED", "CONFIRMED"]);
    expect(sender.broadcasts).toHaveLength(2);
  });

  it("does not reuse the nonce of a signed-but-unsent tx after a crash", async () => {
    sender.failNextBroadcast = new Error("connection reset");
    const before = makeRelayer();
    await before.enqueue(job(1));
    await before.processOnce();
    expect((await row("checkin:1")).status).toBe("SUBMITTED");
    expect(sender.broadcasts).toHaveLength(0);

    const after = makeRelayer();
    await after.enqueue(job(2));
    await after.processOnce();
    expect((await row("checkin:2")).nonce).toBe(1);

    // job 1 is rebroadcast once it looks stuck; then both confirm in nonce order.
    clock.advance(31_000);
    await after.processOnce();
    await after.processOnce();
    expect((await t.db.txRequest.findMany()).map((x) => x.status)).toEqual([
      "CONFIRMED",
      "CONFIRMED",
    ]);
  });

  it("marks TicketUsed as REVERTED and other estimate reverts as FAILED", async () => {
    sender.revertReason = (call) =>
      call.data === job(1).data
        ? "TicketUsed"
        : call.data === job(2).data
          ? "NotAuthorized"
          : undefined;
    const r = makeRelayer();
    await r.enqueue(job(1));
    await r.enqueue(job(2));
    await r.enqueue(job(3));
    await r.processOnce();
    expect(await row("checkin:1")).toMatchObject({ status: "REVERTED", error: "TicketUsed" });
    expect(await row("checkin:2")).toMatchObject({ status: "FAILED", error: "NotAuthorized" });
    expect((await row("checkin:3")).nonce).toBe(0); // reverted jobs did not consume a nonce
  });

  it("marks an on-chain revert as REVERTED", async () => {
    sender.revertOnChain = () => true;
    const r = makeRelayer();
    await r.enqueue(job(1));
    await r.processOnce();
    await r.processOnce();
    expect(await row("checkin:1")).toMatchObject({ status: "REVERTED", error: "REVERTED_ONCHAIN" });
  });

  it("reports a low balance", async () => {
    const r = makeRelayer();
    expect(r.status().low).toBe(false);
    sender.balance = 10n ** 15n;
    await r.refreshBalance();
    expect(r.status()).toMatchObject({ low: true, balanceWei: 10n ** 15n });
  });

  it("the background loop processes work and stops cleanly", async () => {
    const r = makeRelayer();
    r.start();
    await r.enqueue(job(1));
    r.notify();
    await expect
      .poll(async () => (await row("checkin:1")).status, { timeout: 5000 })
      .toBe("CONFIRMED");
    await r.stop();
  });
});
