/**
 * QR payload + device-key delegation. Shared by the backend, scripts and the web app,
 * so it only uses APIs available in both Node and browsers (no Buffer, no node:crypto).
 */
import { recoverMessageAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { z } from "zod";

export const QR_VERSION = 1;

export const qrPayloadSchema = z.object({
  v: z.literal(QR_VERSION),
  t: z.number().int().positive(), // tokenId
  e: z.number().int().positive(), // eventId
  x: z.number().int().positive(), // expires at (unix seconds)
  n: z.string().regex(/^[0-9a-f]{32}$/), // 16-byte random nonce, hex
  s: z.string().regex(/^0x[0-9a-fA-F]{130}$/), // EIP-191 signature by the device key
});

export type QrPayload = z.infer<typeof qrPayloadSchema>;
export type UnsignedQr = Omit<QrPayload, "s">;

export interface MessageSigner {
  signMessage(args: { message: string }): Promise<Hex>;
}

export function checkinMessage(chainId: number, contract: string, p: UnsignedQr): string {
  return `TICKETCHAIN-CHECKIN|${chainId}|${contract.toLowerCase()}|${p.t}|${p.e}|${p.x}|${p.n}`;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(text: string): string {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeQr(payload: QrPayload): string {
  return base64urlEncode(JSON.stringify(payload));
}

/** Parses QR text; returns null when it is not a valid TicketChain payload. */
export function decodeQr(text: string): QrPayload | null {
  if (text.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const parsed = qrPayloadSchema.safeParse(JSON.parse(base64urlDecode(text)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Builds and signs a QR with the device key (no wallet popup). */
export async function buildQr(o: {
  signer: MessageSigner;
  chainId: number;
  contract: string;
  tokenId: number;
  eventId: number;
  ttlSeconds?: number;
  nowMs?: number;
  nonce?: string;
}): Promise<{ text: string; payload: QrPayload }> {
  const unsigned: UnsignedQr = {
    v: QR_VERSION,
    t: o.tokenId,
    e: o.eventId,
    x: Math.floor((o.nowMs ?? Date.now()) / 1000) + (o.ttlSeconds ?? 30),
    n: o.nonce ?? randomHex(16),
  };
  const s = await o.signer.signMessage({
    message: checkinMessage(o.chainId, o.contract, unsigned),
  });
  const payload = { ...unsigned, s };
  return { text: encodeQr(payload), payload };
}

export function recoverQrSigner(p: QrPayload, chainId: number, contract: string): Promise<Address> {
  const { s, ...unsigned } = p;
  return recoverMessageAddress({
    message: checkinMessage(chainId, contract, unsigned),
    signature: s as Hex,
  });
}

// ---------------------------------------------------------------- device keys (EIP-712)

export const deviceKeyTypes = {
  DeviceKey: [
    { name: "tokenId", type: "uint256" },
    { name: "device", type: "address" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export function deviceKeyTypedData(o: {
  chainId: number;
  contract: Address;
  tokenId: number;
  device: Address;
  expiresAt: number;
}) {
  return {
    domain: {
      name: "TicketChain",
      version: "1",
      chainId: o.chainId,
      verifyingContract: o.contract,
    },
    types: deviceKeyTypes,
    primaryType: "DeviceKey" as const,
    message: { tokenId: BigInt(o.tokenId), device: o.device, expiresAt: BigInt(o.expiresAt) },
  };
}

export function recoverDeviceKeySigner(
  o: Parameters<typeof deviceKeyTypedData>[0] & { signature: Hex },
): Promise<Address> {
  return recoverTypedDataAddress({ ...deviceKeyTypedData(o), signature: o.signature });
}
