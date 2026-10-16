import { randomBytes } from "node:crypto";

import { isAddressEqual, recoverMessageAddress, type Address, type Hex } from "viem";
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from "viem/siwe";

import type { PrismaClient } from "../db/client.js";
import { AppError } from "../lib/errors.js";
import type { Clock } from "../lib/time.js";

export interface SiweOptions {
  db: PrismaClient;
  publicBaseUrl: string;
  chainId: number;
  clock: Clock;
  ttlMs?: number;
}

export const SIWE_STATEMENT = "Sign in to TicketChain.";

/** Issues a single-use nonce and the EIP-4361 message the wallet has to sign. */
export async function createSiweChallenge(o: SiweOptions, address: Address) {
  const nonce = randomBytes(16).toString("hex");
  const now = new Date(o.clock());
  const expiresAt = new Date(now.getTime() + (o.ttlMs ?? 5 * 60_000));
  const url = new URL(o.publicBaseUrl);
  await o.db.authNonce.create({ data: { nonce, expiresAt } });
  const message = createSiweMessage({
    address,
    chainId: o.chainId,
    domain: url.host,
    uri: url.origin,
    nonce,
    version: "1",
    statement: SIWE_STATEMENT,
    issuedAt: now,
    expirationTime: expiresAt,
  });
  return { nonce, message, expiresAt };
}

/** Verifies a signed SIWE message, consumes its nonce and returns the signer address. */
export async function verifySiwe(
  o: SiweOptions,
  message: string,
  signature: Hex,
): Promise<Address> {
  const parsed = parseSiweMessage(message);
  const now = new Date(o.clock());
  const url = new URL(o.publicBaseUrl);

  if (!parsed.address || !parsed.nonce) {
    throw new AppError("SIWE_INVALID", "Malformed SIWE message", 401);
  }
  const fieldsOk = validateSiweMessage({
    message: parsed,
    domain: url.host,
    nonce: parsed.nonce,
    time: now,
  });
  if (!fieldsOk || parsed.chainId !== o.chainId) {
    throw new AppError("SIWE_INVALID", "SIWE message domain, chain or time is invalid", 401);
  }

  // Single use: only one concurrent verify can delete the row.
  const consumed = await o.db.authNonce.deleteMany({
    where: { nonce: parsed.nonce, expiresAt: { gt: now } },
  });
  if (consumed.count !== 1) {
    throw new AppError("SIWE_NONCE_INVALID", "Nonce is unknown, expired or already used", 401);
  }

  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message, signature });
  } catch {
    throw new AppError("SIWE_BAD_SIGNATURE", "Signature is invalid", 401);
  }
  if (!isAddressEqual(signer, parsed.address)) {
    throw new AppError("SIWE_BAD_SIGNATURE", "Signature does not match the message address", 401);
  }
  return parsed.address;
}
