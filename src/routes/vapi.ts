import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import { db } from "../db/client.js";
import { settings } from "../lib/settings.js";
import { verifyVapiSignature } from "../lib/hmac.js";
import { logger } from "../lib/logger.js";
import { createCallDoc, appendTranscriptToDoc } from "../services/googleDocs.js";
import { sendEmail } from "../services/gmail.js";
import { sendSms } from "../services/twilio.js";
import { enqueueFailedJob, sendUrgentEscalation, urgentEscalationKey, markEscalationSent, wasEscalationSent } from "../services/notifications.js";
import { config } from "../lib/config.js";

const sendBookingLinkSchema = z.object({
  call_id: z.string(),
  tool_call_id: z.string(),
  arguments: z.object({
    parent_name: z.string().min(1).max(120),
    parent_email: z.string().email(),
    parent_phone: z.string().regex(/^\+1\d{10}$/),
    child_name: z.string().min(1).max(80),
    child_grade: z.string().min(1).max(40),
    summary_of_need: z.string().min(10).max(2000),
    urgency_level: z.enum(["low", "medium", "high", "crisis"]),
  }),
});

const urgentEscalationSchema = z.object({
  call_id: z.string(),
  tool_call_id: z.string(),
  arguments: z.object({
    reason: z.enum([
      "crisis_language",
      "imminent_deadline",
      "acute_distress",
      "direct_callback_requested",
      "booking_link_send_failed",
      "hangup_imminent",
      "incomplete_call",
      "other",
    ]),
    parent_name: z.string().optional(),
    parent_phone: z.string().optional(),
    summary: z.string().min(1).max(1000),
  }),
});

// Standard Vapi tool response
function vapiToolResponse(toolCallId: string, result: string) {
  return {
    results: [{ toolCallId, result }],
  };
}

