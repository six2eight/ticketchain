import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bearer,
  CHAIN_ID,
  createTestApp,
  login,
  newAccount,
  qrFor,
  seedDeviceKey,
  seedEvent,
  seedStaff,
  seedTicket,
  signDeviceKey,
  type TestApp,
} from "../helpers/app.js";

let h: TestApp;
const organizer = newAccount();
const staff = newAccount();
const buyer = newAccount();
const buyer2 = newAccount();
const stranger = newAccount();

async function seedBasic() {
  await seedEvent(h.db, {
    id: 1,
    organizer: organizer.address,
    startTime: new Date(h.clock() + 2 * 3600_000),
    sold: 2,
  });
  await seedStaff(h.db, 1, staff.address);
  await seedTicket(h.db, { tokenId: 1, owner: buyer.address });
  await seedTicket(h.db, {
    tokenId: 2,
    owner: buyer2.address,
    listedPriceWei: "15000000000000000",
  });
}

beforeEach(async () => {
  h = await createTestApp();
});
afterEach(() => h.cleanup());

const get = (url: string, token?: string) =>
  h.app.inject({ method: "GET", url, headers: token ? bearer(token) : {} });
const send = (
  method: "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
  token?: string,
) => h.app.inject({ method, url, payload: payload as object, headers: token ? bearer(token) : {} });

