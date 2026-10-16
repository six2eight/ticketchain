import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useConnection, useWalletClient } from "wagmi";

import { api } from "./api";

interface Session {
  address: `0x${string}` | undefined;
  token: string | null;
  signIn(): Promise<string>;
  signOut(): void;
  signingIn: boolean;
  error: string | null;
}

const SessionContext = createContext<Session | null>(null);
const key = (address: string) => `tc.jwt.${address.toLowerCase()}`;

function validToken(token: string | null): string | null {
  if (!token) return null;
  try {
    const payload = JSON.parse(
      atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: number };
    return payload.exp && payload.exp * 1000 > Date.now() + 60_000 ? token : null;
  } catch {
    return null;
  }
}

/** Sign-In With Ethereum session: one JWT per wallet, kept in localStorage. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const { address } = useConnection();
  const { data: walletClient } = useWalletClient();
  const [token, setToken] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setToken(address ? validToken(localStorage.getItem(key(address))) : null);
  }, [address]);

  const signIn = useCallback(async () => {
    if (!address || !walletClient) throw new Error("Connect a wallet first");
    setSigningIn(true);
    setError(null);
    try {
      const { message } = await api<{ message: string }>("POST", "/auth/nonce", {
        body: { address },
      });
      const signature = await walletClient.signMessage({ account: address, message });
      const res = await api<{ token: string }>("POST", "/auth/verify", {
        body: { message, signature },
      });
      localStorage.setItem(key(address), res.token);
      setToken(res.token);
      return res.token;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setSigningIn(false);
    }
  }, [address, walletClient]);

  const signOut = useCallback(() => {
    if (address) localStorage.removeItem(key(address));
    setToken(null);
  }, [address]);

  const value = useMemo(
    () => ({ address, token, signIn, signOut, signingIn, error }),
    [address, token, signIn, signOut, signingIn, error],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}
