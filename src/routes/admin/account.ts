import type { FastifyInstance } from "fastify";
import bcrypt from "bcrypt";
import { db } from "../../db/client.js";
import { verifyPassword, BCRYPT_ROUNDS } from "../../lib/auth.js";
import { generatePreview } from "../../services/elevenlabs.js";
import { settings } from "../../lib/settings.js";

export async function adminAccountRoutes(app: FastifyInstance): Promise<void> {
  // POST /admin/account/change-password
  app.post("/admin/account/change-password", async (request, reply) => {
    const body = request.body as Record<string, string>;
    const currentPw = body["current_password"] ?? "";
    const newPw = body["new_password"] ?? "";

    if (newPw.length < 8) {
      return reply.status(400).send({ error: "validation_error", message: "Password must be at least 8 characters." });
    }

    const user = await db.user.findUnique({ where: { id: request.user!.id } });
    if (!user) return reply.status(404).send({ error: "not_found" });

    const valid = await verifyPassword(currentPw, user.password_hash);
    if (!valid) {
      return reply.status(401).send({ error: "invalid_credentials", message: "Current password is incorrect." });
    }

    const newHash = await bcrypt.hash(newPw, BCRYPT_ROUNDS);
    await db.user.update({ where: { id: user.id }, data: { password_hash: newHash } });

    // Invalidate all sessions except current
    const sessionData = request.session.get("session") as { session_id: string } | undefined;
    await db.session.deleteMany({
      where: {
        user_id: user.id,
        id: { not: sessionData?.session_id ?? "" },
      },
    });

    return reply.send({ ok: true });
  });

  // POST /admin/account/revoke-session/:sessionId
  app.post("/admin/account/revoke-session/:sessionId", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const currentSession = request.session.get("session") as { session_id: string } | undefined;

    if (sessionId === currentSession?.session_id) {
      return reply.status(400).send({ error: "cannot_revoke_current_session" });
    }

    await db.session.deleteMany({
      where: { id: sessionId, user_id: request.user!.id },
    });

    return reply.send({ ok: true });
  });

  // POST /admin/elevenlabs/preview — generate audio preview
  app.post("/admin/elevenlabs/preview", async (request, reply) => {
    const voiceId = await settings.get("elevenlabs_voice_id");
    const audioBuffer = await generatePreview(voiceId);
    reply.raw.setHeader("Content-Type", "audio/mpeg");
    reply.raw.setHeader("Content-Length", String(audioBuffer.length));
    return reply.send(audioBuffer);
  });
}
