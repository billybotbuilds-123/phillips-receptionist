import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/client.js";
import { verifyCalendlySignature } from "../lib/hmac.js";
import { logger } from "../lib/logger.js";
import { updateDocAppointmentStatus } from "../services/googleDocs.js";

/**
 * Calendly v2 webhook payload schema.
 *
 * Calendly has shifted field names across versions. Public sources have cited
 * all of `scheduled_event`, `calendar_event`, and `event` as the key holding
 * start_time. This schema accepts any of them and logs which path matched so
 * we can lock it down once we have a real captured payload in production.
 *
 * Capture a real payload in the first day of production and commit it to
 * tests/fixtures/calendly-invitee-created.json. Then tighten this schema to
 * just the one that matched.
 */
const eventDetailsSchema = z
  .object({
    uri: z.string(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
  })
  .passthrough();

// Invitee-level payload: all three nesting variants accepted.
// At least one of scheduled_event / calendar_event / event must be present
// with a uri. start_time is taken from whichever one has it.
const inviteeCreatedPayloadSchema = z
  .object({
    email: z.string().email(),
    uri: z.string(),
    scheduled_event: eventDetailsSchema.optional(),
    calendar_event: eventDetailsSchema.optional(),
    event: eventDetailsSchema.optional(),
  })
  .passthrough()
  .refine(
    (p) => Boolean(p.scheduled_event ?? p.calendar_event ?? p.event),
    { message: "payload must contain scheduled_event, calendar_event, or event" },
  );

const inviteeCanceledPayloadSchema = z
  .object({
    email: z.string().email().optional(),
    uri: z.string(),
    scheduled_event: eventDetailsSchema.optional(),
    calendar_event: eventDetailsSchema.optional(),
    event: eventDetailsSchema.optional(),
  })
  .passthrough()
  .refine(
    (p) => Boolean(p.scheduled_event ?? p.calendar_event ?? p.event),
    { message: "payload must contain scheduled_event, calendar_event, or event" },
  );

const inviteeCreatedSchema = z.object({
  event: z.literal("invitee.created"),
  payload: inviteeCreatedPayloadSchema,
});

const inviteeCanceledSchema = z.object({
  event: z.literal("invitee.canceled"),
  payload: inviteeCanceledPayloadSchema,
});

const webhookSchema = z.discriminatedUnion("event", [inviteeCreatedSchema, inviteeCanceledSchema]);

type EventDetails = z.infer<typeof eventDetailsSchema>;

function pickEventDetails(payload: {
  scheduled_event?: EventDetails;
  calendar_event?: EventDetails;
  event?: EventDetails;
}): { details: EventDetails; source: string } {
  if (payload.scheduled_event) return { details: payload.scheduled_event, source: "scheduled_event" };
  if (payload.calendar_event) return { details: payload.calendar_event, source: "calendar_event" };
  if (payload.event) return { details: payload.event, source: "event" };
  // refine() guarantees one exists; this is for TS.
  throw new Error("no event details in payload");
}

export async function calendlyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/calendly", { config: { skipAuth: true } }, async (request, reply) => {
    const valid = await verifyCalendlySignature(request).catch((err) => {
      logger.warn({ err: String(err) }, "calendly signature verification threw");
      return false;
    });
    if (!valid) {
      logger.warn("invalid calendly signature");
      return reply.status(401).send({ error: "invalid_signature" });
    }

    const parsed = webhookSchema.safeParse(request.body);
    if (!parsed.success) {
      // Log loudly — this is the historical failure mode. Do NOT silently 200.
      // Return 200 anyway (to stop Calendly retries) but make sure Shane/Billy see it.
      logger.error(
        {
          errors: parsed.error.flatten(),
          bodyKeys: request.body && typeof request.body === "object" ? Object.keys(request.body) : null,
          payloadKeys:
            request.body && typeof request.body === "object" && "payload" in request.body &&
            request.body.payload && typeof request.body.payload === "object"
              ? Object.keys(request.body.payload as Record<string, unknown>)
              : null,
        },
        "calendly webhook parse FAILED — schema drift likely. Capture the raw payload and update the schema.",
      );
      return reply.status(200).send({ ok: true, warning: "parse_failed" });
    }

    const data = parsed.data;

    if (data.event === "invitee.created") {
      const inviteeEmail = data.payload.email;
      const inviteeUri = data.payload.uri;
      const { details, source } = pickEventDetails(data.payload);
      const eventUri = details.uri;
      const startTime = details.start_time ?? "";

      logger.info({ source, eventUri }, "calendly invitee.created parsed");

      // Match to most recent unbooked call by email.
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

        if (matchedCall.doc_url && startTime) {
          await updateDocAppointmentStatus(matchedCall.doc_url, startTime).catch((err) => {
            logger.error({ err, call_id: matchedCall.id }, "failed to update doc appointment status");
          });
        }

        logger.info(
          { call_id: matchedCall.id, event: "invitee.created" },
          "calendly booking matched to call",
        );
      } else {
        // Parent booked without having called — create a standalone record.
        const inviteeId = inviteeUri.split("/").pop() ?? String(Date.now());
        await db.call.create({
          data: {
            vapi_call_id: `calendly-direct-${inviteeId}`,
            parent_email: inviteeEmail,
            booked_at: new Date(),
            follow_up_skipped: true,
            calendly_event_uri: eventUri,
          },
        });
        logger.info({ event: "invitee.created" }, "calendly booking created as standalone (no prior call)");
      }
    } else {
      // invitee.canceled
      const { details } = pickEventDetails(data.payload);
      const eventUri = details.uri;

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
      } else {
        logger.info({ eventUri }, "calendly cancel for unknown event_uri (no matching call)");
      }
    }

    return reply.status(200).send({ ok: true });
  });
}
