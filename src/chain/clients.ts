import {
  BaseError,
  createPublicClient,
  decodeErrorResult,
  decodeEventLog,
  defineChain,
  fallback,
  http,
  keccak256,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ticketChainAbi } from "./abi.js";
import {
  NonceTooLowError,
  RangeTooLargeError,
  RevertError,
  type ChainLog,
  type ChainReader,
  type Hex,
  type SignedTx,
  type TxCall,
  type TxFees,
  type TxReceipt,
  type TxSender,
  type UnsignedTx,
} from "./ports.js";

export function makeChain(chainId: number, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: chainId === 31337 ? "Hardhat" : `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export function makePublicClient(opts: {
  chainId: number;
  rpcUrl: string;
  rpcUrlFallback?: string;
}): PublicClient<Transport, Chain> {
  const transports = [http(opts.rpcUrl, { retryCount: 2, timeout: 10_000 })];
  if (opts.rpcUrlFallback) transports.push(http(opts.rpcUrlFallback, { retryCount: 2 }));
  return createPublicClient({
    chain: makeChain(opts.chainId, opts.rpcUrl),
    transport: transports.length > 1 ? fallback(transports) : transports[0]!,
    pollingInterval: 1000,
  });
}

const RANGE_ERROR =
  /range|too many|limit exceeded|response size|block range|query returned more than|10000 results/i;

function messageOf(err: unknown): string {
  if (err instanceof BaseError) return `${err.shortMessage} ${err.details ?? ""} ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export class ViemChainReader implements ChainReader {
  constructor(
    private readonly client: PublicClient<Transport, Chain>,
    private readonly address: Hex,
  ) {}

  getBlockNumber() {
    return this.client.getBlockNumber({ cacheTime: 0 });
  }

  async getBlockHash(number: bigint): Promise<Hex | null> {
    try {
      const block = await this.client.getBlock({ blockNumber: number });
      return block.hash;
    } catch (err) {
      if (err instanceof BaseError && err.name === "BlockNotFoundError") return null;
      throw err;
    }
  }

  async getLogs(fromBlock: bigint, toBlock: bigint): Promise<ChainLog[]> {
    let logs;
    try {
      logs = await this.client.getLogs({ address: this.address, fromBlock, toBlock });
    } catch (err) {
      if (RANGE_ERROR.test(messageOf(err))) throw new RangeTooLargeError(messageOf(err));
      throw err;
    }

    const out: ChainLog[] = [];
    for (const log of logs) {
      if (log.blockHash === null || log.transactionHash === null || log.logIndex === null) continue;
      let decoded;
      try {
        decoded = decodeEventLog({ abi: ticketChainAbi, data: log.data, topics: log.topics });
      } catch {
        continue; // not one of our events
      }
      out.push({
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        eventName: decoded.eventName,
        args: (decoded.args ?? {}) as Record<string, unknown>,
      });
    }
    return out.sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : a.blockNumber < b.blockNumber
          ? -1
          : 1,
    );
  }
}

/** Finds revert data in a viem error chain and decodes it with the TicketChain ABI. */
export function decodeRevertReason(err: unknown): string | undefined {
  if (err instanceof BaseError) {
    const withData = err.walk((e) => {
      const data = (e as { data?: unknown }).data;
      return typeof data === "string" && data.startsWith("0x") && data.length >= 10;
    }) as { data?: Hex } | null;
    if (withData?.data) {
      try {
        return decodeErrorResult({ abi: ticketChainAbi, data: withData.data }).errorName;
      } catch {
        // fall through to message parsing
      }
    }
  }
  const msg = messageOf(err);
  const custom = /custom error '?([A-Za-z0-9_]+)\(/.exec(msg);
  if (custom?.[1]) return custom[1];
  if (/execution reverted|reverted/i.test(msg)) {
    const reason = /reverted(?: with reason string)?:? '?([^'\n]+)'?/i.exec(msg)?.[1]?.trim();
    return reason || "UNKNOWN_REVERT";
  }
  return undefined;
}

export class ViemTxSender implements TxSender {
  readonly address: Hex;
  private readonly account;

  constructor(
    private readonly client: PublicClient<Transport, Chain>,
    privateKey: Hex,
    private readonly chainId: number,
  ) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
  }

  getPendingNonce() {
    return this.client.getTransactionCount({ address: this.address, blockTag: "pending" });
  }

  async estimateGas(call: TxCall): Promise<bigint> {
    try {
      return await this.client.estimateGas({ account: this.address, to: call.to, data: call.data });
    } catch (err) {
      const reason = decodeRevertReason(err);
      if (reason) throw new RevertError(reason);
      throw err;
    }
  }

  async estimateFees(): Promise<TxFees> {
    const fees = await this.client.estimateFeesPerGas({ type: "eip1559" });
    return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  }

  async sign(tx: UnsignedTx): Promise<SignedTx> {
    const raw = await this.account.signTransaction({
      type: "eip1559",
      chainId: this.chainId,
      to: tx.to,
      data: tx.data,
      nonce: tx.nonce,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    });
    return { raw, hash: keccak256(raw) };
  }

  async broadcast(raw: Hex): Promise<void> {
    try {
      await this.client.request({ method: "eth_sendRawTransaction", params: [raw] });
    } catch (err) {
      const msg = messageOf(err);
      if (/already known|known transaction|already imported/i.test(msg)) return;
      if (/nonce too low|nonce has already been used|nonce is too low/i.test(msg)) {
        throw new NonceTooLowError(msg);
      }
      throw err;
    }
  }

  async getReceipt(hash: Hex): Promise<TxReceipt | null> {
    try {
      const r = await this.client.getTransactionReceipt({ hash });
      return { status: r.status, blockNumber: r.blockNumber };
    } catch (err) {
      if (err instanceof BaseError && err.name === "TransactionReceiptNotFoundError") return null;
      throw err;
    }
  }

  getBalance() {
    return this.client.getBalance({ address: this.address });
  }
}
