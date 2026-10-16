import { z } from "zod";

import { authAddress, isStaffOrOrganizer, requireOrganizer } from "../../auth/guards.js";
import { AppError, notFound } from "../../lib/errors.js";
import { parseAttempts } from "../../relayer/relayer.js";
import { bearer, idParam, pagination } from "../schemas.js";
import type { App, AppDeps } from "../types.js";

export function checkinRoutes(app: App, { db, config, checkin }: AppDeps) {
  app.post(
    "/checkin",
    {
      preHandler: app.requireAuth,
      config: { rateLimit: { max: config.RATE_LIMIT_CHECKIN_PER_MIN, timeWindow: "1 minute" } },
      schema: {
        tags: ["checkin"],
        summary: "Verify a scanned QR code (staff)",
        description:
          "Returns `ACCEPTED` or `REJECTED` with a reason: QR_MALFORMED, QR_EXPIRED, WRONG_EVENT, TICKET_NOT_FOUND, INVALID_SIGNATURE, OWNER_CHANGED, QR_REPLAYED, OUTSIDE_CHECKIN_WINDOW, ALREADY_USED. A scanner that is not staff gets 403 NOT_STAFF.",
        security: bearer,
        body: z.object({ eventId: z.number().int().positive(), qr: z.string().min(1).max(2048) }),
      },
    },
    async (req) => {
      const result = await checkin.scan({
        eventId: req.body.eventId,
        qr: req.body.qr,
        staff: authAddress(req),
      });
      if (result.result === "REJECTED" && result.reason === "NOT_STAFF") {
        throw new AppError(
          "NOT_STAFF",
          "Only staff or the organizer of this event can scan tickets",
          403,
        );
      }
      return result;
    },
  );

  app.get(
    "/checkin/attempts",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["checkin"],
        summary: "Scan log, newest first (organizer)",
        security: bearer,
        querystring: z.object({ eventId: z.coerce.number().int().positive(), ...pagination }),
      },
    },
    async (req) => {
      const { eventId, limit, cursor } = req.query;
      await requireOrganizer(db, eventId, authAddress(req));
      const rows = await db.checkinAttempt.findMany({
        where: { eventId, ...(cursor !== undefined ? { id: { lt: cursor } } : {}) },
        orderBy: { id: "desc" },
        take: limit + 1,
      });
      const items = rows.slice(0, limit);
      return {
        items: items.map((a) => ({
          id: a.id,
          tokenId: a.tokenId,
          staff: a.staff,
          result: a.result,
          reason: a.reason,
          txRequestId: a.txRequestId,
          createdAt: a.createdAt.toISOString(),
        })),
        nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
      };
    },
  );

  app.get(
    "/tx/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["checkin"],
        summary: "Relayer transaction status and attempts (organizer/staff)",
        security: bearer,
        params: idParam,
      },
    },
    async (req) => {
      const tx = await db.txRequest.findUnique({ where: { id: req.params.id } });
      if (!tx) throw notFound("Transaction");
      const tokenId = Number(tx.idempotencyKey.split(":")[1]);
      const ticket = Number.isFinite(tokenId)
        ? await db.ticket.findUnique({ where: { tokenId } })
        : null;
      if (!ticket || !(await isStaffOrOrganizer(db, ticket.eventId, authAddress(req)))) {
        throw new AppError(
          "FORBIDDEN",
          "Only staff or the organizer of the ticket's event can view this",
          403,
        );
      }
      return {
        id: tx.id,
        kind: tx.kind,
        tokenId,
        status: tx.status,
        nonce: tx.nonce,
        lastHash: tx.lastHash,
        error: tx.error,
        attempts: parseAttempts(tx),
        createdAt: tx.createdAt.toISOString(),
        updatedAt: tx.updatedAt.toISOString(),
      };
    },
  );
}
