import Fastify from "fastify";
import fastifySecureSession from "@fastify/secure-session";
import fastifyFormbody from "@fastify/formbody";
import fastifyCsrf from "@fastify/csrf-protection";
import fastifyRateLimit from "@fastify/rate-limit";
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
import { mcpRoutes } from "./routes/mcp.js";
import { calendlyRoutes } from "./routes/calendly.js";
import { twilioInboundRoutes } from "./routes/twilio-inbound.js";
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
      const piiFields = ["parent_email", "parent_phone", "raw_transcript"];
      if (event.extra) {
        for (const field of piiFields) {
          if (field in event.extra) {
            event.extra[field] = "[REDACTED]";
          }
        }
      }
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
    bodyLimit: 1_048_576,
  });

  // Preserve raw body on JSON requests for HMAC verification (Vapi, Calendly).
  // The MCP route reads request.body directly — the SDK re-parses from JSON
  // so this content parser supports both.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    async (request: import("fastify").FastifyRequest, body: Buffer) => {
      (request as import("fastify").FastifyRequest & { rawBody: Buffer }).rawBody = body;
      try {
        return JSON.parse(body.toString("utf8")) as unknown;
      } catch {
        throw new Error("Invalid JSON");
      }
    },
  );

  await app.register(fastifyFormbody);

  // Rate-limit plugin, opt-in per-route.
  await app.register(fastifyRateLimit, { global: false });

  const sessionKey = Buffer.from(config.SESSION_SECRET, "hex");
  await app.register(fastifySecureSession, {
    key: sessionKey,
    cookie: {
      path: "/",
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 2 * 60 * 60, // seconds — @fastify/secure-session maxAge is seconds
    },
  });

  await app.register(fastifyCsrf, {
    sessionPlugin: "@fastify/secure-session",
    cookieOpts: { signed: false, sameSite: "lax" },
    getToken: (req) => {
      const hdr = req.headers["x-csrf-token"];
      if (typeof hdr === "string") return hdr;
      const body = req.body as Record<string, string> | undefined;
      return body?.["_csrf"];
    },
  });

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

  // Auth + CSRF enforcement for /admin routes.
  app.addHook("preHandler", async (request, reply) => {
    const isAdminRoute = request.url.startsWith("/admin");
    const isLogout = request.url === "/logout";
    const skipAuth = (request.routeOptions.config as unknown as Record<string, unknown> | undefined)?.[
      "skipAuth"
    ];

    if ((isAdminRoute || isLogout) && !skipAuth) {
      await authMiddleware(request, reply);
      if (reply.sent) return;

      // CSRF: enforce on state-changing methods. The @fastify/csrf-protection
      // plugin decorates the instance with `csrfProtection`; we invoke it
      // directly so every state-changing admin request is guarded regardless
      // of whether a route opted in.
      const method = request.method.toUpperCase();
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        try {
          // @ts-expect-error csrf-protection's preValidation isn't on the typed
          // FastifyInstance surface but is decorated onto the instance.
          await app.csrfProtection(request, reply);
        } catch (err) {
          logger.warn(
            { url: request.url, err: String(err) },
            "csrf validation failed",
          );
          if (!reply.sent) {
            reply.status(403).send({ error: "csrf_failed" });
          }
        }
      }
    }
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("X-XSS-Protection", "1; mode=block");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; script-src 'self' 'unsafe-inline'; img-src 'self' data:",
    );
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(vapiRoutes);
  await app.register(mcpRoutes);
  await app.register(calendlyRoutes);
  await app.register(twilioInboundRoutes);
  await app.register(adminIndexRoutes);
  await app.register(adminSettingsRoutes);
  await app.register(adminCallsRoutes);
  await app.register(adminExportRoutes);
  await app.register(adminAccountRoutes);

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.status(404).send({ error: "not_found" });
  });

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
