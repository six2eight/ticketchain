import type { PrivateKeyAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CHECKIN_REASONS, type CheckinReason } from "../../src/checkin/checkin.service.js";
import { encodeQr, decodeQr } from "../../src/checkin/qr.js";
import { cleanupExpiredNonces, runCheckinConfirmer } from "../../src/jobs/checkin-confirmer.js";
import { silentLogger } from "../../src/lib/logger.js";
import {
  CONTRACT,
  createTestApp,
  newAccount,
  qrFor,
  seedDeviceKey,
  seedEvent,
  seedStaff,
  seedTicket,
  type TestApp,
} from "../helpers/app.js";

let h: TestApp;
const organizer = newAccount();
const staff = newAccount();
const buyer = newAccount();
const other = newAccount();
let device: PrivateKeyAccount;

beforeEach(async () => {
  h = await createTestApp();
  await seedEvent(h.db, {
    id: 1,
    organizer: organizer.address,
    startTime: new Date(h.clock() + 3600_000),
  });
  await seedStaff(h.db, 1, staff.address);
  await seedTicket(h.db, { tokenId: 1, owner: buyer.address });
  ({ device } = await seedDeviceKey(h.db, { tokenId: 1, owner: buyer.address }));
});
afterEach(() => h.cleanup());

const scan = (qr: string, o: { eventId?: number; by?: string } = {}) =>
  h.checkin.scan({ eventId: o.eventId ?? 1, qr, staff: o.by ?? staff.address });

const qr = (o: Partial<Parameters<typeof qrFor>[1]> = {}, signer = device) =>
  qrFor(signer, { tokenId: 1, nowMs: h.clock(), ...o });

async function expectRejected(reason: CheckinReason, promise: ReturnType<typeof scan>) {
  const res = await promise;
  expect(res).toMatchObject({ result: "REJECTED", reason });
  return res;
}

