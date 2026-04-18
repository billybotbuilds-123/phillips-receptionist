import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/client.js";
import { verifyCalendlySignature } from "../lib/hmac.js";
import { logger } from "../lib/logger.js";
import { updateDocAppointmentStatus } from "../services/googleDocs.js";

const inviteeCreatedSchema = z.object({
  event: z.literal("invitee.created"),
  payload: z.object({
    email: z.string().email(),
    event: z.object({
      start_time: z.string(),
      uri: z.string(),
    }),
    uri: z.string(),
  }),
});

const inviteeCanceledSchema = z.object({
  event: z.literal("invitee.canceled"),
  payload: z.object({
    email: z.string().email(),
    event: z.object({
      uri: z.string(),
    }),
    uri: z.string(),
  }),
});

const webhookSchema = z.discriminatedUnion("event", [inviteeCreatedSchema, inviteeCanceledSchema]);

export async function calendlyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/calendly", { config: { skipAuth: true } }, async (request, reply) => {
    const valid = await verifyCalendlySignature(request).catch(() => false);
    if (!valid) {
      logger.warn("invalid calendly signature");
      return reply.status(401).send({ error: "invalid_signature" });
    }

    const parsed = webhookSchema.safeParse(request.body);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, "calendly webhook parse failed");
      return reply.status(200).send({ ok: true }); // return 200 to prevent Calendly retries for bad payloads
    }

    const data = parsed.data;

    if (data.event === "invitee.created") {
      const inviteeEmail = data.payload.email;
      const eventUri = data.payload.event.uri;
      const startTime = data.payload.event.start_time;
      const inviteeUri = data.payload.uri;

      // Match to most recent unbooked call
      const matchedCall = await db.call.findFirst({
        where: {
          parent_email: inviteeEmail,
          booked_at: null,
          canceled_at: null,
        },
        orderBy: { started_at: "desc" },
      });

      if (matchedCall) {
        await db.call.update({
          where: { id: matchedCall.id },
          data: {
            booked_at: new Date(),
            follow_up_skipped: true,
            calendly_event_uri: eventUri,
          },
        });

        if (matchedCall.doc_url) {
          await updateDocAppointmentStatus(matchedCall.doc_url, startTime).catch((err) => {
            logger.error({ err, call_id: matchedCall.id }, "failed to update doc appointment status");
          });
        }

        logger.info({ call_id: matchedCall.id, event: "invitee.created" }, "calendly booking matched to call");
      } else {
        // Create standalone call record
        await db.call.create({
          data: {
            vapi_call_id: `calendly-direct-${inviteeUri.split("/").pop() ?? Date.now()}`,
            parent_email: inviteeEmail,
            booked_at: new Date(),
            follow_up_skipped: true,
            calendly_event_uri: eventUri,
          },
        });
        logger.info({ email: "[REDACTED]", event: "invitee.created" }, "calendly booking created as standalone");
      }
    } else if (data.event === "invitee.canceled") {
      const eventUri = data.payload.event.uri;

      const call = await db.call.findFirst({
        where: { calendly_event_uri: eventUri, canceled_at: null },
        orderBy: { started_at: "desc" },
      });

      if (call) {
        await db.call.update({
          where: { id: call.id },
          data: { canceled_at: new Date() },
        });

        if (call.doc_url) {
          const bookedTime = call.booked_at?.toISOString() ?? "unknown";
          await updateDocAppointmentStatus(call.doc_url, bookedTime, true).catch((err) => {
            logger.error({ err, call_id: call.id }, "failed to update doc cancellation status");
          });
        }

        logger.info({ call_id: call.id, event: "invitee.canceled" }, "calendly booking canceled");
      }
    }

    return reply.status(200).send({ ok: true });
  });
}
