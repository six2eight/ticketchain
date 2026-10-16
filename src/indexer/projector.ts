import type { Prisma } from "../db/client.js";
import { lower, zeroAddressLower } from "../lib/address.js";

/** A stored chain event with JSON-safe args (bigints as decimal strings). */
export interface StoredEvent {
  name: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
}

const str = (v: unknown) => String(v);
const int = (v: unknown) => Number(v);

/** Which projection rows an event touches; stored on ChainEvent for rollback. */
export function refsOf(name: string, args: Record<string, unknown>) {
  return {
    tokenId: "tokenId" in args ? int(args.tokenId) : null,
    eventId: name === "Transfer" ? null : "eventId" in args ? int(args.eventId) : null,
  };
}

async function recomputeSold(tx: Prisma.TransactionClient, eventId: number) {
  const sold = await tx.ticket.count({ where: { eventId } });
  await tx.event.updateMany({ where: { id: eventId }, data: { sold } });
}

/**
 * Applies one event to the projection tables. Every branch is idempotent, so replaying
 * the same event (restart, reorg replay) leaves the tables unchanged.
 */
export async function applyEvent(
  tx: Prisma.TransactionClient,
  ev: StoredEvent,
  now: Date = new Date(),
): Promise<void> {
  const a = ev.args;
  switch (ev.name) {
    case "EventCreated": {
      const chainFields = {
        organizer: lower(str(a.organizer)),
        name: str(a.name),
        priceWei: str(a.price),
        resaleCapWei: str(a.resaleCap),
        maxSupply: int(a.maxSupply),
        startTime: new Date(int(a.startTime) * 1000),
        createdBlock: ev.blockNumber,
      };
      await tx.event.upsert({
        where: { id: int(a.eventId) },
        create: { id: int(a.eventId), ...chainFields },
        update: chainFields,
      });
      return;
    }

    case "StaffUpdated": {
      const key = { eventId: int(a.eventId), wallet: lower(str(a.wallet)) };
      if (a.allowed === true || a.allowed === "true") {
        await tx.staff.upsert({ where: { eventId_wallet: key }, create: key, update: {} });
      } else {
        await tx.staff.deleteMany({ where: key });
      }
      return;
    }

    case "TicketPurchased": {
      const tokenId = int(a.tokenId);
      const eventId = int(a.eventId);
      const buyer = lower(str(a.buyer));
      await tx.ticket.upsert({
        where: { tokenId },
        create: { tokenId, eventId, owner: buyer, status: "VALID", mintedBlock: ev.blockNumber },
        update: {},
      });
      await tx.transfer.upsert({
        where: { txHash_logIndex: { txHash: ev.txHash, logIndex: ev.logIndex } },
        create: {
          tokenId,
          from: zeroAddressLower,
          to: buyer,
          priceWei: str(a.price),
          txHash: ev.txHash,
          logIndex: ev.logIndex,
          block: ev.blockNumber,
        },
        update: {},
      });
      await recomputeSold(tx, eventId);
      return;
    }

    case "TicketListed":
      await tx.ticket.updateMany({
        where: { tokenId: int(a.tokenId) },
        data: { listedPriceWei: str(a.price) },
      });
      return;

    case "ListingCancelled":
      await tx.ticket.updateMany({
        where: { tokenId: int(a.tokenId) },
        data: { listedPriceWei: null },
      });
      return;

    case "TicketResold": {
      const tokenId = int(a.tokenId);
      const from = lower(str(a.from));
      const to = lower(str(a.to));
      await tx.ticket.updateMany({ where: { tokenId }, data: { owner: to, listedPriceWei: null } });
      await tx.transfer.upsert({
        where: { txHash_logIndex: { txHash: ev.txHash, logIndex: ev.logIndex } },
        create: {
          tokenId,
          from,
          to,
          priceWei: str(a.price),
          txHash: ev.txHash,
          logIndex: ev.logIndex,
          block: ev.blockNumber,
        },
        update: {},
      });
      // Device keys were delegated by the previous owner; they must not work for the new one.
      await tx.deviceKey.updateMany({
        where: { tokenId, revoked: false },
        data: { revoked: true },
      });
      return;
    }

    case "TicketCheckedIn": {
      const tokenId = int(a.tokenId);
      const ticket = await tx.ticket.findUnique({ where: { tokenId }, select: { usedAt: true } });
      await tx.ticket.updateMany({
        where: { tokenId },
        data: { status: "USED", usedAt: ticket?.usedAt ?? now, listedPriceWei: null },
      });
      return;
    }

    default:
      // Transfer (ERC721), Withdrawal, RoleGranted, ...: nothing to project.
      return;
  }
}
