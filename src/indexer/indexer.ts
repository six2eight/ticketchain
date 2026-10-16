import type { ChainLog, ChainReader } from "../chain/ports.js";
import { RangeTooLargeError } from "../chain/ports.js";
import { wipeChainData, type Prisma, type PrismaClient } from "../db/client.js";
import { lower } from "../lib/address.js";
import { errorMessage } from "../lib/errors.js";
import { toJsonSafe } from "../lib/json.js";
import type { Logger } from "../lib/logger.js";
import { backoffDelay } from "../lib/retry.js";
import { sleep } from "../lib/time.js";
import { applyEvent, refsOf, type StoredEvent } from "./projector.js";

export interface IndexerOptions {
  db: PrismaClient;
  chain: ChainReader;
  logger: Logger;
  contractAddress: string;
  startBlock: bigint;
  confirmations: number;
  batchSize: number;
  pollMs: number;
  /** How many blocks of checkpoints to keep for reorg detection. */
  checkpointRetention?: number;
}

export interface IndexerStatus {
  lastIndexedBlock: bigint;
  chainHead: bigint | null;
  lag: bigint | null;
  batchSize: number;
}

const bigMin = (a: bigint, b: bigint) => (a < b ? a : b);

export class Indexer {
  private batch: number;
  private readonly maxBatch: number;
  private readonly retention: bigint;
  private readonly floor: bigint; // lastIndexedBlock value meaning "nothing indexed yet"
  private abort = new AbortController();
  private loop: Promise<void> | undefined;
  private head: bigint | null = null;
  private lastIndexed: bigint;

  constructor(private readonly o: IndexerOptions) {
    this.maxBatch = o.batchSize;
    this.batch = o.batchSize;
    this.retention = BigInt(o.checkpointRetention ?? 256);
    this.floor = o.startBlock - 1n;
    this.lastIndexed = this.floor;
  }

  /** Creates the indexer state; wipes chain-derived tables if the contract address changed. */
  async init(): Promise<void> {
    const address = lower(this.o.contractAddress);
    const state = await this.o.db.indexerState.findUnique({ where: { id: 1 } });
    if (!state) {
      await this.o.db.indexerState.create({
        data: { id: 1, lastIndexedBlock: this.floor, contractAddress: address },
      });
    } else if (state.contractAddress !== address) {
      this.o.logger.warn(
        { from: state.contractAddress, to: address },
        "contract address changed: wiping chain-derived tables and re-indexing",
      );
      await this.o.db.$transaction(async (tx) => {
        await wipeChainData(tx);
        await tx.indexerState.update({
          where: { id: 1 },
          data: { lastIndexedBlock: this.floor, contractAddress: address },
        });
      });
    }
    this.lastIndexed = await this.lastIndexedBlock();
  }

  start(): void {
    if (this.loop) return;
    this.abort = new AbortController();
    this.loop = this.run(this.abort.signal);
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
    this.loop = undefined;
  }

  status(): IndexerStatus {
    return {
      lastIndexedBlock: this.lastIndexed,
      chainHead: this.head,
      lag: this.head === null ? null : this.head - this.lastIndexed,
      batchSize: this.batch,
    };
  }

  get currentBatchSize() {
    return this.batch;
  }

