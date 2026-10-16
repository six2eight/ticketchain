import type { FastifyRequest } from "fastify";

import type { Db } from "../db/client.js";
import { lower } from "../lib/address.js";
import { AppError, notFound, unauthorized } from "../lib/errors.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

/** The authenticated wallet (lowercase). Use after the `requireAuth` preHandler. */
export function authAddress(req: FastifyRequest): string {
  const sub = (req.user as { sub?: string } | undefined)?.sub;
  if (!sub) throw unauthorized();
  return lower(sub);
}

export async function requireOrganizer(db: Db, eventId: number, address: string) {
  const event = await db.event.findUnique({ where: { id: eventId } });
  if (!event) throw notFound("Event");
  if (event.organizer !== address) {
    throw new AppError("NOT_ORGANIZER", "Only the event organizer can do this", 403);
  }
  return event;
}

export async function isStaffOrOrganizer(db: Db, eventId: number, address: string) {
  const event = await db.event.findUnique({ where: { id: eventId }, select: { organizer: true } });
  if (!event) return false;
  if (event.organizer === address) return true;
  const staff = await db.staff.findUnique({
    where: { eventId_wallet: { eventId, wallet: address } },
  });
  return staff !== null;
}

export async function requireStaff(db: Db, eventId: number, address: string) {
  if (!(await isStaffOrOrganizer(db, eventId, address))) {
    throw new AppError("NOT_STAFF", "Only staff or the organizer of this event can do this", 403);
  }
}

export async function requireTicketOwner(db: Db, tokenId: number, address: string) {
  const ticket = await db.ticket.findUnique({ where: { tokenId } });
  if (!ticket) throw notFound("Ticket");
  if (ticket.owner !== address) {
    throw new AppError("NOT_TICKET_OWNER", "Only the ticket owner can do this", 403);
  }
  return ticket;
}
