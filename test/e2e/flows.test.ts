import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type HDAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ticketChainAbi } from "../../src/chain/abi.js";
import { buildQr, deviceKeyTypedData } from "../../src/checkin/qr.js";
import { createTestDb } from "../helpers/db.js";
import {
  accounts,
  deploy,
  startBackend,
  startNode,
  waitFor,
  write,
  type Backend,
  type Node,
} from "./harness.js";

const PRICE = 10n ** 16n;
const CAP = 15n * 10n ** 15n;

let node: Node;
let contract: Hex;
let backend: Backend;
let eventId: bigint;

async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  o: { token?: string; body?: unknown } = {},
) {
  const res = await fetch(`${backend.baseUrl}${path}`, {
    method,
    headers: {
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
    },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function login(account: HDAccount) {
  const { body } = await api<{ message: string }>("POST", "/auth/nonce", {
    body: { address: account.address },
  });
  const signature = await account.signMessage({ message: body.message });
  const res = await api<{ token: string }>("POST", "/auth/verify", {
    body: { message: body.message, signature },
  });
  expect(res.status).toBe(200);
  return res.body.token;
}

async function buy(buyer: HDAccount): Promise<number> {
  const next = await node.client.readContract({
    address: contract,
    abi: ticketChainAbi,
    functionName: "nextTokenId",
  });
  await write(node, contract, buyer, "buyTicket", [eventId], PRICE);
  return Number(next);
}

const ticket = (id: number) => api<{ status: string; owner: string }>("GET", `/tickets/${id}`);
const used = (id: number) =>
  node.client.readContract({
    address: contract,
    abi: ticketChainAbi,
    functionName: "used",
    args: [BigInt(id)],
  });

async function registerDevice(owner: HDAccount, token: string, tokenId: number) {
  const device = privateKeyToAccount(generatePrivateKey());
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const signature = await owner.signTypedData(
    deviceKeyTypedData({ chainId: 31337, contract, tokenId, device: device.address, expiresAt }),
  );
  const res = await api("POST", `/tickets/${tokenId}/device-keys`, {
    token,
    body: { device: device.address, expiresAt, signature },
  });
  expect(res.status).toBe(201);
  return device;
}

const qr = (device: ReturnType<typeof privateKeyToAccount>, tokenId: number) =>
  buildQr({ signer: device, chainId: 31337, contract, tokenId, eventId: Number(eventId) }).then(
    (q) => q.text,
  );

beforeAll(async () => {
  node = await startNode();
  const d = await deploy(node);
  contract = d.address;
  backend = await startBackend(node, contract, d.deployBlock);

  const block = await node.client.getBlock();
  const receipt = await write(node, contract, accounts.organizer, "createEvent", [
    "E2E Fest",
    PRICE,
    100,
    block.timestamp + 3600n,
    CAP,
  ]);
  expect(receipt.status).toBe("success");
  eventId = 1n;
  await write(node, contract, accounts.organizer, "addStaff", [eventId, accounts.staff.address]);
  await waitFor(async () => (await api("GET", "/events/1")).status === 200);
});

afterAll(async () => {
  await backend?.stop();
  await node?.stop();
});

describe("e2e", () => {
  it("buy → index → check-in → USED in DB and on-chain", async () => {
    const tokenId = await buy(accounts.buyer1);
    await waitFor(async () => (await ticket(tokenId)).status === 200);
    const buyerToken = await login(accounts.buyer1);
    const mine = await api<{ items: { tokenId: number }[] }>("GET", "/me/tickets", {
      token: buyerToken,
    });
    expect(mine.body.items.map((t) => t.tokenId)).toContain(tokenId);

    const device = await registerDevice(accounts.buyer1, buyerToken, tokenId);
    const staffToken = await login(accounts.staff);
    const res = await api<{ result: string; txRequestId: number }>("POST", "/checkin", {
      token: staffToken,
      body: { eventId: Number(eventId), qr: await qr(device, tokenId) },
    });
    expect(res.body).toMatchObject({ result: "ACCEPTED", tokenId });
    expect((await ticket(tokenId)).body.status).toBe("CHECKING_IN");

    await waitFor(async () => (await ticket(tokenId)).body.status === "USED");
    expect(await used(tokenId)).toBe(true);
    const tx = await api<{ status: string; lastHash: string }>(
      "GET",
      `/tx/${res.body.txRequestId}`,
      { token: staffToken },
    );
    expect(tx.body.status).toBe("CONFIRMED");
    const receipt = await node.client.getTransactionReceipt({ hash: tx.body.lastHash as Hex });
    expect(receipt.status).toBe("success");

    const again = await api("POST", "/checkin", {
      token: staffToken,
      body: { eventId: Number(eventId), qr: await qr(device, tokenId) },
    });
    expect(again.body).toMatchObject({ result: "REJECTED", reason: "ALREADY_USED" });

    const svg = await fetch(`${backend.baseUrl}/metadata/${tokenId}/image.svg`).then((r) =>
      r.text(),
    );
    expect(svg).toContain(">USED<");
  });

  it("resale updates the owner and invalidates the old device key", async () => {
    const tokenId = await buy(accounts.buyer2);
    await waitFor(async () => (await ticket(tokenId)).status === 200);
    const sellerToken = await login(accounts.buyer2);
    const oldDevice = await registerDevice(accounts.buyer2, sellerToken, tokenId);

    await write(node, contract, accounts.buyer2, "listForResale", [BigInt(tokenId), CAP]);
    await waitFor(async () => {
      const l = await api<{ items: { tokenId: number }[] }>("GET", "/listings");
      return l.body.items.some((x) => x.tokenId === tokenId);
    });
    await write(node, contract, accounts.buyer3, "buyResale", [BigInt(tokenId)], CAP);
    await waitFor(
      async () => (await ticket(tokenId)).body.owner === accounts.buyer3.address.toLowerCase(),
    );

    const history = await api<{ transfers: { to: string; priceWei: string }[] }>(
      "GET",
      `/tickets/${tokenId}`,
    );
    expect(history.body.transfers.at(-1)).toMatchObject({
      to: accounts.buyer3.address.toLowerCase(),
      priceWei: CAP.toString(),
    });

    const staffToken = await login(accounts.staff);
    const stale = await api("POST", "/checkin", {
      token: staffToken,
      body: { eventId: Number(eventId), qr: await qr(oldDevice, tokenId) },
    });
    expect(stale.body).toMatchObject({ result: "REJECTED", reason: "OWNER_CHANGED" });

    const newOwnerToken = await login(accounts.buyer3);
    const newDevice = await registerDevice(accounts.buyer3, newOwnerToken, tokenId);
    const ok = await api("POST", "/checkin", {
      token: staffToken,
      body: { eventId: Number(eventId), qr: await qr(newDevice, tokenId) },
    });
    expect(ok.body).toMatchObject({
      result: "ACCEPTED",
      holder: accounts.buyer3.address.toLowerCase(),
    });
    await waitFor(async () => used(tokenId));
  });

  it("reorg: the indexer rolls back a purchase that disappeared", async () => {
    const soldBefore = (await api<{ sold: number }>("GET", "/events/1")).body.sold;
    const snapshot = await node.client.request({ method: "evm_snapshot" as never });

    const tokenId = await buy(accounts.buyer1);
    await waitFor(async () => (await ticket(tokenId)).status === 200);
    expect((await api<{ sold: number }>("GET", "/events/1")).body.sold).toBe(soldBefore + 1);

    await node.client.request({ method: "evm_revert" as never, params: [snapshot] as never });
    // The replacement chain: a different transaction at the same height, then one more block.
    await write(node, contract, accounts.organizer, "addStaff", [eventId, accounts.buyer3.address]);
    await node.client.request({ method: "evm_mine" as never });

    await waitFor(async () => (await ticket(tokenId)).status === 404);
    expect((await api<{ sold: number }>("GET", "/events/1")).body.sold).toBe(soldBefore);
    // Rollback and indexing the replacement blocks are separate transactions, so the new
    // branch's StaffUpdated may land a moment after the purchase has disappeared.
    const staffToken = await login(accounts.organizer);
    await waitFor(async () => {
      const staff = await api<{ items: string[] }>("GET", "/events/1/staff", { token: staffToken });
      return staff.body.items.includes(accounts.buyer3.address.toLowerCase());
    });

    // The chain moves on normally after the reorg.
    const next = await buy(accounts.buyer1);
    expect(next).toBe(tokenId);
    await waitFor(async () => (await ticket(next)).status === 200);
  });

  it("a restarted backend resumes indexing where it stopped", async () => {
    const db = backend.t;
    await backend.stop({ keepDb: true });
    const tokenId = await buy(accounts.buyer2); // bought while the backend is down
    backend = await startBackend(node, contract, 1n, db);
    await waitFor(async () => (await ticket(tokenId)).status === 200);
    const health = await api<{ lag: string; db: string }>("GET", "/health");
    expect(health.body.db).toBe("ok");
    await waitFor(async () => (await api<{ lag: string }>("GET", "/health")).body.lag === "0");
  });

  it("a fresh database re-indexes the whole history", async () => {
    const other = await startBackend(node, contract, 1n, createTestDb());
    try {
      const ev = await waitFor(async () => {
        const r = await fetch(`${other.baseUrl}/events/1`);
        return r.status === 200 ? ((await r.json()) as { sold: number }) : undefined;
      });
      const live = (await api<{ sold: number }>("GET", "/events/1")).body.sold;
      await waitFor(async () => {
        const r = (await (await fetch(`${other.baseUrl}/events/1`)).json()) as { sold: number };
        return r.sold === live;
      });
      expect(ev).toBeDefined();
    } finally {
      await other.stop();
    }
  });
});
