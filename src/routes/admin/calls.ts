import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/client.js";
import { sendEmail } from "../../services/gmail.js";
import { sendSms } from "../../services/twilio.js";
import { settings } from "../../lib/settings.js";
import { config } from "../../lib/config.js";
import { logger } from "../../lib/logger.js";

export async function adminCallsRoutes(app: FastifyInstance): Promise<void> {
  // GET /admin/calls — list all calls
  app.get("/admin/calls", async (request, reply) => {
    const page = parseInt((request.query as Record<string, string>)["page"] ?? "1");
    const pageSize = 50;

    const [calls, total] = await Promise.all([
      db.call.findMany({
        orderBy: { started_at: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.call.count(),
    ]);

    return reply.view("calls-list.ejs", {
      user: request.user,
      calls,
      page,
      totalPages: Math.ceil(total / pageSize),
      publicUrl: config.PUBLIC_URL,
    });
  });

  // GET /admin/calls/:id
  app.get("/admin/calls/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const call = await db.call.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { sent_at: "asc" } },
      },
    });

    if (!call) return reply.status(404).view("404.ejs", { user: request.user });

    return reply.view("call-detail.ejs", {
      user: request.user,
      call,
      publicUrl: config.PUBLIC_URL,
    });
  });

  // POST /admin/calls/:id/flag
  app.post("/admin/calls/:id/flag", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, string>;
    const note = body["note"] ?? "";

    await db.call.update({
      where: { id },
      data: { flagged: true, flag_note: note },
    });

    return reply.send({ ok: true });
  });

  // POST /admin/calls/:id/manual-follow-up
  app.post("/admin/calls/:id/manual-follow-up", async (request, reply) => {
    const { id } = request.params as { id: string };
    const call = await db.call.findUnique({ where: { id } });
    if (!call) return reply.status(404).send({ error: "not_found" });

    const feeCents = parseInt(await settings.get("consultation_fee_cents").catch(() => "3000"));
    const feeDollars = (feeCents / 100).toFixed(2);
    const calendlyUrl = await settings.get("calendly_event_type_uri").catch(() => "");

    const vars = {
      parent_name: call.parent_name ?? "there",
      calendly_url: calendlyUrl,
      consultation_fee_dollars: feeDollars,
    };

    const results = await Promise.allSettled([
      call.parent_email
        ? sendEmail({
            to: call.parent_email,
            subject: "Just checking in — here's the scheduling link again",
            templateName: "follow-up-24h",
            vars,
          })
        : Promise.resolve(null),
      call.parent_phone
        ? sendSms({
            to: call.parent_phone,
            templateName: "follow-up-24h",
            vars,
            callId: call.id,
          })
        : Promise.resolve(null),
    ]);

    for (const [i, result] of results.entries()) {
      const channel = i === 0 ? "email" : "sms";
      const recipient = i === 0 ? (call.parent_email ?? "") : (call.parent_phone ?? "");
      if (!recipient) continue;

      if (result.status === "fulfilled") {
        await db.messageLog.create({
          data: {
            call_id: call.id,
            channel: channel as "email" | "sms",
            direction: "outbound",
            template: "follow-up-24h",
            recipient,
            status: "sent",
          },
        });
      } else {
        await db.messageLog.create({
          data: {
            call_id: call.id,
            channel: channel as "email" | "sms",
            direction: "outbound",
            template: "follow-up-24h",
            recipient,
            status: "failed",
            error: String(result.reason),
          },
        });
      }
    }

    return reply.send({ ok: true });
  });
}
