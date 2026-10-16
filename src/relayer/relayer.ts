import {
  NonceTooLowError,
  RevertError,
  type Hex,
  type TxFees,
  type TxSender,
} from "../chain/ports.js";
import { isUniqueViolation, type Db, type PrismaClient } from "../db/client.js";
import type { TxRequest } from "../db/generated/client.js";
import { errorMessage } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";
import { Mutex } from "../lib/mutex.js";
import { systemClock, type Clock } from "../lib/time.js";

export type TxStatus = "QUEUED" | "SUBMITTED" | "CONFIRMED" | "REVERTED" | "FAILED";

export interface EnqueueRequest {
  idempotencyKey: string;
  kind: string;
  to: Hex;
  data: Hex;
}

export interface Attempt {
  hash: Hex;
  nonce: number;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  sentAt: number;
}

export interface RelayerOptions {
  db: PrismaClient;
  sender: TxSender;
  logger: Logger;
  pollMs: number;
  stuckMs: number;
  maxFeePerGasWei: bigint;
  lowBalanceWei: bigint;
  clock?: Clock;
}

/** Custom errors after which retrying makes no sense. */
export const PERMANENT_REVERTS = new Set(["TicketUsed", "ERC721NonexistentToken"]);

/** +12.5 % rounded up, and at least +1 wei (the minimum most nodes accept for a replacement). */
export const bump = (v: bigint) => v + (v * 125n + 999n) / 1000n + 1n;

const big = (s: string) => BigInt(s);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

export function parseAttempts(row: Pick<TxRequest, "attempts">): Attempt[] {
  return JSON.parse(row.attempts) as Attempt[];
}

/**
 * Sends backend transactions (check-ins) from one relayer wallet.
 * State lives in TxRequest rows, so a restart resumes QUEUED and SUBMITTED work without
 * losing or duplicating transactions. A single worker (mutex) owns the nonce.
 */
export class Relayer {
  private readonly clock: Clock;
  private readonly mutex = new Mutex();
  private nonce: number | null = null;
  private balance: bigint | null = null;
  private loop: Promise<void> | undefined;
  private stopped = true;
  private wake: (() => void) | undefined;

  constructor(private readonly o: RelayerOptions) {
    this.clock = o.clock ?? systemClock;
  }

  get address() {
    return this.o.sender.address;
  }

