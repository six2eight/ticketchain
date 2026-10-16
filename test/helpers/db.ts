import { randomUUID } from "node:crypto";
import { copyFileSync, rmSync } from "node:fs";
import path from "node:path";

import { createPrisma, type PrismaClient } from "../../src/db/client.js";
import { TEMPLATE_DB, TMP_DIR } from "./paths.js";

export interface TestDb {
  db: PrismaClient;
  url: string;
  cleanup(): Promise<void>;
}

/** A fresh, migrated SQLite database file for one test. */
export function createTestDb(): TestDb {
  const file = path.join(TMP_DIR, `${randomUUID()}.db`);
  copyFileSync(TEMPLATE_DB, file);
  const url = `file:${file}`;
  const db = createPrisma(url);
  return {
    db,
    url,
    async cleanup() {
      await db.$disconnect();
      for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
    },
  };
}
