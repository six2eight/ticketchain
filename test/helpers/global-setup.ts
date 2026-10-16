import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { TEMPLATE_DB, TMP_DIR } from "./paths.js";

/** Builds a migrated template SQLite DB once; each test copies it. */
export default function setup() {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  const prismaBin = path.resolve("node_modules", "prisma", "build", "index.js");
  execFileSync(process.execPath, [prismaBin, "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: `file:${TEMPLATE_DB}` },
    stdio: "pipe",
  });
  return () => rmSync(TMP_DIR, { recursive: true, force: true });
}
