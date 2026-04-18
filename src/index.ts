import Fastify from "fastify";
import fastifySecureSession from "@fastify/secure-session";
import fastifyFormbody from "@fastify/formbody";
import fastifyCsrf from "@fastify/csrf-protection";
import fastifyView from "@fastify/view";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import * as ejs from "ejs";
import * as Sentry from "@sentry/node";

import { config } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { authMiddleware, ensureBootstrapUser } from "./lib/auth.js";
import { db } from "./db/client.js";

import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { vapiRoutes } from "./routes/vapi.js";
import { calendlyRoutes } from "./routes/calendly.js";
import { adminIndexRoutes } from "./routes/admin/index.js";
import { adminSettingsRoutes } from "./routes/admin/settings.js";
import { adminCallsRoutes } from "./routes/admin/calls.js";
import { adminExportRoutes } from "./routes/admin/export.js";
import { adminAccountRoutes } from "./routes/admin/account.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (config.SENTRY_DSN) {
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    beforeSend(event) {
      // PII scrubbing
      const piiFields = ["parent_email", "parent_phone", "raw_transcript"];
      if (event.extra) {
        for (const field of piiFields) {
          if (field in event.extra) {
            event.extra[field] = "[REDACTED]";
          }
        }
      }
      // Scrub setting values from request bodies
      if (event.request?.data && typeof event.request.data === "object") {
        const data = event.request.data as Record<string, unknown>;
        if ("value" in data) data["value"] = "[REDACTED]";
      }
      return event;
    },
  });
}

async function buildApp() {
  const app = Fastify({
    logger: logger as Parameters<typeof Fastify>[0]["logger"],
    trustProxy: true,
    bodyLimit: 1_048_576, // 1MB
  });

  // Store raw body for HMAC verification
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, async (request, body) => {
    (request as typeof request & { rawBody: Buffer }).rawBody = body;
    try {
      return JSON.parse(body.toString("utf8")) as unknown;
    } catch {
      throw new Error("Invalid JSON");
    }
  });

  // Plugins
  await app.register(fastifyFormbody);

  const sessionKey = Buffer.from(config.SESSION_SECRET, "hex");
  await app.register(fastifySecureSession, {
    key: sessionKey,
    cookie: {
      path: "/",
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 2 * 60 * 60, // 2 hours
    },
  });

  await app.register(fastifyCsrf, { sessionPlugin: "@fastify/secure-session" });

  await app.register(fastifyView, {
    engine: { ejs },
    root: join(__dirname, "templates/admin"),
    layout: "layout.ejs",
    viewExt: "ejs",
    options: { outputFunctionName: "print" },
  });

  await app.register(fastifyStatic, {
    root: join(__dirname, "../public"),
    prefix: "/public/",
    decorateReply: false,
  });

  // Auth middleware for /admin routes
  app.addHook("preHandler", async (request, reply) => {
    const isAdminRoute = request.url.startsWith("/admin");
    const isLogout = request.url === "/logout";
    const skipAuth = (request.routeOptions.config as Record<string, unknown> | undefined)?.["skipAuth"];

    if ((isAdminRoute || isLogout) && !skipAuth) {
      await authMiddleware(request, reply);
    }
  });

  // Security headers
  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("X-XSS-Protection", "1; mode=block");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; script-src 'self' 'unsafe-inline'; img-src 'self' data:",
    );
  });

  // Routes
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(vapiRoutes);
  await app.register(calendlyRoutes);
  await app.register(adminIndexRoutes);
  await app.register(adminSettingsRoutes);
  await app.register(adminCallsRoutes);
  await app.register(adminExportRoutes);
  await app.register(adminAccountRoutes);

  // 404 fallback
  app.setNotFoundHandler(async (request, reply) => {
    return reply.status(404).send({ error: "not_found" });
  });

  // Error handler
  app.setErrorHandler(async (error, request, reply) => {
    logger.error({ err: error, url: request.url }, "unhandled error");
    Sentry.captureException(error);
    return reply.status(500).send({ error: "internal_error" });
  });

  return app;
}

async function start() {
  const app = await buildApp();

  await db.$connect();
  await ensureBootstrapUser();

  const address = await app.listen({ port: config.PORT, host: "0.0.0.0" });
  logger.info({ address }, "server started");
}

start().catch((err) => {
  logger.error(err, "failed to start server");
  process.exit(1);
});
