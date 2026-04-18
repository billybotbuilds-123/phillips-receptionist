import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { settings } from "../lib/settings.js";
import { refreshAccessToken } from "../services/googleDocs.js";
import { execSync } from "child_process";

function getGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const startedAt = Date.now();
const version = getGitSha();

interface CheckResult {
  ok: boolean;
  latency_ms?: number;
  error?: string;
  expires_in_seconds?: number;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", { config: { skipAuth: true } }, async (_req, reply) => {
    const checks: Record<string, CheckResult> = {};

    // Database
    const dbStart = Date.now();
    try {
      await db.$queryRaw`SELECT 1`;
      checks["database"] = { ok: true, latency_ms: Date.now() - dbStart };
    } catch (err) {
      checks["database"] = { ok: false, latency_ms: Date.now() - dbStart, error: "db unreachable" };
    }

    // Settings key
    try {
      const present = await settings.isPresent("vapi_webhook_secret");
      checks["settings_key"] = { ok: present };
    } catch {
      checks["settings_key"] = { ok: false, error: "settings not accessible" };
    }

    // Gmail token
    try {
      const { expiresInSeconds } = await refreshAccessToken();
      checks["gmail_token"] = { ok: expiresInSeconds > 0, expires_in_seconds: expiresInSeconds };
    } catch {
      checks["gmail_token"] = { ok: false, error: "token refresh failed" };
    }

    const allChecks = Object.values(checks);
    const dbOk = checks["database"]?.ok ?? false;
    const nonDbOk = allChecks.filter((_, i) => Object.keys(checks)[i] !== "database").every((c) => c.ok);

    const status = !dbOk ? "down" : !nonDbOk ? "degraded" : "ok";

    return reply.status(status === "down" ? 503 : 200).send({
      status,
      checks,
      version,
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  });
}
