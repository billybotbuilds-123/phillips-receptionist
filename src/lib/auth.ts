import bcrypt from "bcrypt";
import { db } from "../db/client.js";
import { config } from "./config.js";
import type { FastifyRequest, FastifyReply } from "fastify";

export const BCRYPT_ROUNDS = 12;
export const SESSION_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createSession(
  userId: string,
  ip?: string,
  userAgent?: string,
): Promise<string> {
  const session = await db.session.create({
    data: {
      user_id: userId,
      expires_at: new Date(Date.now() + SESSION_DURATION_MS),
      ip: ip ?? null,
      user_agent: userAgent ?? null,
    },
  });
  return session.id;
}

export async function validateSession(
  sessionId: string,
): Promise<{ id: string; username: string } | null> {
  const session = await db.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });

  if (!session) return null;
  if (session.expires_at < new Date()) {
    await db.session.delete({ where: { id: sessionId } });
    return null;
  }

  // Slide expiry
  await db.session.update({
    where: { id: sessionId },
    data: { expires_at: new Date(Date.now() + SESSION_DURATION_MS) },
  });

  return { id: session.user.id, username: session.user.username };
}

export async function deleteSession(sessionId: string): Promise<void> {
  await db.session.deleteMany({ where: { id: sessionId } });
}

export async function isRateLimited(ip: string): Promise<{ limited: boolean; retryAfterSeconds: number }> {
  const windowStart = new Date(Date.now() - 15 * 60 * 1000);
  const attempts = await db.loginAttempt.count({
    where: {
      ip,
      success: false,
      created_at: { gte: windowStart },
    },
  });

  if (attempts >= 5) {
    const oldest = await db.loginAttempt.findFirst({
      where: { ip, success: false, created_at: { gte: windowStart } },
      orderBy: { created_at: "asc" },
    });
    const resetAt = oldest
      ? new Date(oldest.created_at.getTime() + 15 * 60 * 1000)
      : new Date(Date.now() + 15 * 60 * 1000);
    const retryAfterSeconds = Math.ceil((resetAt.getTime() - Date.now()) / 1000);
    return { limited: true, retryAfterSeconds };
  }

  return { limited: false, retryAfterSeconds: 0 };
}

export async function recordLoginAttempt(
  usernameTried: string,
  ip: string,
  success: boolean,
  userId?: string,
): Promise<void> {
  await db.loginAttempt.create({
    data: {
      username_tried: usernameTried,
      ip,
      success,
      user_id: userId ?? null,
    },
  });
}

export async function ensureBootstrapUser(): Promise<void> {
  const count = await db.user.count();
  if (count === 0) {
    await db.user.create({
      data: {
        username: config.ADMIN_USERNAME,
        password_hash: config.ADMIN_PASSWORD_HASH,
      },
    });
  }
}

declare module "fastify" {
  interface FastifyRequest {
    user?: { id: string; username: string };
    rawBody?: Buffer;
  }
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const sessionData = (request.session as unknown as { get(k: string): unknown }).get("session") as { session_id: string; user_id: string } | undefined;

  if (!sessionData?.session_id) {
    const next = encodeURIComponent(request.url);
    return reply.redirect(302, `/login?next=${next}`);
  }

  const user = await validateSession(sessionData.session_id);
  if (!user) {
    request.session.delete();
    const next = encodeURIComponent(request.url);
    return reply.redirect(302, `/login?next=${next}`);
  }

  request.user = user;
}
