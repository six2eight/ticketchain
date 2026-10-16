import { z } from "zod";

import { authAddress, requireOrganizer } from "../../auth/guards.js";
import { notFound } from "../../lib/errors.js";
import { eventDto, page } from "../dto.js";
import { address, bearer, idParam, pagination } from "../schemas.js";
import type { App, AppDeps } from "../types.js";

export function eventRoutes(app: App, { db, clock }: AppDeps) {
  app.get(
    "/events",
    {
      schema: {
        tags: ["events"],
        summary: "List events",
        querystring: z.object({
          upcoming: z
            .enum(["true", "false"])
            .optional()
            .transform((v) => v === "true"),
          organizer: address.optional(),
          ...pagination,
        }),
      },
    },
    async (req) => {
      const { upcoming, organizer, limit, cursor } = req.query;
      const rows = await db.event.findMany({
        where: {
          ...(upcoming ? { startTime: { gt: new Date(clock()) } } : {}),
          ...(organizer ? { organizer } : {}),
          ...(cursor !== undefined ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: limit + 1,
      });
      const p = page(rows, limit, (e) => e.id);
      return { items: p.items.map(eventDto), nextCursor: p.nextCursor };
    },
  );

  app.get(
    "/events/:id",
    { schema: { tags: ["events"], summary: "Event details and tickets left", params: idParam } },
    async (req) => {
      const event = await db.event.findUnique({ where: { id: req.params.id } });
      if (!event) throw notFound("Event");
      return eventDto(event);
    },
  );

  app.patch(
    "/events/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["events"],
        summary: "Set off-chain description and venue (organizer)",
        security: bearer,
        params: idParam,
        body: z
          .object({
            description: z.string().max(5000).nullable().optional(),
            venue: z.string().max(200).nullable().optional(),
          })
          .refine((b) => b.description !== undefined || b.venue !== undefined, {
            message: "description or venue is required",
          }),
      },
    },
    async (req) => {
      await requireOrganizer(db, req.params.id, authAddress(req));
      const updated = await db.event.update({
        where: { id: req.params.id },
        data: { description: req.body.description, venue: req.body.venue },
      });
      return eventDto(updated);
    },
  );

  app.get(
    "/events/:id/stats",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["events"],
        summary: "Sales and check-in stats (organizer)",
        security: bearer,
        params: idParam,
      },
    },
    async (req) => {
      const event = await requireOrganizer(db, req.params.id, authAddress(req));
      const [byStatus, listed, attempts] = await Promise.all([
        db.ticket.groupBy({ by: ["status"], where: { eventId: event.id }, _count: { _all: true } }),
        db.ticket.count({ where: { eventId: event.id, listedPriceWei: { not: null } } }),
        db.checkinAttempt.groupBy({
          by: ["result", "reason"],
          where: { eventId: event.id },
          _count: { _all: true },
        }),
      ]);
      const status = (s: string) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
      const attemptsByReason: Record<string, number> = {};
      let accepted = 0;
      for (const a of attempts) {
        if (a.result === "ACCEPTED") accepted += a._count._all;
        else attemptsByReason[a.reason ?? "UNKNOWN"] = a._count._all;
      }
      return {
        eventId: event.id,
        sold: event.sold,
        maxSupply: event.maxSupply,
        revenueWei: (BigInt(event.priceWei) * BigInt(event.sold)).toString(),
        valid: status("VALID"),
        checkingIn: status("CHECKING_IN"),
        checkedIn: status("USED"),
        admitted: status("USED") + status("CHECKING_IN"),
        listedForResale: listed,
        attempts: { accepted, rejected: attemptsByReason },
      };
    },
  );

  app.get(
    "/events/:id/staff",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["events"],
        summary: "Staff wallets (organizer)",
        security: bearer,
        params: idParam,
      },
    },
    async (req) => {
      await requireOrganizer(db, req.params.id, authAddress(req));
      const staff = await db.staff.findMany({
        where: { eventId: req.params.id },
        orderBy: { wallet: "asc" },
      });
      return { items: staff.map((s) => s.wallet) };
    },
  );
}
