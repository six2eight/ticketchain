/**
 * Seeds the local chain: one event ("Dhaka Tech Fest 2026"), a staff member,
 * three buyers with one ticket each, and one resale listing.
 * Requires `npm run chain` + `npm run deploy:local` (or `npm run dev:all`).
 */
import { decodeEventLog, formatEther, parseEther } from "viem";

import { ticketChainAbi } from "../src/chain/abi.js";
import { localSetup, ROLES } from "./lib/local.js";

const s = localSetup();
const price = parseEther("0.01");
const resaleCap = parseEther("0.015");
const latest = await s.publicClient.getBlock();
// Starts in 2 hours: tickets can still be bought and resold, and the check-in window
// (start − 6 h … start + 24 h) is already open, so the demo works right away.
const startTime = latest.timestamp + 2n * 3600n;

console.log(`Seeding TicketChain at ${s.address}`);

const createHash = await s.write(ROLES.organizer, "createEvent", [
  "Dhaka Tech Fest 2026",
  price,
  500,
  startTime,
  resaleCap,
]);
const createReceipt = await s.publicClient.getTransactionReceipt({ hash: createHash });
let eventId = 0n;
for (const log of createReceipt.logs) {
  try {
    const d = decodeEventLog({ abi: ticketChainAbi, data: log.data, topics: log.topics });
    if (d.eventName === "EventCreated") eventId = d.args.eventId;
  } catch {
    // not ours
  }
}
console.log(`  event #${eventId} created by organizer ${s.account(ROLES.organizer).address}`);

await s.write(ROLES.organizer, "addStaff", [eventId, s.account(ROLES.staff).address]);
console.log(`  staff ${s.account(ROLES.staff).address} added`);

const tokens: bigint[] = [];
for (const buyer of [ROLES.buyer1, ROLES.buyer2, ROLES.buyer3]) {
  const before = await s.read<bigint>("nextTokenId");
  await s.write(buyer, "buyTicket", [eventId], price);
  tokens.push(before);
  console.log(
    `  ticket #${before} bought by ${s.account(buyer).address} for ${formatEther(price)} ETH`,
  );
}

const listed = tokens[1]!;
await s.write(ROLES.buyer2, "listForResale", [listed, resaleCap]);
console.log(`  ticket #${listed} listed for resale at ${formatEther(resaleCap)} ETH`);

console.log(
  JSON.stringify({ eventId: Number(eventId), tokens: tokens.map(Number), listed: Number(listed) }),
);
