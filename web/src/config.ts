import { createPublicClient, defineChain, http } from "viem";
import { createConfig } from "wagmi";
import { injected, mock } from "wagmi/connectors";

export const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:3000").replace(
  /\/+$/,
  "",
);
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? "http://127.0.0.1:8545";
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 31337);
export const DEV_WALLETS_ENABLED =
  (import.meta.env.VITE_DEV_WALLETS ?? (CHAIN_ID === 31337 ? "true" : "false")) === "true";

export const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 31337 ? "Hardhat" : `Chain ${CHAIN_ID}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

/** Public Hardhat accounts (unlocked on `hardhat node`). Never use on a real network. */
export const DEV_WALLETS = [
  { label: "Organizer (#2)", address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
  { label: "Buyer 1 (#3)", address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" },
  { label: "Buyer 2 (#4)", address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" },
  { label: "Buyer 3 (#5)", address: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc" },
  { label: "Staff (#6)", address: "0x976EA74026E726554dB657fA54763abd0C3a0aa9" },
] as const;

export const wagmiConfig = createConfig({
  chains: [chain],
  multiInjectedProviderDiscovery: false,
  connectors: [
    injected(),
    ...(DEV_WALLETS_ENABLED
      ? DEV_WALLETS.map((w) => mock({ accounts: [w.address], features: { reconnect: true } }))
      : []),
  ],
  transports: { [chain.id]: http(RPC_URL) },
});

export const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL),
  pollingInterval: 500,
});