export async function vapiRoutes(app: FastifyInstance): Promise<void> {
  // All vapi routes verify HMAC signature
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/vapi/")) return;
    const valid = await verifyVapiSignature(request).catch(() => false);
    if (!valid) {
      logger.warn({ url: request.url }, "invalid vapi signature");
      return reply.status(401).send({ error: "invalid_signature" });
    }
  });

  // POST /vapi/tools/send-booking-link
  app.post("/vapi/tools/send-booking-link", async (request, reply) => {
    const parsed = sendBookingLinkSchema.safeParse(request.body);
    if (!parsed.success) {
      Sentry.captureMessage("send-booking-link validation error", {
        level: "warning",
        extra: { errors: parsed.error.flatten() },
      });
      return reply.status(400).send({ error: "validation_error", details: parsed.error.flatten() });
    }

    const { call_id, tool_call_id, arguments: args } = parsed.data;

    // Idempotency check
    const existingCall = await db.call.findUnique({ where: { vapi_call_id: call_id } });
    if (existingCall?.doc_url) {
      return reply.send(vapiToolResponse(tool_call_id, "sent"));
    }

    // Upsert Call row
    const call = await db.call.upsert({
      where: { vapi_call_id: call_id },
      create: {
        vapi_call_id: call_id,
        parent_name: args.parent_name,
        parent_email: args.parent_email,
        parent_phone: args.parent_phone,
        child_name: args.child_name,
        child_grade: args.child_grade,
        summary_of_need: args.summary_of_need,
        urgency_level: args.urgency_level,
        follow_up_due_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
      update: {
        parent_name: args.parent_name,
        parent_email: args.parent_email,
        parent_phone: args.parent_phone,
        child_name: args.child_name,
        child_grade: args.child_grade,
        summary_of_need: args.summary_of_need,
        urgency_level: args.urgency_level,
        follow_up_due_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const feeCents = parseInt(await settings.get("consultation_fee_cents").catch(() => "3000"));
    const feeDollars = (feeCents / 100).toFixed(2);
    const durationMinutes = await settings.get("consultation_duration_minutes").catch(() => "15");
    const calendlyUrl = await settings.get("calendly_event_type_uri").catch(() => "");

    const emailVars = {
      parent_name: args.parent_name,
      child_name: args.child_name,
      calendly_url: calendlyUrl,
      consultation_fee_dollars: feeDollars,
      consultation_duration_minutes: durationMinutes,
      privacy_url: `${config.PUBLIC_URL}/privacy`,
    };

    const smsVars = {
      parent_name: args.parent_name,
      consultation_fee_dollars: feeDollars,
      calendly_url: calendlyUrl,
    };

    // Run Google Doc creation + email + SMS in parallel
    const [docResult, emailResult, smsResult] = await Promise.allSettled([
      createCallDoc({
        parentName: args.parent_name,
        parentEmail: args.parent_email,
        parentPhone: args.parent_phone,
        childName: args.child_name,
        childGrade: args.child_grade,
        summaryOfNeed: args.summary_of_need,
        urgencyLevel: args.urgency_level,
        callDate: new Date(),
      }),
      sendEmail({
        to: args.parent_email,
        subject: "Here's your scheduling link for Mr. Phillips",
        templateName: "booking-link",
        vars: emailVars,
      }),
      sendSms({
        to: args.parent_phone,
        templateName: "booking-link",
        vars: smsVars,
        callId: call.id,
      }),
    ]);

    const updates: Record<string, unknown> = {};

    // Process Google Doc result
    if (docResult.status === "fulfilled") {
      updates["doc_url"] = docResult.value;
      updates["doc_creation_failed"] = false;
    } else {
      logger.error({ err: docResult.reason, call_id }, "google doc creation failed");
      updates["doc_creation_failed"] = true;
      await enqueueFailedJob("google_doc_create", {
        call_id: call.id,
        vapi_call_id: call_id,
        parent_name: args.parent_name,
        parent_email: args.parent_email,
        parent_phone: args.parent_phone,
        child_name: args.child_name,
        child_grade: args.child_grade,
        summary_of_need: args.summary_of_need,
        urgency_level: args.urgency_level,
      });
    }

    // Process email result
    if (emailResult.status === "fulfilled") {
      updates["booking_email_sent_at"] = new Date();
      await db.messageLog.create({
        data: {
          call_id: call.id,
          channel: "email",
          direction: "outbound",
          template: "booking-link",
          recipient: args.parent_email,
          provider_id: emailResult.value.messageId,
          status: "sent",
        },
      });
    } else {
      logger.error({ err: emailResult.reason, call_id }, "booking email failed");
      await db.messageLog.create({
        data: {
          call_id: call.id,
          channel: "email",
          direction: "outbound",
          template: "booking-link",
          recipient: args.parent_email,
          status: "failed",
          error: String(emailResult.reason),
        },
      });
    }

    // Process SMS result
    if (smsResult.status === "fulfilled" && smsResult.value.sid) {
      updates["booking_sms_sent_at"] = new Date();
      await db.messageLog.create({
        data: {
          call_id: call.id,
          channel: "sms",
          direction: "outbound",
          template: "booking-link",
          recipient: args.parent_phone,
          provider_id: smsResult.value.sid,
          status: "sent",
        },
      });
    } else if (smsResult.status === "rejected") {
      logger.error({ err: smsResult.reason, call_id }, "booking sms failed");
      await db.messageLog.create({
        data: {
          call_id: call.id,
          channel: "sms",
          direction: "outbound",
          template: "booking-link",
          recipient: args.parent_phone,
          status: "failed",
          error: String(smsResult.reason),
        },
      });
    }

    // Update call row
    await db.call.update({ where: { id: call.id }, data: updates });

    // If both email AND SMS failed — escalate
    const emailFailed = emailResult.status === "rejected";
    const smsFailed = smsResult.status === "rejected";
    if (emailFailed && smsFailed) {
      await handleUrgentEscalation(call.id, call_id, {
        reason: "booking_link_send_failed",
        parent_name: args.parent_name,
        parent_phone: args.parent_phone,
        summary: "Both email and SMS failed to deliver the booking link.",
      });
    }

    // Crisis handling
    if (args.urgency_level === "crisis") {
      await handleUrgentEscalation(call.id, call_id, {
        reason: "crisis_language",
        parent_name: args.parent_name,
        parent_phone: args.parent_phone,
        summary: args.summary_of_need.slice(0, 1000),
      });
    }

    return reply.send(vapiToolResponse(tool_call_id, "sent"));
  });

  // POST /vapi/tools/urgent-escalation
  app.post("/vapi/tools/urgent-escalation", async (request, reply) => {
    const parsed = urgentEscalationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "validation_error", details: parsed.error.flatten() });
    }

    const { call_id, tool_call_id, arguments: args } = parsed.data;

    // Idempotency
    const escKey = urgentEscalationKey(call_id, args.reason);
    if (wasEscalationSent(escKey)) {
      return reply.send(vapiToolResponse(tool_call_id, "escalated"));
    }
    markEscalationSent(escKey);

    const call = await db.call.upsert({
      where: { vapi_call_id: call_id },
      create: {
        vapi_call_id: call_id,
        escalated: true,
        escalation_reason: args.reason,
        parent_name: args.parent_name ?? null,
        parent_phone: args.parent_phone ?? null,
      },
      update: {
        escalated: true,
        escalation_reason: args.reason,
      },
    });

    Sentry.addBreadcrumb({
      message: "urgent_escalation",
      data: { reason: args.reason, call_id },
      level: "info",
    });

    await sendUrgentEscalation({
      reason: args.reason,
      parentName: args.parent_name,
      parentPhone: args.parent_phone,
      summary: args.summary,
      callId: call.id,
      vapiCallId: call_id,
    });

    return reply.send(vapiToolResponse(tool_call_id, "escalated"));
  });

  // POST /vapi/call-ended
  app.post("/vapi/call-ended", async (request, reply) => {
    const body = request.body as Record<string, unknown>;

    // Vapi call-ended payload structure
    const callPayload = (body["call"] as Record<string, unknown> | undefined) ?? body;
    const vapiCallId = String(callPayload["id"] ?? "");
    const endedReason = String(callPayload["endedReason"] ?? "");
    const durationSeconds = Number(callPayload["durationSeconds"] ?? 0);
    const transcript = String(body["transcript"] ?? "");
    const recordingUrl = String(body["recordingUrl"] ?? "");
    const endedAt = callPayload["endedAt"]
      ? new Date(String(callPayload["endedAt"]))
      : new Date();

    if (!vapiCallId) {
      logger.warn({ body }, "call-ended webhook missing call id");
      return reply.status(200).send({ ok: true });
    }

    const existing = await db.call.findUnique({ where: { vapi_call_id: vapiCallId } });

    const call = await db.call.upsert({
      where: { vapi_call_id: vapiCallId },
      create: {
        vapi_call_id: vapiCallId,
        ended_at: endedAt,
        duration_seconds: durationSeconds,
        raw_transcript: transcript || null,
        recording_url: recordingUrl || null,
      },
      update: {
        ended_at: endedAt,
        duration_seconds: durationSeconds,
        raw_transcript: transcript || null,
        recording_url: recordingUrl || null,
      },
    });

    // Auto-flag short calls
    const autoFlag =
      endedReason === "customer-ended-call" && durationSeconds < 30;
    if (autoFlag) {
      await db.call.update({
        where: { id: call.id },
        data: { flagged: true, flag_note: "auto: short call / no tool call" },
      });
    }

    // If no row existed — call ended without tool invocation
    if (!existing) {
      await handleUrgentEscalation(call.id, vapiCallId, {
        reason: "incomplete_call",
        summary: `Call ended (${endedReason}) after ${durationSeconds}s without capturing parent data.`,
      });
    }

    // Append transcript to Google Doc
    if (call.doc_url && transcript) {
      try {
        await appendTranscriptToDoc(call.doc_url, transcript);
      } catch (err) {
        logger.error({ err, call_id: call.id }, "failed to append transcript to doc");
        await enqueueFailedJob("google_doc_append", {
          call_id: call.id,
          doc_url: call.doc_url,
          transcript,
        });
      }
    }

    // If doc creation previously failed, retry now
    if (call.doc_creation_failed && !call.doc_url && call.parent_name) {
      try {
        const docUrl = await createCallDoc({
          parentName: call.parent_name,
          parentEmail: call.parent_email ?? "",
          parentPhone: call.parent_phone ?? "",
          childName: call.child_name ?? "",
          childGrade: call.child_grade ?? "",
          summaryOfNeed: call.summary_of_need ?? "",
          urgencyLevel: call.urgency_level ?? "medium",
          callDate: call.started_at,
        });
        await db.call.update({
          where: { id: call.id },
          data: { doc_url: docUrl, doc_creation_failed: false },
        });
        if (transcript) {
          await appendTranscriptToDoc(docUrl, transcript).catch(() => null);
        }
      } catch (err) {
        logger.error({ err, call_id: call.id }, "retry doc creation at call-ended failed");
      }
    }

    return reply.status(200).send({ ok: true });
  });
}

async function handleUrgentEscalation(
  callId: string,
  vapiCallId: string,
  args: {
    reason: string;
    parent_name?: string;
    parent_phone?: string;
    summary: string;
  },
): Promise<void> {
  const escKey = urgentEscalationKey(vapiCallId, args.reason);
  if (wasEscalationSent(escKey)) return;
  markEscalationSent(escKey);

  await db.call.update({
    where: { id: callId },
    data: { escalated: true, escalation_reason: args.reason },
  }).catch(() => null);

  await sendUrgentEscalation({
    reason: args.reason,
    parentName: args.parent_name,
    parentPhone: args.parent_phone,
    summary: args.summary,
    callId,
    vapiCallId,
  });
}
