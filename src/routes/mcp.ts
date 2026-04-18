/**
 * Mount the MCP server at POST /mcp (and accept GET/DELETE per Streamable
 * HTTP spec, though we're stateless so those short-circuit).
 *
 * Auth: Bearer token stored in settings as `vapi_mcp_secret`. This is the
 * value Shane configures in Vapi's MCP tool "Authorization" header.
 *
 * Per request:
 *   1. Check Bearer token.
 *   2. Pull X-Call-Id (Vapi) or fall back to X-Chat-Id / X-Session-Id.
 *   3. Build a fresh McpServer + StreamableHTTPServerTransport (stateless).
 *   4. Hand off to transport.handleRequest, passing raw IncomingMessage +
 *      ServerResponse (Fastify exposes these via request.raw / reply.raw).
 */

import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "crypto";
import { settings } from "../lib/settings.js";
import { logger } from "../lib/logger.js";
import { buildRileyMcpServer, buildTransport } from "../mcp/server.js";

function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? (match[1] ?? null) : null;
}

function safeEq(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  const handler = async (
    request: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
  ) => {
    // 1. Auth.
    const bearer = extractBearer(
      typeof request.headers["authorization"] === "string"
        ? request.headers["authorization"]
        : undefined,
    );
    if (!bearer) {
      return reply.status(401).send({ error: "missing_bearer" });
    }
    let expected: string;
    try {
      expected = await settings.get("vapi_mcp_secret");
    } catch {
      return reply.status(503).send({ error: "not_configured", key: "vapi_mcp_secret" });
    }
    if (!expected || !safeEq(bearer, expected)) {
      logger.warn({ ip: request.ip }, "invalid mcp bearer token");
      return reply.status(401).send({ error: "invalid_bearer" });
    }

    // 2. Call-id extraction from Vapi's identifying headers.
    const hdr = (name: string): string | undefined => {
      const raw = request.headers[name.toLowerCase()];
      return typeof raw === "string" ? raw : undefined;
    };
    const callId =
      hdr("x-call-id") ??
      hdr("x-chat-id") ??
      hdr("x-session-id") ??
      `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // 3 + 4. Build fresh server + stateless transport per request.
    const server = buildRileyMcpServer({ callId });
    const transport = buildTransport();

    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
      // transport writes to reply.raw directly; prevent Fastify from trying
      // to send a second response.
      reply.hijack();
    } catch (err) {
      logger.error({ err: String(err), callId }, "mcp transport error");
      if (!reply.sent) {
        reply.status(500).send({ error: "mcp_error" });
      }
    }
  };

  // Streamable HTTP supports POST for client→server messages, GET for the
  // optional server-initiated SSE stream, and DELETE to explicitly end a
  // session. In stateless mode we accept POST and let the SDK handle the
  // other verbs (which will be no-ops).
  app.post("/mcp", { config: { skipAuth: true } }, handler);
  app.get("/mcp", { config: { skipAuth: true } }, handler);
  app.delete("/mcp", { config: { skipAuth: true } }, handler);
}
