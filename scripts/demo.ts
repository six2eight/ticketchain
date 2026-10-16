/**
 * Scripted end-to-end demo against the running backend (`npm run dev:all` + `npm run seed`).
 * Every step talks to the real API and the local chain, and prints ✅ / ❌ like a door scanner.
 */
import { styleText } from "node:util";

import { formatEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type HDAccount } from "viem/accounts";

import { buildQr, deviceKeyTypedData } from "../src/checkin/qr.js";
import { sleep } from "../src/lib/time.js";
import { localSetup, ROLES } from "./lib/local.js";

const API = (process.env.API_URL ?? process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(
  /\/+$/,
  "",
);
const s = localSetup();
const CHAIN_ID = s.chain.id;

let step = 0;
const title = (text: string) =>
  console.log(`\n${styleText(["bold", "cyan"], `${++step}. ${text}`)}`);
const info = (text: string) => console.log(`   ${styleText("gray", text)}`);
const ok = (text: string) => console.log(`   ${styleText("green", `✅ ${text}`)}`);
const no = (text: string) => console.log(`   ${styleText("red", `❌ ${text}`)}`);
function fail(text: string): never {
  console.error(styleText(["bold", "red"], `\nDemo failed: ${text}`));
  process.exit(1);
}

async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  o: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
    },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function login(account: HDAccount, label: string) {
  const nonce = await api<{ message: string }>("POST", "/auth/nonce", {
    body: { address: account.address },
  });
  const signature = await account.signMessage({ message: nonce.body.message });
  const verify = await api<{ token: string }>("POST", "/auth/verify", {
    body: { message: nonce.body.message, signature },
  });
  if (verify.status !== 200) fail(`login for ${label} failed: ${JSON.stringify(verify.body)}`);
  ok(`${label} signed in with SIWE (${account.address.slice(0, 10)}…)`);
  return verify.body.token;
}

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined) return v;
    await sleep(500);
  }
  return fail(`timed out waiting for ${what}`);
}

interface Ticket {
  tokenId: number;
  eventId: number;
  status: string;
  owner: string;
  listedPriceWei: string | null;
}

async function registerDeviceKey(
  token: string,
  owner: HDAccount,
  ticket: Ticket,
  eventStart: number,
) {
  const device = privateKeyToAccount(generatePrivateKey());
  const expiresAt = eventStart + 12 * 3600;
  const typed = await api(
    "GET",
    `/tickets/${ticket.tokenId}/device-key-typed-data?device=${device.address}&expiresAt=${expiresAt}`,
    {
      token,
    },
  );
  if (typed.status !== 200) fail(`typed data: ${JSON.stringify(typed.body)}`);
  const signature = await owner.signTypedData(
    deviceKeyTypedData({
      chainId: CHAIN_ID,
      contract: s.address,
      tokenId: ticket.tokenId,
      device: device.address,
      expiresAt,
    }),
  );
  const reg = await api("POST", `/tickets/${ticket.tokenId}/device-keys`, {
    token,
    body: { device: device.address, expiresAt, signature },
  });
  if (reg.status !== 201) fail(`register device key: ${JSON.stringify(reg.body)}`);
  ok(
    `device key ${device.address.slice(0, 10)}… registered for ticket #${ticket.tokenId} (one wallet signature)`,
  );
  return device;
}

const qrFor = (device: ReturnType<typeof privateKeyToAccount>, t: Ticket, nowMs?: number) =>
  buildQr({
    signer: device,
    chainId: CHAIN_ID,
    contract: s.address,
    tokenId: t.tokenId,
    eventId: t.eventId,
    nowMs,
  }).then((q) => q.text);

async function scan(staffToken: string, eventId: number, qr: string) {
  const started = performance.now();
  const res = await api<{ result: string; reason?: string; holder?: string }>("POST", "/checkin", {
    token: staffToken,
    body: { eventId, qr },
  });
  return { ...res.body, ms: Math.round(performance.now() - started) };
}

// ---------------------------------------------------------------------------------------

console.log(styleText(["bold", "magenta"], "TicketChain demo"));
info(`API ${API}  ·  contract ${s.address}  ·  chain ${CHAIN_ID}`);

title("Backend health");
const health = await api<{ status: string; lag: string; relayer: { balanceWei: string } }>(
  "GET",
  "/health",
).catch(() => fail(`backend not reachable at ${API}. Start it with "npm run dev:all".`));
ok(`status=${health.body.status}, indexer lag=${health.body.lag} blocks`);

const buyer1 = s.account(ROLES.buyer1);
const buyer2 = s.account(ROLES.buyer2);
const buyer3 = s.account(ROLES.buyer3);
const staffAcc = s.account(ROLES.staff);

title("Login (Sign-In With Ethereum)");
const buyerToken = await login(buyer1, "buyer");
const staffToken = await login(staffAcc, "staff");

