/** Shared helpers for scripts that talk to the local Hardhat node (seed, demo). */
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { ticketChainAbi } from "../../src/chain/abi.js";
import { makeChain } from "../../src/chain/clients.js";
import { readDeployment } from "../../src/config.js";

// Public Hardhat test mnemonic — local development only.
export const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

export const ROLES = {
  admin: 0,
  relayer: 1,
  organizer: 2,
  buyer1: 3,
  buyer2: 4,
  buyer3: 5,
  staff: 6,
} as const;

export function localSetup(
  rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545",
  chainId = 31337,
) {
  const found = readDeployment(process.env.DEPLOYMENT_NETWORK ?? "localhost");
  if (!found)
    throw new Error('deployments/localhost.json not found. Run "npm run deploy:local" first.');
  const chain = makeChain(chainId, rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 200 });
  const account = (index: number) => mnemonicToAccount(HARDHAT_MNEMONIC, { addressIndex: index });
  const wallet = (index: number) =>
    createWalletClient({ account: account(index), chain, transport: http(rpcUrl) });
  const address = found.deployment.address as Hex;

  async function write(
    index: number,
    functionName: string,
    args: readonly unknown[],
    value?: bigint,
  ): Promise<Hex> {
    const w = wallet(index);
    // Typed per-call ABI inference is not worth it for scripts; viem validates at runtime.
    const hash = await w.writeContract({
      address,
      abi: ticketChainAbi,
      functionName: functionName as never,
      args: args as never,
      value,
    } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
    return hash;
  }

  async function read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return (await publicClient.readContract({
      address,
      abi: ticketChainAbi,
      functionName: functionName as never,
      args: args as never,
    })) as T;
  }

  return {
    chain,
    publicClient,
    account,
    wallet,
    address,
    write,
    read,
    deployment: found.deployment,
  };
}
