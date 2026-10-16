import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { Config } from "../config.js";
import type { PrismaClient } from "../db/client.js";
import type { IndexerStatus } from "../indexer/indexer.js";
import type { Logger } from "../lib/logger.js";
import type { Clock } from "../lib/time.js";
import type { CheckinService } from "../checkin/checkin.service.js";

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface RelayerStatus {
  address: string;
  balanceWei: bigint | null;
  low: boolean;
}

export interface AppDeps {
  config: Config;
  db: PrismaClient;
  logger: Logger;
  clock: Clock;
  indexer: { status(): IndexerStatus };
  relayer: { status(): RelayerStatus };
  checkin: CheckinService;
  /** Latest chain head for /health (falls back to the indexer's last seen head). */
  chainHead?: () => Promise<bigint>;
}
