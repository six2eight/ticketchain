import { errorMessage } from "../../lib/errors.js";
import type { App, AppDeps } from "../types.js";

export function healthRoutes(app: App, deps: AppDeps) {
  app.get(
    "/config",
    {
      schema: {
        tags: ["system"],
        summary: "Public client configuration (chain, contract, QR TTL)",
      },
    },
    async () => ({
      chainId: deps.config.CHAIN_ID,
      contractAddress: deps.config.contractAddress,
      qrTtlSeconds: deps.config.QR_TTL_SECONDS,
      publicBaseUrl: deps.config.PUBLIC_BASE_URL,
    }),
  );

  app.get(
    "/health",
    { schema: { tags: ["system"], summary: "DB, indexer lag and relayer balance" } },
    async (req, reply) => {
      let db = "ok";
      try {
        await deps.db.$queryRaw`SELECT 1`;
      } catch (err) {
        db = "error";
        req.log.error({ err: errorMessage(err) }, "health: db check failed");
      }

      const idx = deps.indexer.status();
      let chainHead = idx.chainHead;
      if (deps.chainHead) {
        try {
          chainHead = await deps.chainHead();
        } catch {
          // keep the indexer's last seen head
        }
      }
      const relayer = deps.relayer.status();
      const lag = chainHead === null ? null : chainHead - idx.lastIndexedBlock;
      const ok = db === "ok";

      return reply.status(ok ? 200 : 503).send({
        status: ok ? (relayer.low ? "degraded" : "ok") : "error",
        db,
        chainHead: chainHead?.toString() ?? null,
        indexedBlock: idx.lastIndexedBlock.toString(),
        lag: lag?.toString() ?? null,
        relayer: {
          address: relayer.address,
          balanceWei: relayer.balanceWei?.toString() ?? null,
          low: relayer.low,
        },
      });
    },
  );
}