describe("system", () => {
  it("GET /health reports db, indexer lag and relayer", async () => {
    const res = await get("/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "ok",
      db: "ok",
      chainHead: "12",
      indexedBlock: "10",
      lag: "2",
      relayer: { address: h.sender.address, balanceWei: null, low: false },
    });
    h.sender.balance = 1n;
    await h.relayer.refreshBalance();
    expect((await get("/health")).json()).toMatchObject({
      status: "degraded",
      relayer: { low: true, balanceWei: "1" },
    });
  });

  it("GET /config exposes chain and contract for clients", async () => {
    expect((await get("/config")).json()).toEqual({
      chainId: CHAIN_ID,
      contractAddress: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
      qrTtlSeconds: 30,
      publicBaseUrl: "http://localhost:3000",
    });
  });

  it("serves Swagger UI and the OpenAPI document", async () => {
    const ui = await get("/docs/");
    expect(ui.statusCode).toBe(200);
    expect(ui.headers["content-type"]).toContain("text/html");
    const spec = (await get("/docs/json")).json<{
      paths: Record<string, unknown>;
      components: unknown;
    }>();
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        "/auth/nonce",
        "/auth/verify",
        "/events",
        "/events/{id}",
        "/events/{id}/stats",
        "/events/{id}/staff",
        "/me/tickets",
        "/tickets/{tokenId}",
        "/tickets/{tokenId}/device-key-typed-data",
        "/tickets/{tokenId}/device-keys",
        "/tickets/{tokenId}/device-keys/{id}",
        "/listings",
        "/checkin",
        "/checkin/attempts",
        "/tx/{id}",
        "/metadata/{tokenId}",
        "/metadata/{tokenId}/image.svg",
        "/health",
      ]),
    );
    expect(JSON.stringify(spec.components)).toContain("bearerAuth");
  });

  it("returns JSON errors for unknown routes and validation failures", async () => {
    const nf = await get("/nope");
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    const bad = await get("/events/abc");
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("echoes or generates x-request-id", async () => {
    expect(
      (await h.app.inject({ url: "/health", headers: { "x-request-id": "abc-123" } })).headers[
        "x-request-id"
      ],
    ).toBe("abc-123");
    expect((await get("/health")).headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("allows CORS", async () => {
    const res = await h.app.inject({
      method: "OPTIONS",
      url: "/events",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });
});

describe("auth (SIWE)", () => {
  it("full login returns a JWT that works on protected routes", async () => {
    const token = await login(h.app, buyer);
    expect(token.split(".")).toHaveLength(3);
    const me = await get("/me/tickets", token);
    expect(me.statusCode).toBe(200);
  });

  it("nonce message is EIP-4361 for the configured domain and chain", async () => {
    const res = await send("POST", "/auth/nonce", { address: buyer.address });
    const { message, nonce } = res.json<{ message: string; nonce: string }>();
    expect(message).toContain("localhost:3000 wants you to sign in with your Ethereum account:");
    expect(message).toContain(buyer.address);
    expect(message).toContain(`Chain ID: ${CHAIN_ID}`);
    expect(message).toContain(`Nonce: ${nonce}`);
    expect(message).toContain("Expiration Time:");
  });

  it("rejects a bad signature, a reused nonce, an expired nonce and a foreign domain", async () => {
    const { message } = (await send("POST", "/auth/nonce", { address: buyer.address })).json<{
      message: string;
    }>();
    const wrong = await send("POST", "/auth/verify", {
      message,
      signature: await stranger.signMessage({ message }),
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: { code: "SIWE_BAD_SIGNATURE" } });

    // The failed attempt consumed the nonce: single use.
    const reuse = await send("POST", "/auth/verify", {
      message,
      signature: await buyer.signMessage({ message }),
    });
    expect(reuse.json()).toMatchObject({ error: { code: "SIWE_NONCE_INVALID" } });

    const fresh = (await send("POST", "/auth/nonce", { address: buyer.address })).json<{
      message: string;
    }>();
    h.clock.advance(6 * 60_000);
    const expired = await send("POST", "/auth/verify", {
      message: fresh.message,
      signature: await buyer.signMessage({ message: fresh.message }),
    });
    expect(expired.statusCode).toBe(401);

    const foreign = createSiweMessage({
      address: buyer.address,
      chainId: CHAIN_ID,
      domain: "evil.example",
      uri: "https://evil.example",
      nonce: "abcdefgh12345678",
      version: "1",
    });
    const f = await send("POST", "/auth/verify", {
      message: foreign,
      signature: await buyer.signMessage({ message: foreign }),
    });
    expect(f.json()).toMatchObject({ error: { code: "SIWE_INVALID" } });
  });

  it("protected routes require a valid JWT", async () => {
    expect((await get("/me/tickets")).statusCode).toBe(401);
    const bad = await get("/me/tickets", "not.a.jwt");
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("validates the address", async () => {
    const res = await send("POST", "/auth/nonce", { address: "0x123" });
    expect(res.statusCode).toBe(400);
  });

  it("rate-limits /auth", async () => {
    await h.cleanup();
    h = await createTestApp({ RATE_LIMIT_AUTH_PER_MIN: "3" });
    const codes = [];
    for (let i = 0; i < 4; i++)
      codes.push((await send("POST", "/auth/nonce", { address: buyer.address })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    const limited = await send("POST", "/auth/nonce", { address: buyer.address });
    expect(limited.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });
});

describe("events", () => {
  beforeEach(seedBasic);

  it("GET /events lists, filters and paginates", async () => {
    await seedEvent(h.db, {
      id: 2,
      organizer: stranger.address,
      startTime: new Date(h.clock() - 3600_000),
    });
    await seedEvent(h.db, { id: 3, organizer: organizer.address });

    const all = (await get("/events")).json<{ items: { id: number }[] }>();
    expect(all.items.map((e) => e.id)).toEqual([1, 2, 3]);

    const upcoming = (await get("/events?upcoming=true")).json<{ items: { id: number }[] }>();
    expect(upcoming.items.map((e) => e.id)).toEqual([1, 3]);

    const mine = (await get(`/events?organizer=${organizer.address}`)).json<{
      items: { id: number }[];
    }>();
    expect(mine.items.map((e) => e.id)).toEqual([1, 3]);

    const p1 = (await get("/events?limit=2")).json<{
      items: { id: number }[];
      nextCursor: number;
    }>();
    expect(p1.items.map((e) => e.id)).toEqual([1, 2]);
    expect(p1.nextCursor).toBe(2);
    const p2 = (await get(`/events?limit=2&cursor=${p1.nextCursor}`)).json<{
      items: { id: number }[];
      nextCursor: null;
    }>();
    expect(p2.items.map((e) => e.id)).toEqual([3]);
    expect(p2.nextCursor).toBeNull();
  });

  it("GET /events/:id returns details with tickets left; 404 when missing", async () => {
    const res = await get("/events/1");
    expect(res.json()).toMatchObject({
      id: 1,
      organizer: organizer.address.toLowerCase(),
      priceWei: "10000000000000000",
      maxSupply: 100,
      sold: 2,
      ticketsLeft: 98,
      resaleEnabled: true,
    });
    expect((await get("/events/99")).statusCode).toBe(404);
  });

  it("PATCH /events/:id sets off-chain fields for the organizer only", async () => {
    const orgToken = await login(h.app, organizer);
    const ok = await send(
      "PATCH",
      "/events/1",
      { description: "Biggest tech fest", venue: "ICCB, Dhaka" },
      orgToken,
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ description: "Biggest tech fest", venue: "ICCB, Dhaka" });

    const other = await send("PATCH", "/events/1", { venue: "x" }, await login(h.app, stranger));
    expect(other.statusCode).toBe(403);
    expect(other.json()).toMatchObject({ error: { code: "NOT_ORGANIZER" } });
    expect((await send("PATCH", "/events/1", {}, orgToken)).statusCode).toBe(400);
    expect((await send("PATCH", "/events/1", { venue: "x" })).statusCode).toBe(401);
  });

  it("GET /events/:id/stats and /staff for the organizer", async () => {
    const orgToken = await login(h.app, organizer);
    await h.db.ticket.update({ where: { tokenId: 1 }, data: { status: "USED" } });
    await h.db.checkinAttempt.createMany({
      data: [
        { eventId: 1, tokenId: 1, staff: staff.address, result: "ACCEPTED" },
        {
          eventId: 1,
          tokenId: 1,
          staff: staff.address,
          result: "REJECTED",
          reason: "ALREADY_USED",
        },
        {
          eventId: 1,
          tokenId: 1,
          staff: staff.address,
          result: "REJECTED",
          reason: "ALREADY_USED",
        },
        { eventId: 1, staff: staff.address, result: "REJECTED", reason: "QR_EXPIRED" },
      ],
    });
    const stats = (await get("/events/1/stats", orgToken)).json();
    expect(stats).toMatchObject({
      sold: 2,
      revenueWei: "20000000000000000",
      checkedIn: 1,
      valid: 1,
      listedForResale: 1,
      attempts: { accepted: 1, rejected: { ALREADY_USED: 2, QR_EXPIRED: 1 } },
    });
    const staffList = (await get("/events/1/staff", orgToken)).json();
    expect(staffList).toEqual({ items: [staff.address.toLowerCase()] });

    const st = await login(h.app, stranger);
    expect((await get("/events/1/stats", st)).statusCode).toBe(403);
    expect((await get("/events/1/staff", st)).statusCode).toBe(403);
    expect((await get("/events/9/stats", orgToken)).statusCode).toBe(404);
  });
});

describe("tickets", () => {
  beforeEach(seedBasic);

  it("GET /me/tickets returns my tickets only", async () => {
    const res = (await get("/me/tickets", await login(h.app, buyer))).json<{ items: object[] }>();
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      tokenId: 1,
      eventId: 1,
      status: "VALID",
      event: { name: "Event 1" },
      imageUrl: "http://localhost:3000/metadata/1/image.svg",
    });
    expect((await get("/me/tickets", await login(h.app, stranger))).json()).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("GET /tickets/:tokenId includes the transfer history", async () => {
    const res = await get("/tickets/1");
    expect(res.json()).toMatchObject({
      tokenId: 1,
      owner: buyer.address.toLowerCase(),
      transfers: [
        { from: "0x0000000000000000000000000000000000000000", to: buyer.address.toLowerCase() },
      ],
    });
    expect((await get("/tickets/99")).statusCode).toBe(404);
  });

  it("GET /listings shows resale listings", async () => {
    expect((await get("/listings")).json()).toEqual({
      items: [
        {
          tokenId: 2,
          eventId: 1,
          seller: buyer2.address.toLowerCase(),
          priceWei: "15000000000000000",
        },
      ],
      nextCursor: null,
    });
    expect((await get("/listings?eventId=5")).json()).toEqual({ items: [], nextCursor: null });
  });

  it("device keys: typed data → sign → register → list → revoke", async () => {
    const token = await login(h.app, buyer);
    const device = newAccount();
    const expiresAt = Math.floor(h.clock() / 1000) + 3600;

    const td = await get(
      `/tickets/1/device-key-typed-data?device=${device.address}&expiresAt=${expiresAt}`,
      token,
    );
    expect(td.statusCode).toBe(200);
    expect(td.json()).toMatchObject({
      domain: { name: "TicketChain", version: "1", chainId: CHAIN_ID },
      primaryType: "DeviceKey",
      message: { tokenId: "1", device: device.address.toLowerCase(), expiresAt: String(expiresAt) },
    });

    const signature = await signDeviceKey(buyer, { tokenId: 1, device: device.address, expiresAt });
    const reg = await send(
      "POST",
      "/tickets/1/device-keys",
      { device: device.address, expiresAt, signature },
      token,
    );
    expect(reg.statusCode).toBe(201);
    const { id } = reg.json<{ id: number }>();

    const list = (await get("/tickets/1/device-keys", token)).json();
    expect(list).toMatchObject({
      items: [{ id, device: device.address.toLowerCase(), revoked: false }],
    });

    expect(
      (await send("DELETE", `/tickets/1/device-keys/${id}`, undefined, token)).statusCode,
    ).toBe(204);
    expect((await get("/tickets/1/device-keys", token)).json()).toMatchObject({
      items: [{ id, revoked: true }],
    });
    expect((await send("DELETE", `/tickets/1/device-keys/999`, undefined, token)).statusCode).toBe(
      404,
    );
  });

  it("device keys: rejects non-owners, foreign signatures and bad expiry", async () => {
    const token = await login(h.app, buyer);
    const device = newAccount();
    const expiresAt = Math.floor(h.clock() / 1000) + 3600;

    const notMine = await send(
      "POST",
      "/tickets/2/device-keys",
      {
        device: device.address,
        expiresAt,
        signature: await signDeviceKey(buyer, { tokenId: 2, device: device.address, expiresAt }),
      },
      token,
    );
    expect(notMine.statusCode).toBe(403);
    expect(notMine.json()).toMatchObject({ error: { code: "NOT_TICKET_OWNER" } });

    const foreign = await send(
      "POST",
      "/tickets/1/device-keys",
      {
        device: device.address,
        expiresAt,
        signature: await signDeviceKey(stranger, { tokenId: 1, device: device.address, expiresAt }),
      },
      token,
    );
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json()).toMatchObject({ error: { code: "INVALID_SIGNATURE" } });

    const tooLate = Math.floor(h.clock() / 1000) + 2 * 3600 + 25 * 3600;
    const late = await send(
      "POST",
      "/tickets/1/device-keys",
      {
        device: device.address,
        expiresAt: tooLate,
        signature: await signDeviceKey(buyer, {
          tokenId: 1,
          device: device.address,
          expiresAt: tooLate,
        }),
      },
      token,
    );
    expect(late.json()).toMatchObject({ error: { code: "INVALID_EXPIRY" } });
    const past = await get(
      `/tickets/1/device-key-typed-data?device=${device.address}&expiresAt=1`,
      token,
    );
    expect(past.statusCode).toBe(400);
  });

  it("qr-preview returns the payload template for the owner", async () => {
    const res = await get("/tickets/1/qr-preview", await login(h.app, buyer));
    expect(res.json()).toMatchObject({ payload: { v: 1, t: 1, e: 1 } });
    expect(res.json<{ message: string }>().message).toMatch(/^TICKETCHAIN-CHECKIN\|31337\|0x5fbdb/);
    expect((await get("/tickets/1/qr-preview", await login(h.app, stranger))).statusCode).toBe(403);
  });
});

describe("check-in", () => {
  beforeEach(seedBasic);

  it("POST /checkin: staff scan is ACCEPTED, then ALREADY_USED; tx visible at /tx/:id", async () => {
    const { device } = await seedDeviceKey(h.db, { tokenId: 1, owner: buyer.address });
    const staffToken = await login(h.app, staff);

    const ok = await send(
      "POST",
      "/checkin",
      { eventId: 1, qr: await qrFor(device, { tokenId: 1, nowMs: h.clock() }) },
      staffToken,
    );
    expect(ok.statusCode).toBe(200);
    const body = ok.json<{ result: string; txRequestId: number }>();
    expect(body).toMatchObject({
      result: "ACCEPTED",
      tokenId: 1,
      eventId: 1,
      holder: buyer.address.toLowerCase(),
    });

    const again = await send(
      "POST",
      "/checkin",
      { eventId: 1, qr: await qrFor(device, { tokenId: 1, nowMs: h.clock() }) },
      staffToken,
    );
    expect(again.json()).toMatchObject({ result: "REJECTED", reason: "ALREADY_USED" });

    await h.relayer.processOnce();
    const tx = await get(`/tx/${body.txRequestId}`, staffToken);
    expect(tx.json()).toMatchObject({ kind: "CHECKIN", tokenId: 1, status: "CONFIRMED", nonce: 0 });
    expect(tx.json<{ attempts: unknown[] }>().attempts).toHaveLength(1);
    expect((await get(`/tx/${body.txRequestId}`, await login(h.app, organizer))).statusCode).toBe(
      200,
    );
    expect((await get(`/tx/${body.txRequestId}`, await login(h.app, stranger))).statusCode).toBe(
      403,
    );
    expect((await get(`/tx/999`, staffToken)).statusCode).toBe(404);
  });

  it("POST /checkin: 403 NOT_STAFF, 401 without auth, 400 on a bad body", async () => {
    const { device } = await seedDeviceKey(h.db, { tokenId: 1, owner: buyer.address });
    const qr = await qrFor(device, { tokenId: 1, nowMs: h.clock() });
    const res = await send("POST", "/checkin", { eventId: 1, qr }, await login(h.app, stranger));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "NOT_STAFF" } });
    expect((await send("POST", "/checkin", { eventId: 1, qr })).statusCode).toBe(401);
    expect(
      (await send("POST", "/checkin", { eventId: "x" }, await login(h.app, staff))).statusCode,
    ).toBe(400);
  });

  it("POST /checkin: rejections come back as 200 REJECTED with the reason", async () => {
    const token = await login(h.app, staff);
    const res = await send("POST", "/checkin", { eventId: 1, qr: "garbage" }, token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: "REJECTED", reason: "QR_MALFORMED" });
  });

  it("GET /checkin/attempts lists the scan log for the organizer", async () => {
    const staffToken = await login(h.app, staff);
    await send("POST", "/checkin", { eventId: 1, qr: "garbage" }, staffToken);
    await send("POST", "/checkin", { eventId: 1, qr: "garbage2" }, staffToken);
    const orgToken = await login(h.app, organizer);
    const res = (await get("/checkin/attempts?eventId=1&limit=1", orgToken)).json<{
      items: { reason: string }[];
      nextCursor: number;
    }>();
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ result: "REJECTED", reason: "QR_MALFORMED" });
    const next = (
      await get(`/checkin/attempts?eventId=1&limit=1&cursor=${res.nextCursor}`, orgToken)
    ).json<{
      items: unknown[];
      nextCursor: null;
    }>();
    expect(next.items).toHaveLength(1);
    expect(next.nextCursor).toBeNull();
    expect((await get("/checkin/attempts?eventId=1", staffToken)).statusCode).toBe(403);
  });

  it("rate-limits /checkin", async () => {
    await h.cleanup();
    h = await createTestApp({ RATE_LIMIT_CHECKIN_PER_MIN: "2" });
    await seedBasic();
    const token = await login(h.app, staff);
    const codes = [];
    for (let i = 0; i < 3; i++)
      codes.push((await send("POST", "/checkin", { eventId: 1, qr: "x" }, token)).statusCode);
    expect(codes).toEqual([200, 200, 429]);
  });
});

describe("metadata", () => {
  beforeEach(seedBasic);

  it("GET /metadata/:tokenId returns ERC-721 metadata", async () => {
    const res = await get("/metadata/1");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: "Event 1 — Ticket #1",
      image: "http://localhost:3000/metadata/1/image.svg",
      attributes: expect.arrayContaining([{ trait_type: "Status", value: "VALID" }]),
    });
    expect((await get("/metadata/99")).statusCode).toBe(404);
  });

  it("GET /metadata/:tokenId/image.svg shows VALID / USED", async () => {
    const valid = await get("/metadata/1/image.svg");
    expect(valid.headers["content-type"]).toContain("image/svg+xml");
    expect(valid.body).toContain("<svg");
    expect(valid.body).toContain(">VALID<");
    expect(valid.body).not.toContain(">USED<");

    await h.db.ticket.update({ where: { tokenId: 1 }, data: { status: "USED" } });
    const used = await get("/metadata/1/image.svg");
    expect(used.body).toContain(">USED<");
  });

  it("escapes event names in the SVG", async () => {
    await h.db.event.update({ where: { id: 1 }, data: { name: `<script>"x"&` } });
    const svg = (await get("/metadata/1/image.svg")).body;
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });
});
