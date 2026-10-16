/**
 * Starts a throwaway stack for the browser tests: hardhat node → deploy → backend (src/main.ts)
 * on dedicated ports with a fresh SQLite file. Stops everything on SIGINT/SIGTERM.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { deploy, startNode } from "../test/e2e/harness.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const API_PORT = process.env.E2E_API_PORT ?? "3199";
const dbFile = path.join(ROOT, "test", ".tmp", "web-e2e.db");

mkdirSync(path.dirname(dbFile), { recursive: true });
for (const s of ["", "-journal", "-wal", "-shm"]) rmSync(dbFile + s, { force: true });
const env = { ...process.env, DATABASE_URL: `file:${dbFile}` };
execFileSync(
  process.execPath,
  [path.join(ROOT, "node_modules", "prisma", "build", "index.js"), "migrate", "deploy"],
  {
    cwd: ROOT,
    env,
    stdio: "ignore",
  },
);

const node = await startNode(Number(process.env.E2E_RPC_PORT ?? 8547));
const { address, deployBlock } = await deploy(node);
console.log(`[e2e-stack] chain ${node.rpcUrl}, contract ${address}`);

const backend: ChildProcess = spawn(
  process.execPath,
  [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), path.join(ROOT, "src", "main.ts")],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...env,
      NODE_ENV: "test",
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
      PORT: API_PORT,
      HOST: "127.0.0.1",
      PUBLIC_BASE_URL: `http://127.0.0.1:${API_PORT}`,
      RPC_URL: node.rpcUrl,
      CHAIN_ID: "31337",
      CONTRACT_ADDRESS: address,
      START_BLOCK: deployBlock.toString(),
      INDEXER_POLL_MS: "250",
      RELAYER_POLL_MS: "250",
      JWT_SECRET: "e2e-secret-e2e-secret-e2e-secret",
      RELAYER_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    },
  },
);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  backend.kill();
  await node.stop();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
backend.on("exit", (code) => {
  if (!stopping) {
    console.error(`[e2e-stack] backend exited with ${code}`);
    void stop();
  }
});
