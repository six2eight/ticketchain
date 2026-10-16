import { randomBytes } from "node:crypto";

import {
  RangeTooLargeError,
  type ChainLog,
  type ChainReader,
  type Hex,
} from "../../src/chain/ports.js";

export interface LogSpec {
  eventName: string;
  args: Record<string, unknown>;
}

const randomHash = (): Hex => `0x${randomBytes(32).toString("hex")}`;

/** An in-memory chain: block i has a hash and decoded logs. Supports reorgs and RPC limits. */
export class FakeChain implements ChainReader {
  blocks: { hash: Hex; logs: ChainLog[] }[] = [{ hash: randomHash(), logs: [] }];
  /** getLogs throws RangeTooLargeError when the requested range is larger than this. */
  maxRange = Infinity;
  /** Number of upcoming getLogs calls that fail with a generic error. */
  failNextGetLogs = 0;
  getLogsCalls: [bigint, bigint][] = [];

  get head() {
    return BigInt(this.blocks.length - 1);
  }

  /** Mines one block containing the given events (each in its own tx). */
  mine(...specs: LogSpec[]): bigint {
    const number = BigInt(this.blocks.length);
    const hash = randomHash();
    const logs = specs.map((s, i) => ({
      blockNumber: number,
      blockHash: hash,
      txHash: randomHash(),
      logIndex: i,
      eventName: s.eventName,
      args: s.args,
    }));
    this.blocks.push({ hash, logs });
    return number;
  }

  mineEmpty(count: number) {
    for (let i = 0; i < count; i++) this.mine();
  }

  /** Drops the last `depth` blocks; callers then mine the replacement chain. */
  reorg(depth: number) {
    this.blocks.splice(this.blocks.length - depth, depth);
  }

  async getBlockNumber() {
    return this.head;
  }

  async getBlockHash(number: bigint) {
    return this.blocks[Number(number)]?.hash ?? null;
  }

  async getLogs(from: bigint, to: bigint) {
    this.getLogsCalls.push([from, to]);
    if (this.failNextGetLogs > 0) {
      this.failNextGetLogs--;
      throw new Error("ECONNRESET");
    }
    if (Number(to - from) + 1 > this.maxRange) throw new RangeTooLargeError();
    return this.blocks.slice(Number(from), Number(to) + 1).flatMap((b) => b.logs);
  }
}

// Builders for TicketChain events (args shaped like viem's decoded output).
const ORG = "0x00000000000000000000000000000000000000a1";
export const addr = {
  organizer: ORG as Hex,
  buyer1: "0x00000000000000000000000000000000000000b1" as Hex,
  buyer2: "0x00000000000000000000000000000000000000b2" as Hex,
  buyer3: "0x00000000000000000000000000000000000000b3" as Hex,
  staff: "0x00000000000000000000000000000000000000c1" as Hex,
};

export const ev = {
  created: (
    eventId: number,
    opts: { price?: bigint; startTime?: number; maxSupply?: number } = {},
  ) => ({
    eventName: "EventCreated",
    args: {
      eventId: BigInt(eventId),
      organizer: addr.organizer,
      name: `Event ${eventId}`,
      price: opts.price ?? 100n,
      maxSupply: opts.maxSupply ?? 100,
      startTime: BigInt(opts.startTime ?? Math.floor(Date.now() / 1000) + 3600),
      resaleCap: 150n,
    },
  }),
  staff: (eventId: number, wallet: Hex, allowed: boolean) => ({
    eventName: "StaffUpdated",
    args: { eventId: BigInt(eventId), wallet, allowed },
  }),
  purchased: (tokenId: number, eventId: number, buyer: Hex, price = 100n) => ({
    eventName: "TicketPurchased",
    args: { tokenId: BigInt(tokenId), eventId: BigInt(eventId), buyer, price },
  }),
  listed: (tokenId: number, seller: Hex, price: bigint) => ({
    eventName: "TicketListed",
    args: { tokenId: BigInt(tokenId), seller, price },
  }),
  cancelled: (tokenId: number) => ({
    eventName: "ListingCancelled",
    args: { tokenId: BigInt(tokenId) },
  }),
  resold: (tokenId: number, from: Hex, to: Hex, price: bigint) => ({
    eventName: "TicketResold",
    args: { tokenId: BigInt(tokenId), from, to, price },
  }),
  checkedIn: (tokenId: number, eventId: number, operator: Hex) => ({
    eventName: "TicketCheckedIn",
    args: { tokenId: BigInt(tokenId), eventId: BigInt(eventId), operator },
  }),
};
