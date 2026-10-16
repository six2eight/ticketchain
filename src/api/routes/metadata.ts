import { notFound } from "../../lib/errors.js";
import { renderTicketSvg } from "../../metadata/svg.js";
import { tokenParam } from "../schemas.js";
import type { App, AppDeps } from "../types.js";

export function metadataRoutes(app: App, { db, config }: AppDeps) {
  const base = config.PUBLIC_BASE_URL.replace(/\/+$/, "");

  async function load(tokenId: number) {
    const ticket = await db.ticket.findUnique({ where: { tokenId }, include: { event: true } });
    if (!ticket) throw notFound("Ticket");
    return ticket;
  }

  app.get(
    "/metadata/:tokenId",
    { schema: { tags: ["metadata"], summary: "ERC-721 metadata JSON", params: tokenParam } },
    async (req, reply) => {
      const t = await load(req.params.tokenId);
      reply.header("cache-control", "public, max-age=15");
      return {
        name: `${t.event.name} — Ticket #${t.tokenId}`,
        description:
          t.event.description ??
          `Ticket #${t.tokenId} for ${t.event.name}. Show the rotating QR code at the door.`,
        image: `${base}/metadata/${t.tokenId}/image.svg`,
        external_url: `${base}/tickets/${t.tokenId}`,
        attributes: [
          { trait_type: "Event", value: t.event.name },
          { trait_type: "Event ID", value: t.eventId },
          { trait_type: "Status", value: t.status },
          { trait_type: "Venue", value: t.event.venue ?? "TBA" },
          {
            display_type: "date",
            trait_type: "Starts",
            value: Math.floor(t.event.startTime.getTime() / 1000),
          },
        ],
      };
    },
  );

  app.get(
    "/metadata/:tokenId/image.svg",
    {
      schema: {
        tags: ["metadata"],
        summary: "SVG ticket image (shows VALID / USED)",
        params: tokenParam,
      },
    },
    async (req, reply) => {
      const t = await load(req.params.tokenId);
      return reply
        .header("content-type", "image/svg+xml; charset=utf-8")
        .header("cache-control", "public, max-age=15")
        .send(
          renderTicketSvg({
            tokenId: t.tokenId,
            eventName: t.event.name,
            venue: t.event.venue,
            startTime: t.event.startTime,
            status: t.status,
          }),
        );
    },
  );
}
