/** E2E harness: a real Hardhat node (child process), the real contract and the real backend. */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  type Abi,
  type Hex,
  type PublicClient,
} from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";

import { buildApp } from "../../src/api/server.js";
import type { App } from "../../src/api/types.js";
import { ticketChainAbi } from "../../src/chain/abi.js";
import {
  makeChain,
  makePublicClient,
  ViemChainReader,
  ViemTxSender,
} from "../../src/chain/clients.js";
import { CheckinService } from "../../src/checkin/checkin.service.js";
import { Indexer } from "../../src/indexer/indexer.js";
import { silentLogger } from "../../src/lib/logger.js";
import { sleep } from "../../src/lib/time.js";
import { Relayer } from "../../src/relayer/relayer.js";
import { testConfig } from "../helpers/app.js";
import { createTestDb, type TestDb } from "../helpers/db.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const MNEMONIC = "test test test test test test test test test test test junk";
export const RELAYER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

export const accounts = {
  admin: mnemonicToAccount(MNEMONIC, { addressIndex: 0 }),
  organizer: mnemonicToAccount(MNEMONIC, { addressIndex: 2 }),
  buyer1: mnemonicToAccount(MNEMONIC, { addressIndex: 3 }),
  buyer2: mnemonicToAccount(MNEMONIC, { addressIndex: 4 }),
  buyer3: mnemonicToAccount(MNEMONIC, { addressIndex: 5 }),
  staff: mnemonicToAccount(MNEMONIC, { addressIndex: 6 }),
};

export interface Node {
  rpcUrl: string;
  client: PublicClient;
  stop(): Promise<void>;
}

/** Starts `hardhat node` on a random port (works the same on Windows, macOS and Linux). */
export async function startNode(port = 20_000 + Math.floor(Math.random() * 20_000)): Promise<Node> {
  const rpcUrl = `http://127.0.0.1:${port}`;
  const cli = path.join(ROOT, "node_modules", "hardhat", "dist", "src", "cli.js");
  const proc: ChildProcess = spawn(process.execPath, [cli, "node", "--port", String(port)], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const client = createPublicClient({
    chain: makeChain(31337, rpcUrl),
    transport: http(rpcUrl),
    pollingInterval: 100,
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await client.getBlockNumber();
      break;
    } catch {
      if (Date.now() > deadline || proc.exitCode !== null)
        throw new Error("hardhat node did not start");
      await sleep(250);
    }
  }
  return {
    rpcUrl,
    client,
    async stop() {
      if (proc.exitCode !== null) return;
      const exited = new Promise((r) => proc.once("exit", r));
      proc.kill();
      await exited;
    },
  };
}

export async function deploy(node: Node) {
  const file = path.join(ROOT, "artifacts", "contracts", "TicketChain.sol", "TicketChain.json");
  if (!existsSync(file)) throw new Error('Contract artifact missing — run "npm run compile" first');
  const artifact = JSON.parse(readFileSync(file, "utf8")) as { abi: Abi; bytecode: Hex };
  const admin = wallet(node, accounts.admin);
  const hash = await admin.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: ["http://localhost/metadata/"],
  });
  const receipt = await node.client.waitForTransactionReceipt({ hash });
  const address = receipt.contractAddress!;
  const grant = await admin.writeContract({
    address,
    abi: ticketChainAbi,
    functionName: "grantRole",
    args: [keccak256(toHex("RELAYER_ROLE")), "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"],
  });
  await node.client.waitForTransactionReceipt({ hash: grant });
  return { address, deployBlock: receipt.blockNumber };
}

export function wallet(node: Node, account: HDAccount) {
  return createWalletClient({
    account,
    chain: makeChain(31337, node.rpcUrl),
    transport: http(node.rpcUrl),
  });
}

/** Sends a contract write as `account` and waits for the receipt. */
export async function write(
  node: Node,
  contract: Hex,
  account: HDAccount,
  functionName: string,
  args: readonly unknown[],
  value?: bigint,
) {
  const hash = await wallet(node, account).writeContract({
    address: contract,
    abi: ticketChainAbi,
    functionName: functionName as never,
    args: args as never,
    value,
  } as never);
  const receipt = await node.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return receipt;
}

export interface Backend {
  app: App;
  baseUrl: string;
  t: TestDb;
  indexer: Indexer;
  relayer: Relayer;
  stop(opts?: { keepDb?: boolean }): Promise<void>;
}

/** Runs indexer + relayer + API in-process against the node, like `src/main.ts`. */
export async function startBackend(
  node: Node,
  contract: Hex,
  startBlock: bigint,
  t: TestDb = createTestDb(),
): Promise<Backend> {
  const config = testConfig({
    CONTRACT_ADDRESS: contract,
    START_BLOCK: String(startBlock),
    RPC_URL: node.rpcUrl,
    PORT: "0",
  });
  const logger = silentLogger();
  const client = makePublicClient({ chainId: 31337, rpcUrl: node.rpcUrl });
  const indexer = new Indexer({
    db: t.db,
    chain: new ViemChainReader(client, contract),
    logger,
    contractAddress: contract,
    startBlock,
    confirmations: 0,
    batchSize: 2000,
    pollMs: 100,
  });
  const relayer = new Relayer({
    db: t.db,
    sender: new ViemTxSender(client, RELAYER_KEY, 31337),
    logger,
    pollMs: 100,
    stuckMs: 30_000,
    maxFeePerGasWei: 200_000_000_000n,
    lowBalanceWei: config.LOW_BALANCE_WEI,
  });
  const checkin = new CheckinService({
    db: t.db,
    relayer,
    logger,
    chainId: 31337,
    contract,
    ttlSeconds: 30,
    windowBeforeS: config.CHECKIN_WINDOW_BEFORE_S,
    windowAfterS: config.CHECKIN_WINDOW_AFTER_S,
  });
  const app = await buildApp({
    config,
    db: t.db,
    logger,
    clock: Date.now,
    indexer,
    relayer,
    checkin,
    chainHead: () => client.getBlockNumber({ cacheTime: 0 }),
  });
  await indexer.init();
  indexer.start();
  relayer.start();
  await relayer.refreshBalance();
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    app,
    baseUrl: address,
    t,
    indexer,
    relayer,
    async stop(opts = {}) {
      await app.close();
      await relayer.stop();
      await indexer.stop();
      if (!opts.keepDb) await t.cleanup();
    },
  };
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(100);
  }
}
