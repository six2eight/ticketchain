import { encodeCheckIn } from "../chain/calldata.js";
import type { Hex } from "../chain/ports.js";
import { isUniqueViolation, type Db, type PrismaClient } from "../db/client.js";
import { isStaffOrOrganizer } from "../auth/guards.js";
import { lower } from "../lib/address.js";
import type { Logger } from "../lib/logger.js";
import { systemClock, type Clock } from "../lib/time.js";
import { decodeQr, recoverQrSigner } from "./qr.js";

export const CHECKIN_REASONS = [
  "QR_MALFORMED",
  "QR_EXPIRED",
  "WRONG_EVENT",
  "NOT_STAFF",
  "TICKET_NOT_FOUND",
  "INVALID_SIGNATURE",
  "OWNER_CHANGED",
  "QR_REPLAYED",
  "OUTSIDE_CHECKIN_WINDOW",
  "ALREADY_USED",
] as const;
export type CheckinReason = (typeof CHECKIN_REASONS)[number];

export type CheckinResult =
  | { result: "ACCEPTED"; tokenId: number; eventId: number; holder: string; txRequestId: number }
  | { result: "REJECTED"; reason: CheckinReason; tokenId?: number; usedAt?: string | null };

export interface CheckinRelayer {
  enqueue(
    req: { idempotencyKey: string; kind: string; to: Hex; data: Hex },
    db?: Db,
  ): Promise<{ id: number }>;
  notify?(): void;
}

export interface CheckinOptions {
  db: PrismaClient;
  relayer: CheckinRelayer;
  logger: Logger;
  chainId: number;
  contract: Hex;
  ttlSeconds: number;
  windowBeforeS: number;
  windowAfterS: number;
  clock?: Clock;
  /** Tolerated clock difference between the buyer's phone and the server. */
  skewSeconds?: number;
}

class Reject extends Error {
  constructor(readonly reason: CheckinReason) {
    super(reason);
  }
}

/**
 * Verifies a scanned QR code (§9.3). The hot path only touches the DB — no chain calls —
 * and the final status change is an atomic compare-and-set, so concurrent scans of the
 * same ticket admit it exactly once.
 */
export class CheckinService {
  private readonly clock: Clock;
  private readonly skew: number;

  constructor(private readonly o: CheckinOptions) {
    this.clock = o.clock ?? systemClock;
    this.skew = o.skewSeconds ?? 5;
  }

  async scan(input: { eventId: number; qr: string; staff: string }): Promise<CheckinResult> {
    const staff = lower(input.staff);
    const now = this.clock();
    const nowS = Math.floor(now / 1000);
    const seen: { tokenId?: number } = {};

    const reject = async (reason: CheckinReason, usedAt?: Date | null): Promise<CheckinResult> => {
      await this.o.db.checkinAttempt.create({
        data: {
          eventId: input.eventId,
          tokenId: seen.tokenId ?? null,
          staff,
          result: "REJECTED",
          reason,
        },
      });
      this.o.logger.info(
        { eventId: input.eventId, tokenId: seen.tokenId, staff, reason },
        "check-in rejected",
      );
      return {
        result: "REJECTED",
        reason,
        ...(seen.tokenId !== undefined ? { tokenId: seen.tokenId } : {}),
        ...(usedAt !== undefined ? { usedAt: usedAt?.toISOString() ?? null } : {}),
      };
    };

    // 1. decode
    const p = decodeQr(input.qr);
    if (!p) return reject("QR_MALFORMED");
    seen.tokenId = p.t;

    // 2. freshness: not expired, and not issued further ahead than one TTL
    if (p.x + this.skew < nowS || p.x - nowS > this.o.ttlSeconds + this.skew)
      return reject("QR_EXPIRED");

    // 3. scanned at the right event
    if (p.e !== input.eventId) return reject("WRONG_EVENT");

    // 4. scanner is staff or organizer
    if (!(await isStaffOrOrganizer(this.o.db, input.eventId, staff))) return reject("NOT_STAFF");

    // 5. ticket exists and belongs to the event
    const ticket = await this.o.db.ticket.findUnique({ where: { tokenId: p.t } });
    if (!ticket || ticket.eventId !== input.eventId) return reject("TICKET_NOT_FOUND");

    // 6. signed by an unexpired device key registered for this ticket
    let device: string;
    try {
      device = lower(await recoverQrSigner(p, this.o.chainId, this.o.contract));
    } catch {
      return reject("INVALID_SIGNATURE");
    }
    const keys = await this.o.db.deviceKey.findMany({
      where: { tokenId: p.t, deviceAddr: device, expiresAt: { gt: new Date(now) } },
      orderBy: { id: "desc" },
    });
    if (keys.length === 0) return reject("INVALID_SIGNATURE");

    // 7. the delegation was signed by the current owner (not resold since)
    const key = keys.find((k) => k.ownerAtReg === ticket.owner);
    if (!key) return reject("OWNER_CHANGED");
    if (key.revoked) return reject("INVALID_SIGNATURE");

    // 8–10 in one transaction: consume the nonce, check the window, lock the ticket, queue the tx.
    let txRequestId: number;
    try {
      txRequestId = await this.o.db.$transaction(async (tx) => {
        try {
          await tx.usedQrNonce.create({
            data: { nonce: p.n, expiresAt: new Date((p.x + this.skew + 60) * 1000) },
          });
        } catch (err) {
          if (isUniqueViolation(err)) throw new Reject("QR_REPLAYED");
          throw err;
        }

        const event = await tx.event.findUniqueOrThrow({ where: { id: input.eventId } });
        const startS = Math.floor(event.startTime.getTime() / 1000);
        if (nowS < startS - this.o.windowBeforeS || nowS > startS + this.o.windowAfterS) {
          throw new Reject("OUTSIDE_CHECKIN_WINDOW");
        }

        const locked = await tx.ticket.updateMany({
          where: { tokenId: p.t, status: "VALID" },
          data: { status: "CHECKING_IN", usedAt: new Date(now) },
        });
        if (locked.count !== 1) throw new Reject("ALREADY_USED");

        const req = await this.o.relayer.enqueue(
          {
            idempotencyKey: `checkin:${p.t}`,
            kind: "CHECKIN",
            to: this.o.contract,
            data: encodeCheckIn(p.t),
          },
          tx,
        );
        await tx.checkinAttempt.create({
          data: {
            eventId: input.eventId,
            tokenId: p.t,
            staff,
            result: "ACCEPTED",
            txRequestId: req.id,
          },
        });
        return req.id;
      });
    } catch (err) {
      if (!(err instanceof Reject)) throw err;
      if (err.reason === "ALREADY_USED") {
        const current = await this.o.db.ticket.findUnique({ where: { tokenId: p.t } });
        return reject("ALREADY_USED", current?.usedAt ?? null);
      }
      return reject(err.reason);
    }

    this.o.relayer.notify?.();
    this.o.logger.info(
      { eventId: input.eventId, tokenId: p.t, staff, txRequestId },
      "check-in accepted",
    );
    return {
      result: "ACCEPTED",
      tokenId: p.t,
      eventId: input.eventId,
      holder: ticket.owner,
      txRequestId,
    };
  }
}
