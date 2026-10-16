import { createHash } from "node:crypto";

import {
  NonceTooLowError,
  RevertError,
  type Hex,
  type SignedTx,
  type TxCall,
  type TxFees,
  type TxReceipt,
  type TxSender,
  type UnsignedTx,
} from "../../src/chain/ports.js";

const ser = (tx: UnsignedTx) =>
  JSON.stringify(tx, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

/**
 * In-memory relayer wallet + mempool. With `autoMine` a broadcast with the next nonce is mined
 * immediately; otherwise txs wait in the mempool until `mine()`.
 */
export class FakeTxSender implements TxSender {
  readonly address: Hex = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
  /** Nonce of the next tx to be mined (= mined tx count). */
  chainNonce = 0;
  autoMine = true;
  balance = 10n ** 18n;
  fees: TxFees = { maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
  /** Return a custom error name to make estimateGas revert for that call. */
  revertReason: (call: TxCall) => string | undefined = () => undefined;
  /** The next broadcast throws this error (once). */
  failNextBroadcast: Error | undefined;
  /** Mined txs revert on-chain when this returns true. */
  revertOnChain: (tx: UnsignedTx) => boolean = () => false;

  readonly broadcasts: (UnsignedTx & { hash: Hex })[] = [];
  readonly pending = new Map<Hex, UnsignedTx>();
  readonly receipts = new Map<Hex, TxReceipt>();
  private readonly signed = new Map<Hex, UnsignedTx>();
  private block = 100n;

  async getPendingNonce() {
    const nonces = [...this.pending.values()].map((t) => t.nonce);
    return Math.max(this.chainNonce, ...nonces.map((n) => n + 1));
  }

  async estimateGas(call: TxCall) {
    const reason = this.revertReason(call);
    if (reason) throw new RevertError(reason);
    return 50_000n;
  }

  async estimateFees() {
    return { ...this.fees };
  }

  async sign(tx: UnsignedTx): Promise<SignedTx> {
    const raw = `0x${Buffer.from(ser(tx)).toString("hex")}` as Hex;
    const hash = `0x${createHash("sha256").update(raw).digest("hex")}` as Hex;
    this.signed.set(hash, tx);
    return { hash, raw };
  }

  async broadcast(raw: Hex) {
    if (this.failNextBroadcast) {
      const err = this.failNextBroadcast;
      this.failNextBroadcast = undefined;
      throw err;
    }
    const hash = `0x${createHash("sha256").update(raw).digest("hex")}` as Hex;
    const tx = this.signed.get(hash);
    if (!tx) throw new Error("unknown raw tx");
    if (this.receipts.has(hash) || this.pending.has(hash)) return; // already known
    if (tx.nonce < this.chainNonce) throw new NonceTooLowError();
    this.broadcasts.push({ ...tx, hash });
    // Same-nonce replacement: drop the cheaper pending tx.
    for (const [h, p] of this.pending) if (p.nonce === tx.nonce) this.pending.delete(h);
    this.pending.set(hash, tx);
    if (this.autoMine) this.mine();
  }

  /** Mines all pending txs that are next in nonce order. */
  mine() {
    for (;;) {
      const next = [...this.pending.entries()].find(([, t]) => t.nonce === this.chainNonce);
      if (!next) return;
      const [hash, tx] = next;
      this.pending.delete(hash);
      this.receipts.set(hash, {
        status: this.revertOnChain(tx) ? "reverted" : "success",
        blockNumber: this.block++,
      });
      this.chainNonce++;
    }
  }

  /** Simulates another process using the same wallet. */
  consumeNoncesExternally(count: number) {
    this.chainNonce += count;
  }

  async getReceipt(hash: Hex) {
    return this.receipts.get(hash) ?? null;
  }

  async getBalance() {
    return this.balance;
  }
}
