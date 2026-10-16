import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import { Prisma, PrismaClient } from "./generated/client.js";

export { Prisma, PrismaClient };

/** A Prisma client or an interactive-transaction client. */
export type Db = PrismaClient | Prisma.TransactionClient;

export function createPrisma(databaseUrl: string): PrismaClient {
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  return new PrismaClient({ adapter });
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** Tables mirrored from the chain (or tied to a specific contract deployment). */
export async function wipeChainData(tx: Prisma.TransactionClient): Promise<void> {
  await tx.checkinAttempt.deleteMany();
  await tx.txRequest.deleteMany();
  await tx.usedQrNonce.deleteMany();
  await tx.deviceKey.deleteMany();
  await tx.transfer.deleteMany();
  await tx.ticket.deleteMany();
  await tx.staff.deleteMany();
  await tx.event.deleteMany();
  await tx.chainEvent.deleteMany();
  await tx.blockCheckpoint.deleteMany();
}
