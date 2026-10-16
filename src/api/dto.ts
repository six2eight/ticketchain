import type { Event, Ticket, Transfer } from "../db/generated/client.js";

export function eventDto(e: Event) {
  return {
    id: e.id,
    organizer: e.organizer,
    name: e.name,
    description: e.description,
    venue: e.venue,
    priceWei: e.priceWei,
    resaleCapWei: e.resaleCapWei,
    resaleEnabled: e.resaleCapWei !== "0",
    maxSupply: e.maxSupply,
    sold: e.sold,
    ticketsLeft: Math.max(0, e.maxSupply - e.sold),
    startTime: e.startTime.toISOString(),
    createdBlock: e.createdBlock.toString(),
  };
}

export function ticketDto(t: Ticket, baseUrl: string) {
  return {
    tokenId: t.tokenId,
    eventId: t.eventId,
    owner: t.owner,
    status: t.status,
    listedPriceWei: t.listedPriceWei,
    usedAt: t.usedAt?.toISOString() ?? null,
    mintedBlock: t.mintedBlock.toString(),
    metadataUrl: `${baseUrl}/metadata/${t.tokenId}`,
    imageUrl: `${baseUrl}/metadata/${t.tokenId}/image.svg`,
  };
}

export function transferDto(x: Transfer) {
  return {
    from: x.from,
    to: x.to,
    priceWei: x.priceWei,
    txHash: x.txHash,
    block: x.block.toString(),
  };
}

/** Cursor pagination helper: fetch `limit + 1` rows, return a page and the next cursor. */
export function page<T>(rows: T[], limit: number, cursorOf: (row: T) => number) {
  const items = rows.slice(0, limit);
  const nextCursor =
    rows.length > limit && items.length > 0 ? cursorOf(items[items.length - 1]!) : null;
  return { items, nextCursor };
}
