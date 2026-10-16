import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { AppError, unauthorized } from "../lib/errors.js";
import { authRoutes } from "./routes/auth.js";
import { checkinRoutes } from "./routes/checkin.js";
import { eventRoutes } from "./routes/events.js";
import { healthRoutes } from "./routes/health.js";
import { metadataRoutes } from "./routes/metadata.js";
import { ticketRoutes } from "./routes/tickets.js";
import type { App, AppDeps } from "./types.js";

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export async function buildApp(deps: AppDeps): Promise<App> {
  const { config } = deps;
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    genReqId: (req) => {
      const header = req.headers["x-request-id"];
      return typeof header === "string" && header.length <= 128 ? header : randomUUID();
    },
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof AppError) {
      return reply
        .status(err.statusCode)
        .send({ error: { code: err.code, message: err.message, ...err.details } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          issues: err.validation.map((v) => ({
            path: `${err.validationContext ?? ""}${v.instancePath}`,
            message: v.message,
          })),
        },
      });
    }
    if (err.code?.startsWith("FST_JWT")) {
      const e = unauthorized(err.message);
      return reply.status(401).send({ error: { code: e.code, message: e.message } });
    }
    const status = err.statusCode ?? 500;
    if (status < 500) {
      return reply
        .status(status)
        .send({ error: { code: err.code ?? "BAD_REQUEST", message: err.message } });
    }
    req.log.error({ err }, "unhandled error");
    return reply
      .status(500)
      .send({ error: { code: "INTERNAL", message: "Internal server error" } });
  });

  app.setNotFoundHandler((req, reply) =>
    reply
      .status(404)
      .send({ error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.url} not found` } }),
  );

  await app.register(cors, {
    origin: config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN.split(",").map((s) => s.trim()),
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) =>
      new AppError("RATE_LIMITED", `Too many requests, retry in ${ctx.after}`, ctx.statusCode),
  });
  await app.register(jwt, { secret: config.JWT_SECRET, sign: { expiresIn: "24h" } });

  app.decorate("requireAuth", async (req: FastifyRequest) => {
    await req.jwtVerify();
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "TicketChain API",
        description:
          "NFT event tickets with fraud-proof QR check-in. Authenticate with `POST /auth/nonce` + `POST /auth/verify`, then click **Authorize** and paste the JWT.",
        version: "1.0.0",
      },
      servers: [{ url: config.PUBLIC_BASE_URL }],
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      },
      tags: [
        { name: "auth" },
        { name: "events" },
        { name: "tickets" },
        { name: "checkin" },
        { name: "metadata" },
        { name: "system" },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  authRoutes(app, deps);
  eventRoutes(app, deps);
  ticketRoutes(app, deps);
  checkinRoutes(app, deps);
  metadataRoutes(app, deps);
  healthRoutes(app, deps);

  await app.ready();
  return app;
}
