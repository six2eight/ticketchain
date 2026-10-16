import { z } from "zod";

import { createSiweChallenge, verifySiwe } from "../../auth/siwe.js";
import { address, hexString } from "../schemas.js";
import type { App, AppDeps } from "../types.js";

export function authRoutes(app: App, deps: AppDeps) {
  const siwe = {
    db: deps.db,
    publicBaseUrl: deps.config.PUBLIC_BASE_URL,
    chainId: deps.config.CHAIN_ID,
    clock: deps.clock,
  };
  const rateLimit = { max: deps.config.RATE_LIMIT_AUTH_PER_MIN, timeWindow: "1 minute" };

  app.post(
    "/auth/nonce",
    {
      config: { rateLimit },
      schema: {
        tags: ["auth"],
        summary: "Get a SIWE (EIP-4361) message to sign",
        body: z.object({ address }),
        response: {
          200: z.object({ nonce: z.string(), message: z.string(), expiresAt: z.string() }),
        },
      },
    },
    async (req) => {
      const c = await createSiweChallenge(siwe, req.body.address);
      return { nonce: c.nonce, message: c.message, expiresAt: c.expiresAt.toISOString() };
    },
  );

  app.post(
    "/auth/verify",
    {
      config: { rateLimit },
      schema: {
        tags: ["auth"],
        summary: "Verify the signed SIWE message and get a JWT (24 h)",
        body: z.object({ message: z.string().min(1).max(4000), signature: hexString }),
        response: { 200: z.object({ token: z.string(), address: z.string() }) },
      },
    },
    async (req) => {
      const signer = await verifySiwe(siwe, req.body.message, req.body.signature);
      const sub = signer.toLowerCase();
      return { token: app.jwt.sign({ sub }), address: sub };
    },
  );
}