  /** Returns the existing row when the idempotency key is already known. */
  async enqueue(req: EnqueueRequest, db: Db = this.o.db): Promise<TxRequest> {
    const existing = await db.txRequest.findUnique({
      where: { idempotencyKey: req.idempotencyKey },
    });
    if (existing) return existing;
    try {
      return await db.txRequest.create({
        data: {
          idempotencyKey: req.idempotencyKey,
          kind: req.kind,
          to: req.to,
          data: req.data,
          status: "QUEUED",
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return db.txRequest.findUniqueOrThrow({ where: { idempotencyKey: req.idempotencyKey } });
      }
      throw err;
    }
  }

  /** Puts a FAILED/CONFIRMED request back in the queue (used by the check-in confirmer). */
  async requeue(id: number, reason: string): Promise<void> {
    await this.o.db.txRequest.update({
      where: { id },
      data: { status: "QUEUED", nonce: null, error: `requeued: ${reason}` },
    });
    this.notify();
  }

  /** Wakes the worker loop early (e.g. right after a check-in was accepted). */
  notify(): void {
    this.wake?.();
  }

  start(): void {
    if (this.loop) return;
    this.stopped = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.notify();
    await this.loop;
    this.loop = undefined;
  }

  status() {
    return {
      address: this.o.sender.address.toLowerCase(),
      balanceWei: this.balance,
      low: this.balance !== null && this.balance < this.o.lowBalanceWei,
    };
  }

  async refreshBalance(): Promise<bigint> {
    this.balance = await this.o.sender.getBalance();
    if (this.balance < this.o.lowBalanceWei) {
      this.o.logger.error(
        { balanceWei: this.balance.toString(), threshold: this.o.lowBalanceWei.toString() },
        "relayer balance is low",
      );
    }
    return this.balance;
  }

  private async run() {
    while (!this.stopped) {
      try {
        await this.processOnce();
      } catch (err) {
        this.o.logger.error({ err: errorMessage(err) }, "relayer round failed");
      }
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.o.pollMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
  }

  /** One worker round: submit queued requests, then monitor submitted ones. */
  processOnce(): Promise<void> {
    return this.mutex.run(async () => {
      await this.submitQueued();
      await this.monitorSubmitted();
    });
  }

  private async ensureNonce(): Promise<number> {
    if (this.nonce === null) {
      const chain = await this.o.sender.getPendingNonce();
      const stored = await this.o.db.txRequest.aggregate({
        _max: { nonce: true },
        where: { status: "SUBMITTED" },
      });
      // Signed-but-not-broadcast rows (crash) must not have their nonce reused.
      this.nonce = Math.max(chain, (stored._max.nonce ?? -1) + 1);
    }
    return this.nonce;
  }

  private async resyncNonce() {
    this.nonce = null;
    return this.ensureNonce();
  }

  private capFees(fees: TxFees): TxFees {
    const maxFeePerGas = min(fees.maxFeePerGas, this.o.maxFeePerGasWei);
    return { maxFeePerGas, maxPriorityFeePerGas: min(fees.maxPriorityFeePerGas, maxFeePerGas) };
  }

  private async submitQueued() {
    const queued = await this.o.db.txRequest.findMany({
      where: { status: "QUEUED" },
      orderBy: { id: "asc" },
      take: 25,
    });
    for (const req of queued) {
      await this.ensureNonce();
      let gas: bigint;
      try {
        gas = await this.o.sender.estimateGas({ to: req.to as Hex, data: req.data as Hex });
      } catch (err) {
        if (err instanceof RevertError) {
          // TicketUsed: the ticket is already used on-chain; the projector will mark it USED.
          const status: TxStatus = err.reason === "TicketUsed" ? "REVERTED" : "FAILED";
          await this.o.db.txRequest.update({
            where: { id: req.id },
            data: { status, error: err.reason },
          });
          this.o.logger.warn(
            { id: req.id, key: req.idempotencyKey, reason: err.reason },
            `tx ${status}`,
          );
          continue;
        }
        throw err; // transient RPC problem: try again next round
      }
      const fees = this.capFees(await this.o.sender.estimateFees());
      await this.sendNew(req, (gas * 120n) / 100n, fees);
    }
  }

  private async sendNew(req: TxRequest, gas: bigint, fees: TxFees) {
    const previous = parseAttempts(req);
    for (let tries = 0; tries < 3; tries++) {
      const nonce = await this.ensureNonce();
      const signed = await this.o.sender.sign({
        to: req.to as Hex,
        data: req.data as Hex,
        nonce,
        gas,
        ...fees,
      });
      const attempt: Attempt = {
        hash: signed.hash,
        nonce,
        gas: gas.toString(),
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
        sentAt: this.clock(),
      };
      // Persist before broadcasting: after a crash we know the hash and nonce we may have sent.
      await this.o.db.txRequest.update({
        where: { id: req.id },
        data: {
          status: "SUBMITTED",
          nonce,
          lastHash: signed.hash,
          error: null,
          attempts: JSON.stringify([...previous, attempt]),
        },
      });
      this.nonce = nonce + 1;

      try {
        await this.o.sender.broadcast(signed.raw);
        this.o.logger.info(
          { id: req.id, key: req.idempotencyKey, nonce, hash: signed.hash },
          "tx submitted",
        );
        return;
      } catch (err) {
        if (err instanceof NonceTooLowError) {
          this.o.logger.warn({ id: req.id, nonce }, "nonce too low, resyncing from chain");
          await this.resyncNonce();
          continue;
        }
        // Unknown broadcast failure: stay SUBMITTED; the monitor rebroadcasts once it looks stuck.
        this.o.logger.warn({ id: req.id, err: errorMessage(err) }, "broadcast failed, will retry");
        return;
      }
    }
    await this.o.db.txRequest.update({
      where: { id: req.id },
      data: { status: "QUEUED", nonce: null, attempts: JSON.stringify(previous) },
    });
  }

  private async findReceipt(attempts: Attempt[]) {
    for (const a of [...attempts].reverse()) {
      const receipt = await this.o.sender.getReceipt(a.hash);
      if (receipt) return { attempt: a, receipt };
    }
    return null;
  }

  private async monitorSubmitted() {
    const submitted = await this.o.db.txRequest.findMany({
      where: { status: "SUBMITTED" },
      orderBy: { id: "asc" },
    });
    for (const req of submitted) {
      const attempts = parseAttempts(req);
      const found = await this.findReceipt(attempts);
      if (found) {
        const ok = found.receipt.status === "success";
        await this.o.db.txRequest.update({
          where: { id: req.id },
          data: {
            status: ok ? "CONFIRMED" : "REVERTED",
            lastHash: found.attempt.hash,
            error: ok ? null : "REVERTED_ONCHAIN",
          },
        });
        this.o.logger.info(
          {
            id: req.id,
            key: req.idempotencyKey,
            hash: found.attempt.hash,
            block: found.receipt.blockNumber.toString(),
          },
          ok ? "tx confirmed" : "tx reverted on-chain",
        );
        continue;
      }
      const last = attempts.at(-1);
      if (last && this.clock() - last.sentAt >= this.o.stuckMs)
        await this.speedUp(req, attempts, last);
    }
  }

  /** Re-sends a stuck tx with the same nonce and fees bumped by >= 12.5 % (capped). */
  private async speedUp(req: TxRequest, attempts: Attempt[], last: Attempt) {
    const current = await this.o.sender.estimateFees();
    const fees = this.capFees({
      maxFeePerGas: max(bump(big(last.maxFeePerGas)), current.maxFeePerGas),
      maxPriorityFeePerGas: max(bump(big(last.maxPriorityFeePerGas)), current.maxPriorityFeePerGas),
    });
    const atCap = fees.maxFeePerGas <= big(last.maxFeePerGas);
    const use = atCap
      ? {
          maxFeePerGas: big(last.maxFeePerGas),
          maxPriorityFeePerGas: big(last.maxPriorityFeePerGas),
        }
      : fees;

    const signed = await this.o.sender.sign({
      to: req.to as Hex,
      data: req.data as Hex,
      nonce: last.nonce,
      gas: big(last.gas),
      ...use,
    });
    const attempt: Attempt = {
      hash: signed.hash,
      nonce: last.nonce,
      gas: last.gas,
      maxFeePerGas: use.maxFeePerGas.toString(),
      maxPriorityFeePerGas: use.maxPriorityFeePerGas.toString(),
      sentAt: this.clock(),
    };
    const next = atCap ? [...attempts.slice(0, -1), attempt] : [...attempts, attempt];
    await this.o.db.txRequest.update({
      where: { id: req.id },
      data: { attempts: JSON.stringify(next), lastHash: signed.hash },
    });
    this.o.logger.warn(
      { id: req.id, nonce: last.nonce, maxFeePerGas: attempt.maxFeePerGas, atCap },
      atCap ? "tx stuck at fee cap, rebroadcasting" : "tx stuck, bumping fees",
    );

    try {
      await this.o.sender.broadcast(signed.raw);
    } catch (err) {
      if (err instanceof NonceTooLowError) {
        // One of our attempts was mined (receipt shows up next round) or the nonce was consumed elsewhere.
        if (!(await this.findReceipt(next))) {
          await this.o.db.txRequest.update({
            where: { id: req.id },
            data: { status: "FAILED", error: "NONCE_CONSUMED" },
          });
          await this.resyncNonce();
        }
        return;
      }
      this.o.logger.warn({ id: req.id, err: errorMessage(err) }, "rebroadcast failed");
    }
  }
}
