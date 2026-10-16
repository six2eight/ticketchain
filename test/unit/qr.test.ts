import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  buildQr,
  checkinMessage,
  decodeQr,
  encodeQr,
  recoverDeviceKeySigner,
  recoverQrSigner,
} from "../../src/checkin/qr.js";
import { CHAIN_ID, CONTRACT, signDeviceKey } from "../helpers/app.js";

const device = privateKeyToAccount(generatePrivateKey());

describe("qr", () => {
  it("round-trips and recovers the device key", async () => {
    const { text, payload } = await buildQr({
      signer: device,
      chainId: CHAIN_ID,
      contract: CONTRACT,
      tokenId: 42,
      eventId: 7,
      nowMs: 1_700_000_000_000,
    });
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(payload).toMatchObject({ v: 1, t: 42, e: 7, x: 1_700_000_030 });
    expect(payload.n).toMatch(/^[0-9a-f]{32}$/);
    const decoded = decodeQr(text);
    expect(decoded).toEqual(payload);
    expect(await recoverQrSigner(decoded!, CHAIN_ID, CONTRACT)).toBe(device.address);
  });

  it("uses a fresh nonce each time", async () => {
    const a = await buildQr({
      signer: device,
      chainId: CHAIN_ID,
      contract: CONTRACT,
      tokenId: 1,
      eventId: 1,
    });
    const b = await buildQr({
      signer: device,
      chainId: CHAIN_ID,
      contract: CONTRACT,
      tokenId: 1,
      eventId: 1,
    });
    expect(a.payload.n).not.toBe(b.payload.n);
  });

  it("builds the documented message", () => {
    expect(checkinMessage(1, "0xABCDEF", { v: 1, t: 2, e: 3, x: 4, n: "ff" })).toBe(
      "TICKETCHAIN-CHECKIN|1|0xabcdef|2|3|4|ff",
    );
  });

  it("rejects malformed input", () => {
    expect(decodeQr("")).toBeNull();
    expect(decodeQr("not base64 !!")).toBeNull();
    expect(decodeQr(btoa("{}"))).toBeNull();
    expect(decodeQr("x".repeat(2000))).toBeNull();
    const bad = encodeQr({ v: 1, t: 1, e: 1, x: 1, n: "zz", s: "0x00" } as never);
    expect(decodeQr(bad)).toBeNull();
  });

  it("a tampered payload recovers a different signer", async () => {
    const { payload } = await buildQr({
      signer: device,
      chainId: CHAIN_ID,
      contract: CONTRACT,
      tokenId: 1,
      eventId: 1,
    });
    const tampered = { ...payload, t: 2 };
    expect(await recoverQrSigner(tampered, CHAIN_ID, CONTRACT)).not.toBe(device.address);
    expect(await recoverQrSigner(payload, CHAIN_ID + 1, CONTRACT)).not.toBe(device.address);
  });

  it("recovers the owner from the EIP-712 device-key delegation", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const o = { tokenId: 5, device: device.address, expiresAt: 1_800_000_000 };
    const signature = await signDeviceKey(owner, o);
    expect(
      await recoverDeviceKeySigner({ chainId: CHAIN_ID, contract: CONTRACT, ...o, signature }),
    ).toBe(owner.address);
    expect(
      await recoverDeviceKeySigner({
        chainId: CHAIN_ID,
        contract: CONTRACT,
        ...o,
        expiresAt: o.expiresAt + 1,
        signature,
      }),
    ).not.toBe(owner.address);
  });
});