describe("CheckinService", () => {
  it("accepts a valid QR, locks the ticket and queues the relayer tx", async () => {
    const res = await scan(await qr());
    expect(res).toMatchObject({
      result: "ACCEPTED",
      tokenId: 1,
      eventId: 1,
      holder: buyer.address.toLowerCase(),
    });

    const ticket = await h.db.ticket.findUniqueOrThrow({ where: { tokenId: 1 } });
    expect(ticket.status).toBe("CHECKING_IN");
    const tx = await h.db.txRequest.findUniqueOrThrow({ where: { idempotencyKey: "checkin:1" } });
    expect(tx).toMatchObject({ kind: "CHECKIN", to: CONTRACT, status: "QUEUED" });
    expect(tx.data.startsWith("0x")).toBe(true);
    const attempts = await h.db.checkinAttempt.findMany();
    expect(attempts).toMatchObject([{ result: "ACCEPTED", tokenId: 1, txRequestId: tx.id }]);
  });

  it("organizer can scan too", async () => {
    expect(await scan(await qr(), { by: organizer.address })).toMatchObject({ result: "ACCEPTED" });
  });

  it("QR_MALFORMED", async () => {
    await expectRejected("QR_MALFORMED", scan("hello"));
    await expectRejected(
      "QR_MALFORMED",
      scan(encodeQr({ v: 1, t: 1, e: 1, x: 1, n: "x", s: "0x" } as never)),
    );
  });

  it("QR_EXPIRED: older than its expiry (+5 s skew) or issued too far ahead", async () => {
    const old = await qr({ nowMs: h.clock() - 36_000 }); // expired 6 s ago
    await expectRejected("QR_EXPIRED", scan(old));
    const future = await qr({ nowMs: h.clock() + 60_000 });
    await expectRejected("QR_EXPIRED", scan(future));
    const withinSkew = await qr({ nowMs: h.clock() - 34_000 }); // expired 4 s ago
    expect(await scan(withinSkew)).toMatchObject({ result: "ACCEPTED" });
  });

  it("WRONG_EVENT", async () => {
    await seedEvent(h.db, { id: 2, organizer: organizer.address });
    await seedStaff(h.db, 2, staff.address);
    await expectRejected("WRONG_EVENT", scan(await qr(), { eventId: 2 }));
  });

  it("NOT_STAFF", async () => {
    await expectRejected("NOT_STAFF", scan(await qr(), { by: other.address }));
  });

  it("TICKET_NOT_FOUND: unknown token or a ticket of another event", async () => {
    await expectRejected("TICKET_NOT_FOUND", scan(await qr({ tokenId: 99 })));
    await seedEvent(h.db, { id: 2, organizer: organizer.address });
    await seedTicket(h.db, { tokenId: 2, eventId: 2, owner: buyer.address });
    await expectRejected("TICKET_NOT_FOUND", scan(await qr({ tokenId: 2, eventId: 1 })));
  });

  it("INVALID_SIGNATURE: unknown device, tampered payload, expired or revoked key", async () => {
    await expectRejected("INVALID_SIGNATURE", scan(await qr({}, newAccount())));

    const p = decodeQr(await qr())!;
    await expectRejected("INVALID_SIGNATURE", scan(encodeQr({ ...p, n: "0".repeat(32) })));

    const expired = await seedDeviceKey(h.db, {
      tokenId: 1,
      owner: buyer.address,
      expiresAt: new Date(h.clock() - 1),
    });
    await expectRejected("INVALID_SIGNATURE", scan(await qr({}, expired.device)));

    await h.db.deviceKey.updateMany({
      where: { deviceAddr: device.address.toLowerCase() },
      data: { revoked: true },
    });
    await expectRejected("INVALID_SIGNATURE", scan(await qr()));
  });

  it("OWNER_CHANGED: the delegation was signed by a previous owner", async () => {
    await h.db.ticket.update({
      where: { tokenId: 1 },
      data: { owner: other.address.toLowerCase() },
    });
    await expectRejected("OWNER_CHANGED", scan(await qr()));
  });

  it("QR_REPLAYED: the same QR twice", async () => {
    const code = await qr();
    expect(await scan(code)).toMatchObject({ result: "ACCEPTED" });
    await expectRejected("QR_REPLAYED", scan(code));
  });

  it("OUTSIDE_CHECKIN_WINDOW", async () => {
    await h.db.event.update({
      where: { id: 1 },
      data: { startTime: new Date(h.clock() + 7 * 3600_000) },
    });
    await expectRejected("OUTSIDE_CHECKIN_WINDOW", scan(await qr()));
    await h.db.event.update({
      where: { id: 1 },
      data: { startTime: new Date(h.clock() - 25 * 3600_000) },
    });
    await expectRejected("OUTSIDE_CHECKIN_WINDOW", scan(await qr()));
    expect(await h.db.ticket.findUniqueOrThrow({ where: { tokenId: 1 } })).toMatchObject({
      status: "VALID",
    });
  });

  it("ALREADY_USED: a fresh QR after admission, with usedAt", async () => {
    expect(await scan(await qr())).toMatchObject({ result: "ACCEPTED" });
    const res = await expectRejected("ALREADY_USED", scan(await qr()));
    expect(res).toHaveProperty("usedAt");
    expect(typeof (res as { usedAt: string }).usedAt).toBe("string");

    await seedTicket(h.db, { tokenId: 3, owner: buyer.address, status: "USED" });
    const k = await seedDeviceKey(h.db, { tokenId: 3, owner: buyer.address });
    await expectRejected(
      "ALREADY_USED",
      scan(await qrFor(k.device, { tokenId: 3, nowMs: h.clock() })),
    );
  });

  it("covers every documented error code", () => {
    expect(CHECKIN_REASONS).toHaveLength(10);
  });

  it("records every attempt", async () => {
    await scan("garbage");
    await scan(await qr(), { by: other.address });
    await scan(await qr());
    const attempts = await h.db.checkinAttempt.findMany({ orderBy: { id: "asc" } });
    expect(attempts.map((a) => [a.result, a.reason])).toEqual([
      ["REJECTED", "QR_MALFORMED"],
      ["REJECTED", "NOT_STAFF"],
      ["ACCEPTED", null],
    ]);
  });

  it("10 parallel scans of the same ticket admit it exactly once", async () => {
    const codes = await Promise.all(Array.from({ length: 10 }, () => qr()));
    const results = await Promise.all(codes.map((c) => scan(c)));
    const accepted = results.filter((r) => r.result === "ACCEPTED");
    expect(accepted).toHaveLength(1);
    expect(
      results.filter((r) => r.result === "REJECTED").every((r) => r.reason === "ALREADY_USED"),
    ).toBe(true);
    expect(await h.db.txRequest.count()).toBe(1);
  });

  it("the accepted check-in is sent by the relayer", async () => {
    await scan(await qr());
    await h.relayer.processOnce();
    const tx = await h.db.txRequest.findUniqueOrThrow({ where: { idempotencyKey: "checkin:1" } });
    expect(tx.status).toBe("CONFIRMED");
    expect(h.sender.broadcasts).toHaveLength(1);
  });
});

