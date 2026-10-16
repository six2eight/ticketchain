import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

const root = path.resolve(import.meta.dirname, "..");

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/, "must be a 0x-prefixed hex string");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte 0x address");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  PUBLIC_BASE_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1).default("file:./dev.db"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  CORS_ORIGIN: z.string().default("*"),

  CHAIN_ID: z.coerce.number().int().positive().default(31337),
  RPC_URL: z.url().default("http://127.0.0.1:8545"),
  RPC_URL_FALLBACK: optionalString.pipe(z.url().optional()),
  CONTRACT_ADDRESS: optionalString.pipe(address.optional()),
  START_BLOCK: optionalString
    .transform((v) => (v === undefined ? undefined : Number(v)))
    .pipe(z.number().int().min(0).optional()),
  DEPLOYMENT_NETWORK: optionalString,

  CONFIRMATIONS: z.coerce.number().int().min(0).default(0),
  INDEXER_BATCH_SIZE: z.coerce.number().int().positive().default(2000),
  INDEXER_POLL_MS: z.coerce.number().int().positive().default(2000),

  RELAYER_PRIVATE_KEY: hex.refine((v) => v.length === 66, "must be a 32-byte private key"),
  RELAYER_POLL_MS: z.coerce.number().int().positive().default(2000),
  RELAYER_STUCK_MS: z.coerce.number().int().positive().default(30_000),
  RELAYER_MAX_FEE_GWEI: z.coerce.number().positive().default(200),
  LOW_BALANCE_WEI: z
    .string()
    .regex(/^\d+$/)
    .default("50000000000000000")
    .transform((v) => BigInt(v)),

  JWT_SECRET: z.string().min(16, "must be at least 16 characters"),
  QR_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  CHECKIN_WINDOW_BEFORE_S: z.coerce
    .number()
    .int()
    .min(0)
    .default(6 * 3600),
  CHECKIN_WINDOW_AFTER_S: z.coerce
    .number()
    .int()
    .min(0)
    .default(24 * 3600),

  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_CHECKIN_PER_MIN: z.coerce.number().int().positive().default(300),
});

export type Env = z.infer<typeof envSchema>;

export interface Deployment {
  address: `0x${string}`;
  deployBlock: number;
  chainId: number;
}

export type Config = Env & {
  contractAddress: `0x${string}`;
  startBlock: bigint;
  deploymentFile?: string;
};

const networkForChain: Record<number, string> = { 31337: "localhost", 11155111: "sepolia" };

export function readDeployment(network: string, dir = path.join(root, "deployments")) {
  const file = path.join(dir, `${network}.json`);
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Deployment;
  return { file, deployment: parsed };
}

/** Loads `.env` (if present), validates it and resolves the contract from the deployments file. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { loadDotEnv?: boolean; deploymentsDir?: string } = {},
): Config {
  if (opts.loadDotEnv !== false && env === process.env && existsSync(path.join(root, ".env"))) {
    process.loadEnvFile(path.join(root, ".env"));
  }

  const result = envSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const cfg = result.data;

  let contractAddress = cfg.CONTRACT_ADDRESS as `0x${string}` | undefined;
  let startBlock = cfg.START_BLOCK;
  let deploymentFile: string | undefined;

  const network = cfg.DEPLOYMENT_NETWORK ?? networkForChain[cfg.CHAIN_ID];
  if ((!contractAddress || startBlock === undefined) && network) {
    const found = readDeployment(network, opts.deploymentsDir);
    if (found) {
      if (found.deployment.chainId !== cfg.CHAIN_ID) {
        throw new Error(
          `Invalid configuration: ${found.file} is for chain ${found.deployment.chainId}, CHAIN_ID is ${cfg.CHAIN_ID}`,
        );
      }
      deploymentFile = found.file;
      contractAddress ??= found.deployment.address;
      startBlock ??= found.deployment.deployBlock;
    }
  }

  if (!contractAddress) {
    throw new Error(
      "Invalid configuration: CONTRACT_ADDRESS is empty and no deployments file was found. " +
        'Run "npm run deploy:local" first or set CONTRACT_ADDRESS.',
    );
  }

  return { ...cfg, contractAddress, startBlock: BigInt(startBlock ?? 0), deploymentFile };
}
