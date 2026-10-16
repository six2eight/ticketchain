import { useEffect, useRef } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect } from "wagmi";

import { DEV_WALLETS, DEV_WALLETS_ENABLED } from "../config";
import { short } from "../hooks";
import { useSession } from "../session";

const DEV_WALLET_KEY = "tc.devWallet";

export function WalletBar() {
  const { address, isConnected, connector, status } = useConnection();
  const restored = useRef(false);
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const session = useSession();

  const injected = connectors.find((c) => c.type === "injected");
  const mocks = connectors.filter((c) => c.type === "mock");
  const devLabel = DEV_WALLETS.find(
    (w) => w.address.toLowerCase() === address?.toLowerCase(),
  )?.label;

  // The mock connector keeps its "connected" flag in memory only; restore the dev wallet on reload.
  useEffect(() => {
    if (restored.current || status !== "disconnected") return; // let wagmi's own reconnect finish first
    restored.current = true;
    const saved = localStorage.getItem(DEV_WALLET_KEY);
    const c = saved === null ? undefined : mocks[Number(saved)];
    if (c) connect.mutate({ connector: c });
  }, [status, mocks, connect]);

  if (!isConnected || !address) {
    return (
      <div className="wallet">
        {injected && (
          <button
            className="btn"
            onClick={() => connect.mutate({ connector: injected })}
            disabled={connect.isPending}
          >
            Connect MetaMask
          </button>
        )}
        {DEV_WALLETS_ENABLED && (
          <select
            aria-label="Dev wallet"
            className="select"
            value=""
            onChange={(e) => {
              const c = mocks[Number(e.target.value)];
              if (!c) return;
              localStorage.setItem(DEV_WALLET_KEY, e.target.value);
              connect.mutate({ connector: c });
            }}
          >
            <option value="" disabled>
              Use a dev wallet…
            </option>
            {DEV_WALLETS.map((w, i) => (
              <option key={w.address} value={i}>
                {w.label}
              </option>
            ))}
          </select>
        )}
        {connect.error && <span className="muted small">{connect.error.message}</span>}
      </div>
    );
  }

  return (
    <div className="wallet">
      <span className="pill" title={address} data-testid="connected-address">
        {devLabel ? `${devLabel} · ` : ""}
        {short(address)}
      </span>
      {session.token ? (
        <span className="pill ok" data-testid="signed-in">
          Signed in
        </span>
      ) : (
        <button
          className="btn primary"
          onClick={() => void session.signIn().catch(() => undefined)}
          disabled={session.signingIn}
        >
          {session.signingIn ? "Signing…" : "Sign in"}
        </button>
      )}
      <button
        className="btn ghost"
        onClick={() => {
          session.signOut();
          localStorage.removeItem(DEV_WALLET_KEY);
          disconnect.mutate({ connector });
        }}
      >
        Disconnect
      </button>
      {session.error && <span className="muted small">{session.error}</span>}
    </div>
  );
}

/** Shown on pages that need a SIWE session. */
export function RequireSession({ children }: { children: React.ReactNode }) {
  const { isConnected } = useConnection();
  const session = useSession();
  if (!isConnected) return <p className="empty">Connect a wallet to continue.</p>;
  if (!session.token) {
    return (
      <div className="empty">
        <p>Sign in with your wallet to continue (one signature, no gas).</p>
        <button
          className="btn primary"
          onClick={() => void session.signIn().catch(() => undefined)}
          disabled={session.signingIn}
        >
          Sign in with Ethereum
        </button>
      </div>
    );
  }
  return <>{children}</>;
}