describe("jobs", () => {
  it("checkin-confirmer re-enqueues missing and retryable failed txs, and flags stuck tickets", async () => {
    const logger = silentLogger();
    await h.db.ticket.update({
      where: { tokenId: 1 },
      data: { status: "CHECKING_IN", usedAt: new Date(h.clock()) },
    });
    let r = await runCheckinConfirmer({
      db: h.db,
      relayer: h.relayer,
      logger,
      contract: CONTRACT,
      clock: h.clock,
    });
    expect(r.requeued).toBe(1);
    expect(await h.db.txRequest.count()).toBe(1);

    await h.db.txRequest.updateMany({ data: { status: "FAILED", error: "NONCE_CONSUMED" } });
    r = await runCheckinConfirmer({
      db: h.db,
      relayer: h.relayer,
      logger,
      contract: CONTRACT,
      clock: h.clock,
    });
    expect(r.requeued).toBe(1);
    expect((await h.db.txRequest.findFirstOrThrow()).status).toBe("QUEUED");

    await h.db.txRequest.updateMany({ data: { status: "FAILED", error: "TicketUsed" } });
    r = await runCheckinConfirmer({
      db: h.db,
      relayer: h.relayer,
      logger,
      contract: CONTRACT,
      clock: h.clock,
    });
    expect(r.requeued).toBe(0);

    h.clock.advance(11 * 60_000);
    r = await runCheckinConfirmer({
      db: h.db,
      relayer: h.relayer,
      logger,
      contract: CONTRACT,
      clock: h.clock,
    });
    expect(r.stuck).toBe(1);
  });

  it("checkin-confirmer re-checks a CONFIRMED tx whose ticket never became USED", async () => {
    const logger = silentLogger();
    await scan(await qr());
    await h.relayer.processOnce();
    h.clock.advance(3 * 60_000);
    const r = await runCheckinConfirmer({
      db: h.db,
      relayer: h.relayer,
      logger,
      contract: CONTRACT,
      clock: () => Date.now() + 3 * 60_000,
    });
    expect(r.requeued).toBe(1);
    // On re-send, gas estimation says it already landed.
    h.sender.revertReason = () => "TicketUsed";
    await h.relayer.processOnce();
    expect((await h.db.txRequest.findFirstOrThrow()).status).toBe("REVERTED");
    expect(h.sender.broadcasts).toHaveLength(1);
  });

  it("cleanup removes expired QR and auth nonces", async () => {
    await h.db.usedQrNonce.create({ data: { nonce: "a", expiresAt: new Date(h.clock() - 1) } });
    await h.db.usedQrNonce.create({
      data: { nonce: "b", expiresAt: new Date(h.clock() + 60_000) },
    });
    await h.db.authNonce.create({ data: { nonce: "c", expiresAt: new Date(h.clock() - 1) } });
    expect(await cleanupExpiredNonces(h.db, h.clock)).toEqual({ qr: 1, auth: 1 });
    expect(await h.db.usedQrNonce.count()).toBe(1);
  });
});