title("List events");
const events = await api<{
  items: { id: number; name: string; startTime: string; ticketsLeft: number; priceWei: string }[];
}>("GET", "/events?upcoming=true&limit=100");
const event = events.body.items.filter((e) => e.name === "Dhaka Tech Fest 2026").at(-1);
if (!event) fail('no "Dhaka Tech Fest 2026" event found — run "npm run seed" first');
const eventStart = Math.floor(new Date(event.startTime).getTime() / 1000);
ok(
  `#${event.id} ${event.name} · ${formatEther(BigInt(event.priceWei))} ETH · ${event.ticketsLeft} left · starts ${event.startTime}`,
);

title("My tickets");
const mine = await api<{ items: Ticket[] }>("GET", `/me/tickets?eventId=${event.id}`, {
  token: buyerToken,
});
for (const t of mine.body.items) info(`ticket #${t.tokenId} · ${t.status}`);
const ticket = mine.body.items.find((t) => t.status === "VALID");
if (!ticket) fail('buyer has no VALID ticket for this event — run "npm run seed" again');
ok(`using ticket #${ticket.tokenId}`);

title("Register a device key");
const device = await registerDeviceKey(buyerToken, buyer1, ticket, eventStart);

title("Scan the rotating QR at the door");
const qr = await qrFor(device, ticket);
info(`QR text: ${qr.slice(0, 48)}…`);
const first = await scan(staffToken, event.id, qr);
if (first.result !== "ACCEPTED") fail(`expected ACCEPTED, got ${JSON.stringify(first)}`);
ok(`ACCEPTED in ${first.ms} ms — holder ${first.holder}`);

title("Screenshot replay of the same QR");
const replay = await scan(staffToken, event.id, qr);
if (replay.reason !== "QR_REPLAYED") fail(`expected QR_REPLAYED, got ${JSON.stringify(replay)}`);
no(`REJECTED ${replay.reason}`);

title("Relayer marks the ticket used on-chain");
await waitFor("ticket USED", async () => {
  const t = await api<Ticket>("GET", `/tickets/${ticket.tokenId}`);
  return t.body.status === "USED" ? true : undefined;
});
const usedOnChain = await s.read<boolean>("used", [BigInt(ticket.tokenId)]);
if (!usedOnChain) fail("used(tokenId) is false on-chain");
ok(`ticket #${ticket.tokenId} is USED in the DB and used(${ticket.tokenId}) == true on-chain`);

title("Rescan with a fresh QR");
const rescan = await scan(staffToken, event.id, await qrFor(device, ticket));
if (rescan.reason !== "ALREADY_USED") fail(`expected ALREADY_USED, got ${JSON.stringify(rescan)}`);
no(`REJECTED ${rescan.reason}`);

title("Expired QR (screenshot taken a minute ago)");
const expired = await scan(staffToken, event.id, await qrFor(device, ticket, Date.now() - 60_000));
if (expired.reason !== "QR_EXPIRED") fail(`expected QR_EXPIRED, got ${JSON.stringify(expired)}`);
no(`REJECTED ${expired.reason}`);

title("Resale: the old owner's device key stops working");
const seller = await login(buyer2, "seller");
const sellerTickets = await api<{ items: Ticket[] }>("GET", `/me/tickets?eventId=${event.id}`, {
  token: seller,
});
const resale = sellerTickets.body.items.find((t) => t.status === "VALID");
if (!resale) fail("seller has no VALID ticket — run the seed again");
const sellerDevice = await registerDeviceKey(seller, buyer2, resale, eventStart);
const cap = BigInt(
  (await api<{ resaleCapWei: string }>("GET", `/events/${event.id}`)).body.resaleCapWei,
);
if (!resale.listedPriceWei) {
  await s.write(ROLES.buyer2, "listForResale", [BigInt(resale.tokenId), cap]);
  info(`listed ticket #${resale.tokenId} at ${formatEther(cap)} ETH`);
}
const listing = await s.read<readonly [Hex, bigint]>("listings", [BigInt(resale.tokenId)]);
await s.write(ROLES.buyer3, "buyResale", [BigInt(resale.tokenId)], listing[1]);
ok(
  `buyer ${buyer3.address.slice(0, 10)}… bought ticket #${resale.tokenId} for ${formatEther(listing[1])} ETH (price cap enforced on-chain)`,
);
await waitFor("resale indexed", async () => {
  const t = await api<Ticket>("GET", `/tickets/${resale.tokenId}`);
  return t.body.owner === buyer3.address.toLowerCase() ? true : undefined;
});
const stale = await scan(staffToken, event.id, await qrFor(sellerDevice, resale));
if (stale.reason !== "OWNER_CHANGED") fail(`expected OWNER_CHANGED, got ${JSON.stringify(stale)}`);
no(`REJECTED ${stale.reason} — the seller's QR is useless after the sale`);

title("Health");
const end = await api<{
  status: string;
  chainHead: string;
  indexedBlock: string;
  lag: string;
  relayer: { address: string; balanceWei: string; low: boolean };
}>("GET", "/health");
ok(
  `status=${end.body.status} · head=${end.body.chainHead} · indexed=${end.body.indexedBlock} · lag=${end.body.lag} · relayer balance=${formatEther(BigInt(end.body.relayer.balanceWei ?? "0"))} ETH`,
);

console.log(styleText(["bold", "green"], "\nDemo complete."));
