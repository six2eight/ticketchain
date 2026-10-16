import { encodeCheckIn } from "../chain/calldata.js";
import type { Hex } from "../chain/ports.js";
import type { PrismaClient } from "../db/client.js";
import type { Logger } from "../lib/logger.js";
import { systemClock, type Clock } from "../lib/time.js";
import { PERMANENT_REVERTS, type Relayer } from "../relayer/relayer.js";

export interface ConfirmerOptions {
  db: PrismaClient;
  relayer: Pick<Relayer, "enqueue" | "requeue">;
  logger: Logger;
  contract: Hex;
  clock?: Clock;
  /** A CONFIRMED tx whose ticket is still CHECKING_IN after this long is re-checked (reorg). */
  reconfirmAfterMs?: number;
  /** Alert when a ticket stays CHECKING_IN this long. */
  alertAfterMs?: number;
}

/**
 * Makes sure every admitted (CHECKING_IN) ticket ends up USED on-chain:
 * re-enqueues missing or retryable-FAILED transactions and alerts on stuck tickets.
 */
export async function runCheckinConfirmer(
  o: ConfirmerOptions,
): Promise<{ requeued: number; stuck: number }> {
  const now = (o.clock ?? systemClock)();
  const reconfirmAfter = o.reconfirmAfterMs ?? 2 * 60_000;
  const alertAfter = o.alertAfterMs ?? 10 * 60_000;
  let requeued = 0;
  let stuck = 0;

  const tickets = await o.db.ticket.findMany({ where: { status: "CHECKING_IN" }, take: 500 });
  for (const t of tickets) {
    const key = `checkin:${t.tokenId}`;
    const req = await o.db.txRequest.findUnique({ where: { idempotencyKey: key } });
    if (!req) {
      await o.relayer.enqueue({
        idempotencyKey: key,
        kind: "CHECKIN",
        to: o.contract,
        data: encodeCheckIn(t.tokenId),
      });
      requeued++;
      continue;
    }
    const age = now - req.updatedAt.getTime();
    if (req.status === "FAILED" && !PERMANENT_REVERTS.has(req.error ?? "")) {
      await o.relayer.requeue(req.id, req.error ?? "failed");
      requeued++;
    } else if (req.status === "CONFIRMED" && age > reconfirmAfter) {
      // Confirmed but never indexed as USED: the block may have been reorged out. Re-sending is
      // safe — if the check-in did land, gas estimation reverts with TicketUsed and nothing is sent.
      await o.relayer.requeue(req.id, "confirmed but not indexed");
      requeued++;
    }
    if (now - (t.usedAt ?? req.createdAt).getTime() > alertAfter) {
      stuck++;
      o.logger.error(
        { tokenId: t.tokenId, txRequestId: req.id, status: req.status },
        "ticket stuck in CHECKING_IN",
      );
    }
  }
  return { requeued, stuck };
}

export async function cleanupExpiredNonces(db: PrismaClient, clock: Clock = systemClock) {
  const now = new Date(clock());
  const [qr, auth] = await Promise.all([
    db.usedQrNonce.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.authNonce.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);
  return { qr: qr.count, auth: auth.count };
}