  private async run(signal: AbortSignal) {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const more = await this.tick();
        failures = 0;
        if (!more) await sleep(this.o.pollMs, signal);
      } catch (err) {
        failures++;
        const delay = backoffDelay(failures, { baseMs: 500, maxMs: 30_000 });
        this.o.logger.error({ err: errorMessage(err), failures, delay }, "indexer tick failed");
        await sleep(delay, signal);
      }
    }
  }

  private async lastIndexedBlock(): Promise<bigint> {
    const state = await this.o.db.indexerState.findUniqueOrThrow({ where: { id: 1 } });
    return state.lastIndexedBlock;
  }

  /** One sync step. Returns true when more blocks are immediately available. */
  async tick(): Promise<boolean> {
    const head = await this.o.chain.getBlockNumber();
    this.head = head;
    const safeHead = head - BigInt(this.o.confirmations);

    await this.checkReorg();

    const last = await this.lastIndexedBlock();
    this.lastIndexed = last;
    const from = last + 1n;
    if (from > safeHead) return false;

    let to = bigMin(from + BigInt(this.batch) - 1n, safeHead);
    let logs: ChainLog[];
    for (;;) {
      try {
        logs = await this.o.chain.getLogs(from, to);
        break;
      } catch (err) {
        if (err instanceof RangeTooLargeError && this.batch > 1) {
          this.batch = Math.max(1, Math.floor(this.batch / 2));
          to = bigMin(from + BigInt(this.batch) - 1n, safeHead);
          this.o.logger.warn({ batch: this.batch }, "getLogs range too large, halving batch");
          continue;
        }
        throw err;
      }
    }
    if (this.batch < this.maxBatch) {
      this.batch = Math.min(this.maxBatch, Math.ceil(this.batch * 1.25));
    }

    const toHash = await this.o.chain.getBlockHash(to);
    if (!toHash) throw new Error(`block ${to} disappeared while indexing`);
    const inconsistent = logs.some((l) => l.blockNumber === to && l.blockHash !== toHash);
    if (inconsistent) throw new Error(`block ${to} changed while indexing (reorg in progress)`);

    await this.o.db.$transaction(async (tx) => {
      for (const log of logs) {
        const args = toJsonSafe(log.args) as Record<string, unknown>;
        const exists = await tx.chainEvent.findUnique({
          where: { txHash_logIndex: { txHash: log.txHash, logIndex: log.logIndex } },
          select: { id: true },
        });
        if (exists) continue;
        await tx.chainEvent.create({
          data: {
            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            txHash: log.txHash,
            logIndex: log.logIndex,
            name: log.eventName,
            args: JSON.stringify(args),
            ...refsOf(log.eventName, args),
          },
        });
        await applyEvent(tx, {
          name: log.eventName,
          args,
          blockNumber: log.blockNumber,
          txHash: log.txHash,
          logIndex: log.logIndex,
        });
      }

      const checkpoints = new Map<bigint, string>(logs.map((l) => [l.blockNumber, l.blockHash]));
      checkpoints.set(to, toHash);
      for (const [number, hash] of checkpoints) {
        await tx.blockCheckpoint.upsert({
          where: { number },
          create: { number, hash },
          update: { hash },
        });
      }
      await tx.indexerState.update({ where: { id: 1 }, data: { lastIndexedBlock: to } });
      await tx.blockCheckpoint.deleteMany({ where: { number: { lt: to - this.retention } } });
    });

    this.lastIndexed = to;
    if (logs.length > 0) {
      this.o.logger.info({ from, to, logs: logs.length }, "indexed blocks");
    }
    return to < safeHead;
  }

  /** Detects a reorg at the last indexed block and rolls back to the fork point. */
  private async checkReorg(): Promise<void> {
    const last = await this.lastIndexedBlock();
    const cp = await this.o.db.blockCheckpoint.findUnique({ where: { number: last } });
    if (!cp) return;
    const chainHash = await this.o.chain.getBlockHash(last);
    if (chainHash === cp.hash) return;

    let forkPoint = this.floor;
    const older = await this.o.db.blockCheckpoint.findMany({
      where: { number: { lt: last } },
      orderBy: { number: "desc" },
    });
    for (const c of older) {
      if ((await this.o.chain.getBlockHash(c.number)) === c.hash) {
        forkPoint = c.number;
        break;
      }
    }

    this.o.logger.warn(
      { lastIndexed: last, forkPoint, depth: Number(last - forkPoint) },
      "chain reorg detected, rolling back",
    );
    await this.o.db.$transaction((tx) => this.rollbackTo(tx, forkPoint));
    this.lastIndexed = forkPoint;
  }

  private async rollbackTo(tx: Prisma.TransactionClient, forkPoint: bigint): Promise<void> {
    if (forkPoint <= this.floor) {
      // Nothing survives (e.g. the local chain was restarted): start over from scratch.
      await wipeChainData(tx);
      await tx.indexerState.update({ where: { id: 1 }, data: { lastIndexedBlock: this.floor } });
      return;
    }

    const removed = await tx.chainEvent.findMany({ where: { blockNumber: { gt: forkPoint } } });
    const tokenIds = [...new Set(removed.flatMap((e) => (e.tokenId === null ? [] : [e.tokenId])))];
    const eventIds = new Set(removed.flatMap((e) => (e.eventId === null ? [] : [e.eventId])));
    const removedEvents = new Set(
      removed.filter((e) => e.name === "EventCreated").map((e) => e.eventId!),
    );

    // Tickets admitted at the door whose check-in tx is tracked by the relayer stay CHECKING_IN.
    const admitted = await tx.ticket.findMany({
      where: { tokenId: { in: tokenIds }, status: { in: ["CHECKING_IN", "USED"] } },
      select: { tokenId: true },
    });
    const relayed = await tx.txRequest.findMany({
      where: { idempotencyKey: { in: admitted.map((t) => `checkin:${t.tokenId}`) } },
      select: { idempotencyKey: true },
    });
    const keepCheckingIn = relayed.map((r) => Number(r.idempotencyKey.split(":")[1]));

    await tx.chainEvent.deleteMany({ where: { blockNumber: { gt: forkPoint } } });
    await tx.blockCheckpoint.deleteMany({ where: { number: { gt: forkPoint } } });

    await tx.transfer.deleteMany({ where: { tokenId: { in: tokenIds } } });
    await tx.ticket.deleteMany({ where: { tokenId: { in: tokenIds } } });
    await tx.staff.deleteMany({ where: { eventId: { in: [...eventIds] } } });
    await tx.event.deleteMany({ where: { id: { in: [...removedEvents] } } });

    const replay = await tx.chainEvent.findMany({
      where: { OR: [{ tokenId: { in: tokenIds } }, { eventId: { in: [...eventIds] } }] },
      orderBy: [{ blockNumber: "asc" }, { logIndex: "asc" }],
    });
    for (const e of replay) {
      const ev: StoredEvent = {
        name: e.name,
        args: JSON.parse(e.args) as Record<string, unknown>,
        blockNumber: e.blockNumber,
        txHash: e.txHash,
        logIndex: e.logIndex,
      };
      await applyEvent(tx, ev);
    }

    for (const eventId of eventIds) {
      const sold = await tx.ticket.count({ where: { eventId } });
      await tx.event.updateMany({ where: { id: eventId }, data: { sold } });
    }
    await tx.ticket.updateMany({
      where: { tokenId: { in: keepCheckingIn }, status: "VALID" },
      data: { status: "CHECKING_IN" },
    });
    await tx.indexerState.update({ where: { id: 1 }, data: { lastIndexedBlock: forkPoint } });
  }
}
