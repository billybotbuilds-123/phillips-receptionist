import type { FastifyInstance } from "fastify";
import { db } from "../../db/client.js";
import { settings } from "../../lib/settings.js";
import { config } from "../../lib/config.js";
import { logger } from "../../lib/logger.js";

export async function adminIndexRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin", async (request, reply) => {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const [
      todayCalls,
      todayBookings,
      todayEscalations,
      recentCalls,
      pendingFollowUps,
      missingSettings,
    ] = await Promise.all([
      db.call.count({ where: { started_at: { gte: todayStart } } }),
      db.call.count({ where: { booked_at: { gte: todayStart } } }),
      db.call.count({ where: { escalated: true, started_at: { gte: todayStart } } }),
      db.call.findMany({
        orderBy: { started_at: "desc" },
        take: 20,
        select: {
          id: true,
          vapi_call_id: true,
          started_at: true,
          parent_name: true,
          child_grade: true,
          urgency_level: true,
          doc_url: true,
          recording_url: true,
          booked_at: true,
          escalated: true,
          flagged: true,
          flag_note: true,
        },
      }),
      db.call.count({
        where: {
          follow_up_due_at: { lt: now },
          booked_at: null,
          follow_up_sent_at: null,
          follow_up_skipped: false,
          canceled_at: null,
        },
      }),
      settings.getMissingRequired(),
    ]);

    const todayLinksCount = await db.messageLog.count({
      where: {
        template: "booking-link",
        direction: "outbound",
        sent_at: { gte: todayStart },
      },
    });

    const feeCents = parseInt(
      await settings.get("consultation_fee_cents").catch(() => "3000"),
    );
    const todayRevenue = ((todayBookings * feeCents) / 100).toFixed(2);

    return reply.view("dashboard.ejs", {
      user: request.user,
      todayCalls,
      todayBookings,
      todayLinksCount,
      todayEscalations,
      todayRevenue,
      recentCalls,
      pendingFollowUps,
      missingSettings,
      missingCount: missingSettings.length,
      publicUrl: config.PUBLIC_URL,
    });
  });
}
