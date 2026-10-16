import { buildApp } from "./api/server.js";
import { CheckinService } from "./checkin/checkin.service.js";
import { makePublicClient, ViemChainReader, ViemTxSender } from "./chain/clients.js";
import { loadConfig } from "./config.js";
import { createPrisma } from "./db/client.js";
import { Indexer } from "./indexer/indexer.js";
import { cleanupExpiredNonces, runCheckinConfirmer } from "./jobs/checkin-confirmer.js";
import { IntervalJob } from "./jobs/interval-job.js";
import { errorMessage } from "./lib/errors.js";
import { createLogger } from "./lib/logger.js";
import { systemClock } from "./lib/time.js";
import { Relayer } from "./relayer/relayer.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(errorMessage(err));
  process.exit(1);
}

const logger = createLogger({ level: config.LOG_LEVEL, pretty: config.NODE_ENV === "development" });
const db = createPrisma(config.DATABASE_URL);
const publicClient = makePublicClient({
  chainId: config.CHAIN_ID,
  rpcUrl: config.RPC_URL,
  rpcUrlFallback: config.RPC_URL_FALLBACK,
});
const clock = systemClock;

const indexer = new Indexer({
  db,
  chain: new ViemChainReader(publicClient, config.contractAddress),
  logger: logger.child({ component: "indexer" }),
  contractAddress: config.contractAddress,
  startBlock: config.startBlock,
  confirmations: config.CONFIRMATIONS,
  batchSize: config.INDEXER_BATCH_SIZE,
  pollMs: config.INDEXER_POLL_MS,
});

const relayer = new Relayer({
  db,
  sender: new ViemTxSender(
    publicClient,
    config.RELAYER_PRIVATE_KEY as `0x${string}`,
    config.CHAIN_ID,
  ),
  logger: logger.child({ component: "relayer" }),
  pollMs: config.RELAYER_POLL_MS,
  stuckMs: config.RELAYER_STUCK_MS,
  maxFeePerGasWei: BigInt(Math.round(config.RELAYER_MAX_FEE_GWEI * 1e9)),
  lowBalanceWei: config.LOW_BALANCE_WEI,
  clock,
});

const checkin = new CheckinService({
  db,
  relayer,
  logger: logger.child({ component: "checkin" }),
  chainId: config.CHAIN_ID,
  contract: config.contractAddress,
  ttlSeconds: config.QR_TTL_SECONDS,
  windowBeforeS: config.CHECKIN_WINDOW_BEFORE_S,
  windowAfterS: config.CHECKIN_WINDOW_AFTER_S,
  clock,
});

const jobLogger = logger.child({ component: "jobs" });
const jobs = [
  new IntervalJob(
    "checkin-confirmer",
    5_000,
    async () => {
      await runCheckinConfirmer({
        db,
        relayer,
        logger: jobLogger,
        contract: config.contractAddress,
        clock,
      });
    },
    jobLogger,
  ),
  new IntervalJob(
    "nonce-cleanup",
    60_000,
    async () => void (await cleanupExpiredNonces(db, clock)),
    jobLogger,
  ),
  new IntervalJob(
    "relayer-balance",
    60_000,
    async () => void (await relayer.refreshBalance()),
    jobLogger,
  ),
];

const app = await buildApp({
  config,
  db,
  logger,
  clock,
  indexer,
  relayer,
  checkin,
  chainHead: () => publicClient.getBlockNumber({ cacheTime: 2_000 }),
});

await indexer.init();
indexer.start();
relayer.start();
for (const job of jobs) job.start();
await app.listen({ port: config.PORT, host: config.HOST });
logger.info(
  {
    url: config.PUBLIC_BASE_URL,
    docs: `${config.PUBLIC_BASE_URL}/docs`,
    contract: config.contractAddress,
    relayer: relayer.address,
  },
  "TicketChain backend started",
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "shutting down");
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await app.close();
    await Promise.all(jobs.map((j) => j.stop()));
    await relayer.stop();
    await indexer.stop();
    await db.$disconnect();
  } catch (err) {
    logger.error({ err: errorMessage(err) }, "error during shutdown");
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
