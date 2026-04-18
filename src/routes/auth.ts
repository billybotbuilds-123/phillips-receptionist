import type { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcrypt";
import { db } from "../db/client.js";
import {
  isRateLimited,
  recordLoginAttempt,
  createSession,
  deleteSession,
  BCRYPT_ROUNDS,
  verifyPassword,
} from "../lib/auth.js";
import { generateToken, sha256 } from "../lib/crypto.js";
import { sendEmail } from "../services/gmail.js";
import { settings } from "../lib/settings.js";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get("/login", { config: { skipAuth: true } }, async (request, reply) => {
    const next = (request.query as Record<string, string>)["next"] ?? "/admin";
    return reply.view("login.ejs", { next, error: null });
  });

  app.post("/login", { config: { skipAuth: true } }, async (request, reply) => {
    const ip = request.ip;

    const rateCheck = await isRateLimited(ip);
    if (rateCheck.limited) {
      return reply.status(429).send({
        error: "rate_limited",
        retry_after_seconds: rateCheck.retryAfterSeconds,
      });
    }

    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request" });
    }

    const { username, password } = parsed.data;

    const user = await db.user.findUnique({ where: { username } });
    if (!user) {
      await recordLoginAttempt(username, ip, false);
      return reply.status(401).send({ error: "invalid_credentials" });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      await recordLoginAttempt(username, ip, false, user.id);
      return reply.status(401).send({ error: "invalid_credentials" });
    }

    await recordLoginAttempt(username, ip, true, user.id);
    const sessionId = await createSession(user.id, ip, request.headers["user-agent"]);

    request.session.set("session", { session_id: sessionId, user_id: user.id });

    const next = (request.body as Record<string, string>)["next"] ?? "/admin";
    return reply.redirect(302, next.startsWith("/") ? next : "/admin");
  });

  app.post("/logout", async (request, reply) => {
    const sessionData = request.session.get("session") as { session_id: string } | undefined;
    if (sessionData?.session_id) {
      await deleteSession(sessionData.session_id);
    }
    request.session.delete();
    return reply.redirect(302, "/login");
  });

  app.post("/forgot-password", { config: { skipAuth: true } }, async (request, reply) => {
    const body = request.body as Record<string, string>;
    const email = body["email"] ?? "";

    const user = await db.user.findFirst({ where: { email } });
    if (user) {
      const token = generateToken(32);
      const tokenHash = sha256(token);
      await db.passwordResetToken.create({
        data: {
          user_id: user.id,
          token_hash: tokenHash,
          expires_at: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      try {
        await sendEmail({
          to: email,
          subject: "Reset your password — Mr. Phillips Receptionist",
          templateName: "password-reset",
          vars: {
            reset_url: `${config.PUBLIC_URL}/reset-password/${token}`,
            username: user.username,
          },
        });
      } catch (err) {
        logger.error({ err }, "failed to send password reset email");
      }
    }

    // Always 200 to prevent user enumeration
    return reply.status(200).send({ ok: true });
  });

  app.get("/reset-password/:token", { config: { skipAuth: true } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const tokenHash = sha256(token);
    const record = await db.passwordResetToken.findFirst({
      where: { token_hash: tokenHash, used_at: null, expires_at: { gt: new Date() } },
    });
    if (!record) {
      return reply.view("login.ejs", { next: "/admin", error: "Invalid or expired reset link." });
    }
    return reply.view("reset-password.ejs", { token, error: null });
  });

  app.post("/reset-password/:token", { config: { skipAuth: true } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const body = request.body as Record<string, string>;
    const newPassword = body["new_password"] ?? "";

    if (newPassword.length < 8) {
      return reply.view("reset-password.ejs", { token, error: "Password must be at least 8 characters." });
    }

    const tokenHash = sha256(token);
    const record = await db.passwordResetToken.findFirst({
      where: { token_hash: tokenHash, used_at: null, expires_at: { gt: new Date() } },
    });

    if (!record) {
      return reply.view("login.ejs", { next: "/admin", error: "Invalid or expired reset link." });
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await db.user.update({ where: { id: record.user_id }, data: { password_hash: newHash } });
    await db.passwordResetToken.update({ where: { id: record.id }, data: { used_at: new Date() } });
    // Invalidate all sessions for this user
    await db.session.deleteMany({ where: { user_id: record.user_id } });

    return reply.redirect(302, "/login");
  });
}
