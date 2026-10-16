import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { buildApp } from "../../src/api/server.js";
import type { App } from "../../src/api/types.js";
import { CheckinService } from "../../src/checkin/checkin.service.js";
import { buildQr, deviceKeyTypedData } from "../../src/checkin/qr.js";
import { loadConfig, type Config } from "../../src/config.js";
import type { PrismaClient } from "../../src/db/client.js";
import { silentLogger } from "../../src/lib/logger.js";
import { Relayer } from "../../src/relayer/relayer.js";
import { createTestDb } from "./db.js";
import { FakeTxSender } from "./fake-sender.js";

export const CONTRACT = "0x5fbdb2315678afecb367f032d93f642f64180aa3" as const;
export const CHAIN_ID = 31337;

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig(
    {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      PUBLIC_BASE_URL: "http://localhost:3000",
      CHAIN_ID: String(CHAIN_ID),
      CONTRACT_ADDRESS: CONTRACT,
      START_BLOCK: "1",
      RELAYER_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      JWT_SECRET: "test-secret-that-is-long-enough",
      ...overrides,
    },
    { loadDotEnv: false },
  );
}

/** A controllable clock. */
export function testClock(start = Date.now()) {
  let now = start;
  const clock = () => now;
  return Object.assign(clock, {
    advance: (ms: number) => void (now += ms),
    set: (ms: number) => void (now = ms),
  });
}

export async function createTestApp(overrides: Record<string, string> = {}) {
  const t = createTestDb();
  const config = testConfig(overrides);
  const clock = testClock();
  const logger = silentLogger();
  const sender = new FakeTxSender();
  const relayer = new Relayer({
    db: t.db,
    sender,
    logger,
    pollMs: 50,
    stuckMs: 30_000,
    maxFeePerGasWei: 200_000_000_000n,
    lowBalanceWei: config.LOW_BALANCE_WEI,
    clock,
  });
  const checkin = new CheckinService({
    db: t.db,
    relayer,
    logger,
    chainId: config.CHAIN_ID,
    contract: config.contractAddress,
    ttlSeconds: config.QR_TTL_SECONDS,
    windowBeforeS: config.CHECKIN_WINDOW_BEFORE_S,
    windowAfterS: config.CHECKIN_WINDOW_AFTER_S,
    clock,
  });
  const indexerStatus = {
    lastIndexedBlock: 10n,
    chainHead: 12n as bigint | null,
    lag: 2n,
    batchSize: 2000,
  };
  const app = await buildApp({
    config,
    db: t.db,
    logger,
    clock,
    indexer: { status: () => indexerStatus },
    relayer,
    checkin,
  });
  return {
    app,
    db: t.db,
    config,
    clock,
    sender,
    relayer,
    checkin,
    indexerStatus,
    async cleanup() {
      await app.close();
      await t.cleanup();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

export const newAccount = () => privateKeyToAccount(generatePrivateKey());

/** Full SIWE login through the API; returns the JWT. */
export async function login(app: App, account: PrivateKeyAccount): Promise<string> {
  const nonce = await app.inject({
    method: "POST",
    url: "/auth/nonce",
    payload: { address: account.address },
  });
  if (nonce.statusCode !== 200) throw new Error(`nonce failed: ${nonce.body}`);
  const { message } = nonce.json<{ message: string }>();
  const signature = await account.signMessage({ message });
  const verify = await app.inject({
    method: "POST",
    url: "/auth/verify",
    payload: { message, signature },
  });
  if (verify.statusCode !== 200) throw new Error(`verify failed: ${verify.body}`);
  return verify.json<{ token: string }>().token;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// --------------------------------------------------------------------------- DB seeding

export async function seedEvent(
  db: PrismaClient,
  o: {
    id?: number;
    organizer: string;
    startTime?: Date;
    maxSupply?: number;
    sold?: number;
    price?: string;
  },
) {
  return db.event.create({
    data: {
      id: o.id ?? 1,
      organizer: o.organizer.toLowerCase(),
      name: `Event ${o.id ?? 1}`,
      priceWei: o.price ?? "10000000000000000",
      resaleCapWei: "15000000000000000",
      maxSupply: o.maxSupply ?? 100,
      sold: o.sold ?? 0,
      startTime: o.startTime ?? new Date(Date.now() + 2 * 3600_000),
      createdBlock: 1n,
    },
  });
}

export async function seedTicket(
  db: PrismaClient,
  o: {
    tokenId: number;
    eventId?: number;
    owner: string;
    status?: string;
    listedPriceWei?: string | null;
  },
) {
  const ticket = await db.ticket.create({
    data: {
      tokenId: o.tokenId,
      eventId: o.eventId ?? 1,
      owner: o.owner.toLowerCase(),
      status: o.status ?? "VALID",
      listedPriceWei: o.listedPriceWei ?? null,
      mintedBlock: 2n,
    },
  });
  await db.transfer.create({
    data: {
      tokenId: o.tokenId,
      from: "0x0000000000000000000000000000000000000000",
      to: o.owner.toLowerCase(),
      priceWei: "10000000000000000",
      txHash: `0x${o.tokenId.toString(16).padStart(64, "0")}`,
      logIndex: 0,
      block: 2n,
    },
  });
  return ticket;
}

export async function seedStaff(db: PrismaClient, eventId: number, wallet: string) {
  return db.staff.create({ data: { eventId, wallet: wallet.toLowerCase() } });
}

/** Registers a device key directly in the DB (the API flow is tested separately). */
export async function seedDeviceKey(
  db: PrismaClient,
  o: { tokenId: number; owner: string; device?: PrivateKeyAccount; expiresAt?: Date },
) {
  const device = o.device ?? newAccount();
  const row = await db.deviceKey.create({
    data: {
      tokenId: o.tokenId,
      deviceAddr: device.address.toLowerCase(),
      ownerAtReg: o.owner.toLowerCase(),
      expiresAt: o.expiresAt ?? new Date(Date.now() + 24 * 3600_000),
    },
  });
  return { device, row };
}

export function qrFor(
  device: PrivateKeyAccount,
  o: {
    tokenId: number;
    eventId?: number;
    nowMs?: number;
    nonce?: string;
    ttlSeconds?: number;
    contract?: string;
  },
) {
  return buildQr({
    signer: device,
    chainId: CHAIN_ID,
    contract: o.contract ?? CONTRACT,
    tokenId: o.tokenId,
    eventId: o.eventId ?? 1,
    nowMs: o.nowMs,
    nonce: o.nonce,
    ttlSeconds: o.ttlSeconds,
  }).then((q) => q.text);
}

export async function signDeviceKey(
  owner: PrivateKeyAccount,
  o: { tokenId: number; device: `0x${string}`; expiresAt: number },
) {
  return owner.signTypedData(
    deviceKeyTypedData({
      chainId: CHAIN_ID,
      contract: CONTRACT,
      tokenId: o.tokenId,
      device: o.device,
      expiresAt: o.expiresAt,
    }),
  );
}
