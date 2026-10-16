import path from "node:path";

export const TMP_DIR = path.resolve(import.meta.dirname, "..", ".tmp");
export const TEMPLATE_DB = path.join(TMP_DIR, "template.db");
