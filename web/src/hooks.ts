import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BaseError, formatEther, parseEther } from "viem";
import { useWalletClient } from "wagmi";

import { ticketChainAbi } from "../../src/chain/abi";
import { api, type PublicConfig } from "./api";
import { useSession } from "./session";
import { chain, publicClient } from "./config";

export function useAppConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: () => api<PublicConfig>("GET", "/config"),
    staleTime: Infinity,
  });
}

export interface Roles {
  organizerOf: number[];
  staffOf: number[];
}

/** Events the signed-in wallet organizes or staffs; empty when signed out. */
export function useRoles() {
  const { token, address } = useSession();
  const roles = useQuery({
    queryKey: ["me", "roles", address, token],
    enabled: Boolean(token),
    queryFn: () => api<Roles>("GET", "/me/roles", { token }),
    refetchInterval: 5000,
  });
  const organizerOf = roles.data?.organizerOf ?? [];
  const staffOf = roles.data?.staffOf ?? [];
  return {
    isOrganizer: organizerOf.length > 0,
    canScan: organizerOf.length > 0 || staffOf.length > 0,
    organizerOf,
    staffOf,
  };
}

export const eth = (wei: string | bigint) => `${formatEther(BigInt(wei))} ETH`;
export const toWei = (ether: string) => parseEther(ether.trim() === "" ? "0" : ether.trim());
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function errorText(err: unknown): string {
  if (err instanceof BaseError) {
    const reason = err.walk(
      (e) => (e as { data?: { errorName?: string } }).data?.errorName !== undefined,
    ) as { data?: { errorName?: string } } | null;
    return reason?.data?.errorName ?? err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

type TxState =
  | { status: "idle" }
  | { status: "pending"; label: string }
  | { status: "done"; label: string }
  | { status: "error"; label: string; message: string };

/** Sends a TicketChain transaction from the connected wallet and waits for the receipt. */
export function useContractTx() {
  const { data: walletClient } = useWalletClient();
  const { data: cfg } = useAppConfig();
  const queryClient = useQueryClient();
  const [state, setState] = useState<TxState>({ status: "idle" });

  async function send(
    label: string,
    functionName: string,
    args: readonly unknown[],
    value?: bigint,
  ) {
    if (!walletClient || !cfg) throw new Error("Connect a wallet first");
    setState({ status: "pending", label });
    try {
      // A tx to an address without code "succeeds" but does nothing (e.g. chain restarted, not redeployed).
      const code = await publicClient.getCode({ address: cfg.contractAddress });
      if (!code || code === "0x") {
        throw new Error(
          `No TicketChain contract at ${cfg.contractAddress} on this chain. Run "npm run deploy:local".`,
        );
      }
      // The ABI is fully typed; dynamic function names are validated by viem at runtime.
      const hash = await walletClient.writeContract({
        chain,
        account: walletClient.account,
        address: cfg.contractAddress,
        abi: ticketChainAbi,
        functionName: functionName as never,
        args: args as never,
        value,
      } as never);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Transaction reverted");
      setState({ status: "done", label });
      // The indexer picks the change up within a couple of seconds.
      for (const delay of [500, 1500, 3000, 6000]) {
        setTimeout(() => void queryClient.invalidateQueries(), delay);
      }
      return receipt;
    } catch (err) {
      setState({ status: "error", label, message: errorText(err) });
      throw err;
    }
  }

  return { send, state, reset: () => setState({ status: "idle" }) };
}

export async function readContract<T>(
  contract: `0x${string}`,
  functionName: string,
  args: readonly unknown[] = [],
) {
  return (await publicClient.readContract({
    address: contract,
    abi: ticketChainAbi,
    functionName: functionName as never,
    args: args as never,
  })) as T;
}
