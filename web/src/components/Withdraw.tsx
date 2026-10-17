import { useQuery } from "@tanstack/react-query";
import { useConnection } from "wagmi";

import { eth, readContract, useAppConfig, useContractTx } from "../hooks";
import { TxStatus } from "./TxStatus";

/**
 * The wallet's pull-payment balance in the contract (ticket sales for organizers,
 * resale proceeds for sellers) with a Withdraw button.
 */
export function Withdraw({
  label,
  hideWhenEmpty = false,
}: {
  label: string;
  hideWhenEmpty?: boolean;
}) {
  const { address } = useConnection();
  const { data: cfg } = useAppConfig();
  const tx = useContractTx();
  const balance = useQuery({
    queryKey: ["pending", address, cfg?.contractAddress],
    enabled: Boolean(address && cfg),
    queryFn: () => readContract<bigint>(cfg!.contractAddress, "pendingWithdrawals", [address]),
    refetchInterval: 4000,
  });
  const amount = balance.data ?? 0n;
  // Keep the card visible right after a withdrawal so the confirmation stays on screen.
  if (hideWhenEmpty && amount === 0n && tx.state.status === "idle") return null;

  return (
    <div className="card row between">
      <div>
        <span className="label">{label}</span>
        <strong data-testid="withdrawable">{eth(amount)}</strong>
      </div>
      <button
        className="btn"
        disabled={amount === 0n || tx.state.status === "pending"}
        onClick={() =>
          void tx
            .send("Withdraw", "withdraw", [])
            .then(() => balance.refetch())
            .catch(() => undefined)
        }
      >
        Withdraw
      </button>
      <TxStatus state={tx.state} />
    </div>
  );
}
