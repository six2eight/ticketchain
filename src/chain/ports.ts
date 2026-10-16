/**
 * Chain interfaces used by the indexer, relayer and check-in service.
 * They never import viem directly; viem implementations live in `chain/clients.ts`,
 * and tests use in-memory fakes.
 */

export type Hex = `0x${string}`;

/** A decoded contract log. `args` holds raw decoded values (bigints allowed). */
export interface ChainLog {
  blockNumber: bigint;
  blockHash: Hex;
  txHash: Hex;
  logIndex: number;
  eventName: string;
  args: Record<string, unknown>;
}

export interface ChainReader {
  getBlockNumber(): Promise<bigint>;
  /** Hash of the canonical block at `number`, or null if the chain is shorter. */
  getBlockHash(number: bigint): Promise<Hex | null>;
  /** Decoded logs of the TicketChain contract in [fromBlock, toBlock], ordered by (block, logIndex). */
  getLogs(fromBlock: bigint, toBlock: bigint): Promise<ChainLog[]>;
}

/** The RPC refused a getLogs request because the range or result set is too large. */
export class RangeTooLargeError extends Error {
  constructor(message = "block range too large") {
    super(message);
    this.name = "RangeTooLargeError";
  }
}

export interface TxFees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface TxCall {
  to: Hex;
  data: Hex;
}

export interface UnsignedTx extends TxCall, TxFees {
  nonce: number;
  gas: bigint;
}

export interface SignedTx {
  hash: Hex;
  raw: Hex;
}

export interface TxReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
}

export interface TxSender {
  readonly address: Hex;
  /** Next nonce including pending transactions. */
  getPendingNonce(): Promise<number>;
  /** Throws `RevertError` when the call would revert. */
  estimateGas(call: TxCall): Promise<bigint>;
  estimateFees(): Promise<TxFees>;
  sign(tx: UnsignedTx): Promise<SignedTx>;
  /** Throws `NonceTooLowError` when the nonce was already used. "Already known" is not an error. */
  broadcast(raw: Hex): Promise<void>;
  getReceipt(hash: Hex): Promise<TxReceipt | null>;
  getBalance(): Promise<bigint>;
}

/** The transaction would revert; `reason` is the decoded custom error name when known. */
export class RevertError extends Error {
  constructor(public readonly reason: string) {
    super(`execution reverted: ${reason}`);
    this.name = "RevertError";
  }
}

export class NonceTooLowError extends Error {
  constructor(message = "nonce too low") {
    super(message);
    this.name = "NonceTooLowError";
  }
}
