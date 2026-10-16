import type { useContractTx } from "../hooks";

export function TxStatus({ state }: { state: ReturnType<typeof useContractTx>["state"] }) {
  if (state.status === "idle") return null;
  if (state.status === "pending")
    return (
      <p className="notice info" role="status">
        ⏳ {state.label}: waiting for confirmation…
      </p>
    );
  if (state.status === "done")
    return (
      <p className="notice ok" role="status">
        ✅ {state.label}: confirmed
      </p>
    );
  return (
    <p className="notice error" role="alert">
      ❌ {state.label} failed: {state.message}
    </p>
  );
}
