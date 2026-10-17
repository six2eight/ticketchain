/** Points tokenURI at PUBLIC_BASE_URL/metadata/ on the local deployment (admin = Hardhat #0). */
import { existsSync } from "node:fs";

import { localSetup, ROLES } from "./lib/local.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const base = `${(process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "")}/metadata/`;
const s = localSetup();
await s.write(ROLES.admin, "setBaseURI", [base]);
console.log(`Base URI set to ${base}`);
