import { isAddressEqual } from "viem";
import { z } from "zod";

import { authAddress, requireTicketOwner } from "../../auth/guards.js";
import { checkinMessage, deviceKeyTypedData, recoverDeviceKeySigner } from "../../checkin/qr.js";
import { AppError, notFound } from "../../lib/errors.js";
import { toJsonSafe } from "../../lib/json.js";
import { page, ticketDto, transferDto } from "../dto.js";
import { address, bearer, hexString, pagination, tokenParam } from "../schemas.js";
import type { App, AppDeps } from "../types.js";

/** Device keys may live until 24 h after the event starts. */
const MAX_AFTER_START_S = 24 * 3600;

export function ticketRoutes(app: App, { db, config, clock }: AppDeps) {
  const base = config.PUBLIC_BASE_URL.replace(/\/+$/, "");

  app.get(
    "/me/roles",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["tickets"],
        summary: "Events I organize or staff (drives which menus the UI shows)",
        security: bearer,
      },
    },
    async (req) => {
      const me = authAddress(req);
      const [organized, staffed] = await Promise.all([
        db.event.findMany({
          where: { organizer: me },
          select: { id: true },
          orderBy: { id: "asc" },
        }),
        db.staff.findMany({
          where: { wallet: me },
          select: { eventId: true },
          orderBy: { eventId: "asc" },
        }),
      ]);
      return { organizerOf: organized.map((e) => e.id), staffOf: staffed.map((s) => s.eventId) };
    },
  );

  app.get(
    "/me/tickets",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["tickets"],
        summary: "My tickets with status",
        security: bearer,
        querystring: z.object({
          eventId: z.coerce.number().int().positive().optional(),
          ...pagination,
        }),
      },
    },
    async (req) => {
      const { eventId, limit, cursor } = req.query;
      const rows = await db.ticket.findMany({
        where: {
          owner: authAddress(req),
          ...(eventId ? { eventId } : {}),
          ...(cursor !== undefined ? { tokenId: { gt: cursor } } : {}),
        },
        include: { event: { select: { name: true, startTime: true, venue: true } } },
        orderBy: { tokenId: "asc" },
        take: limit + 1,
      });
      const p = page(rows, limit, (t) => t.tokenId);
      return {
        items: p.items.map((t) => ({
          ...ticketDto(t, base),
          event: {
            name: t.event.name,
            startTime: t.event.startTime.toISOString(),
            venue: t.event.venue,
          },
        })),
        nextCursor: p.nextCursor,
      };
    },
  );

  app.get(
    "/tickets/:tokenId",
    { schema: { tags: ["tickets"], summary: "Ticket and transfer history", params: tokenParam } },
    async (req) => {
      const ticket = await db.ticket.findUnique({
        where: { tokenId: req.params.tokenId },
        include: { transfers: { orderBy: [{ block: "asc" }, { logIndex: "asc" }] } },
      });
      if (!ticket) throw notFound("Ticket");
      return { ...ticketDto(ticket, base), transfers: ticket.transfers.map(transferDto) };
    },
  );

  app.get(
    "/listings",
    {
      schema: {
        tags: ["tickets"],
        summary: "Resale listings",
        querystring: z.object({
          eventId: z.coerce.number().int().positive().optional(),
          ...pagination,
        }),
      },
    },
    async (req) => {
      const { eventId, limit, cursor } = req.query;
      const rows = await db.ticket.findMany({
        where: {
          listedPriceWei: { not: null },
          status: "VALID",
          ...(eventId ? { eventId } : {}),
          ...(cursor !== undefined ? { tokenId: { gt: cursor } } : {}),
        },
        orderBy: { tokenId: "asc" },
        take: limit + 1,
      });
      const p = page(rows, limit, (t) => t.tokenId);
      return {
        items: p.items.map((t) => ({
          tokenId: t.tokenId,
          eventId: t.eventId,
          seller: t.owner,
          priceWei: t.listedPriceWei!,
        })),
        nextCursor: p.nextCursor,
      };
    },
  );

  // ------------------------------------------------------------------ device keys

  async function validateExpiry(eventId: number, expiresAt: number) {
    const event = await db.event.findUniqueOrThrow({ where: { id: eventId } });
    const now = Math.floor(clock() / 1000);
    const max = Math.floor(event.startTime.getTime() / 1000) + MAX_AFTER_START_S;
    if (expiresAt <= now || expiresAt > max) {
      throw new AppError(
        "INVALID_EXPIRY",
        `expiresAt must be in the future and at most event start + 24 h (${max})`,
        400,
        { maxExpiresAt: max },
      );
    }
  }

  const deviceQuery = z.object({ device: address, expiresAt: z.coerce.number().int().positive() });

  app.get(
    "/tickets/:tokenId/device-key-typed-data",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["tickets"],
        summary: "EIP-712 typed data the owner signs to register a device key",
        security: bearer,
        params: tokenParam,
        querystring: deviceQuery,
      },
    },
    async (req) => {
      const ticket = await requireTicketOwner(db, req.params.tokenId, authAddress(req));
      await validateExpiry(ticket.eventId, req.query.expiresAt);
      return toJsonSafe(
        deviceKeyTypedData({
          chainId: config.CHAIN_ID,
          contract: config.contractAddress,
          tokenId: ticket.tokenId,
          device: req.query.device,
          expiresAt: req.query.expiresAt,
        }),
      );
    },
  );

  app.post(
    "/tickets/:tokenId/device-keys",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["tickets"],
        summary: "Register a device key (signed EIP-712 delegation from the owner)",
        security: bearer,
        params: tokenParam,
        body: deviceQuery.extend({ signature: hexString }),
      },
    },
    async (req, reply) => {
      const ticket = await requireTicketOwner(db, req.params.tokenId, authAddress(req));
      if (ticket.status !== "VALID") {
        throw new AppError("TICKET_NOT_VALID", `Ticket is ${ticket.status}`, 409);
      }
      const { device, expiresAt, signature } = req.body;
      await validateExpiry(ticket.eventId, expiresAt);

      let signer: string;
      try {
        signer = await recoverDeviceKeySigner({
          chainId: config.CHAIN_ID,
          contract: config.contractAddress,
          tokenId: ticket.tokenId,
          device,
          expiresAt,
          signature,
        });
      } catch {
        throw new AppError("INVALID_SIGNATURE", "Signature is malformed", 400);
      }
      if (!isAddressEqual(signer as `0x${string}`, ticket.owner as `0x${string}`)) {
        throw new AppError(
          "INVALID_SIGNATURE",
          "Delegation was not signed by the ticket owner",
          400,
        );
      }

      const key = await db.deviceKey.create({
        data: {
          tokenId: ticket.tokenId,
          deviceAddr: device,
          ownerAtReg: ticket.owner,
          expiresAt: new Date(expiresAt * 1000),
        },
      });
      return reply.status(201).send({
        id: key.id,
        tokenId: key.tokenId,
        device: key.deviceAddr,
        expiresAt: key.expiresAt.toISOString(),
      });
    },
  );

  app.get(
    "/tickets/:tokenId/device-keys",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["tickets"],
        summary: "My device keys for a ticket",
        security: bearer,
        params: tokenParam,
      },
    },
    async (req) => {
      const ticket = await requireTicketOwner(db, req.params.tokenId, authAddress(req));
      const keys = await db.deviceKey.findMany({
        where: { tokenId: ticket.tokenId, ownerAtReg: ticket.owner },
        orderBy: { id: "asc" },
      });
      return {
        items: keys.map((k) => ({
          id: k.id,
          device: k.deviceAddr,
          expiresAt: k.expiresAt.toISOString(),
          revoked: k.revoked,
        })),
      };
    },
  );

  app.delete(
    "/tickets/:tokenId/device-keys/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["tickets"],
        summary: "Revoke a device key",
        security: bearer,
        params: tokenParam.extend({ id: z.coerce.number().int().positive() }),
      },
    },
    async (req, reply) => {
      const ticket = await requireTicketOwner(db, req.params.tokenId, authAddress(req));
      const res = await db.deviceKey.updateMany({
        where: { id: req.params.id, tokenId: ticket.tokenId, ownerAtReg: ticket.owner },
        data: { revoked: true },
      });
      if (res.count === 0) throw notFound("Device key");
      return reply.status(204).send();
    },
  );

  app.get(
    "/tickets/:tokenId/qr-preview",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["tickets"],
        summary: "Dev aid: the unsigned QR payload and the message the device key must sign",
        security: bearer,
        params: tokenParam,
      },
    },
    async (req) => {
      const ticket = await requireTicketOwner(db, req.params.tokenId, authAddress(req));
      const payload = {
        v: 1 as const,
        t: ticket.tokenId,
        e: ticket.eventId,
        x: Math.floor(clock() / 1000) + config.QR_TTL_SECONDS,
        n: "00112233445566778899aabbccddeeff",
      };
      return {
        payload,
        message: checkinMessage(config.CHAIN_ID, config.contractAddress, payload),
        howTo:
          "Sign `message` with the registered device key (EIP-191 personal_sign), add it as `s`, then base64url(JSON.stringify(payload)). Use a fresh random `n` for every QR.",
      };
    },
  );
}
