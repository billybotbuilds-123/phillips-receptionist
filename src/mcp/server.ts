/**
 * MCP server for Riley's tools.
 *
 * Exposes `send_booking_link` and `urgent_escalation` to any MCP-compatible
 * client: Vapi (production), Claude Desktop (testing), MCP Inspector
 * (debugging).
 *
 * Design notes:
 *   * Stateless transport — each tool invocation is a new MCP session, which
 *     matches how Vapi opens a fresh connection per tool call.
 *   * Auth — Bearer token stored in the encrypted settings table under
 *     `vapi_mcp_secret`. Vapi sends it via the Authorization header
 *     configured on the MCP tool.
 *   * Call correlation — Vapi sends `X-Call-Id` on each invocation. We read
 *     it from the HTTP request and pass it down into the tool handler so
 *     side effects (Call upsert, idempotency dedup) attribute correctly.
 *   * Side effects — tool handlers return the MCP result synchronously but
 *     kick bookkeeping to setImmediate so we stay under Vapi's 5s budget.
 *     Same async-post-send pattern as the old Vapi webhook routes.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import { db } from "../db/client.js";
import { settings } from "../lib/settings.js";
import { logger } from "../lib/logger.js";
import { config } from "../lib/config.js";
import { createCallDoc } from "../services/googleDocs.js";
import { sendEmail } from "../services/gmail.js";
import { sendSms } from "../services/twilio.js";
import {
  enqueueFailedJob,
  sendUrgentEscalation,
  urgentEscalationKey,
  tryClaimEscalation,
} from "../services/notifications.js";

/**
 * Scheduled fire-and-forget work. The MCP tool returns its result
 * immediately; post-send bookkeeping happens here.
 */
function defer(fn: () => Promise<void>): void {
  setImmediate(() => {
    fn().catch((err) => {
      logger.error({ err: String(err) }, "deferred MCP tool work failed");
      Sentry.captureException(err);
    });
  });
}

interface CallContext {
  /** Vapi call id from X-Call-Id header. Fallback to a synthetic id. */
  callId: string;
}

/**
 * Build and return the MCP server with Riley's two tools registered.
 * A fresh server is created per request to keep the transport stateless.
 */
export function buildRileyMcpServer(ctx: CallContext): McpServer {
  const server = new McpServer({
    name: "phillips-receptionist",
    version: "2.0.0",
  });

  server.registerTool(
    "send_booking_link",
    {
      title: "Send booking link",
      description:
        "Send Mr. Phillips's Calendly link by email and SMS to the parent, and create a call-notes Google Doc. Call this once per conversation after you have gathered the parent's name, email, phone, child name, child grade, a brief summary of what's going on, and assessed urgency.",
      inputSchema: {
        parent_name: z.string().min(1).max(120)
          .describe("Full name of the parent or guardian you spoke with. Example: 'Maria Garcia'"),
        parent_email: z
          .string()
          .max(200)
          .describe("Parent's email address exactly as they stated it, or an empty string if they declined to provide one. Join spoken letters into a valid email. Example: 'maria.garcia@gmail.com'")
          .refine(
            (v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
            "must be a valid email address or an empty string",
          ),
        parent_phone: z
          .string()
          .describe("Parent's 10-digit US phone number, e.g. '5621234567'. This MUST be a real numeric phone number — join the spoken digits into a 10-digit number. NEVER pass 'caller_id', 'unknown', or any non-numeric placeholder text. If you do not have the parent's number, ask them for it before calling this tool. Example: '5623015061' or '+15623015061'")
          .transform((v) => {
            // Normalize to E.164: strip all non-digits, then prepend +1
            const digits = v.replace(/\D/g, "");
            if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
            if (digits.length === 10) return `+1${digits}`;
            return v; // pass through if unexpected length; regex below will catch it
          })
          .refine((v) => /^\+1\d{10}$/.test(v), "must be a 10-digit US phone number"),
        child_name: z.string().min(1).max(80)
          .describe("First name of the parent's child. Example: 'Josh'"),
        child_grade: z.string().min(1).max(40)
          .describe("Grade level of the child. Example: '7th grade' or 'Kindergarten'"),
        summary_of_need: z.string().min(10).max(2000)
          .describe("A 2-4 sentence summary of the parent's situation and what they need help with. Include the key IEP issues, services in dispute, and what outcome they are seeking."),
        urgency_level: z.enum(["low", "medium", "high", "crisis"])
          .describe("Urgency: 'low' = general inquiry, 'medium' = ongoing issue, 'high' = deadline within 2 weeks or services actively denied, 'crisis' = child safety or meeting within 48 hours"),
      },
    },
    async (args) => {
      const callId = ctx.callId;

      // Idempotency — if we already did this, return cached result.
      const existing = await db.call.findUnique({ where: { vapi_call_id: callId } });
      if (existing?.doc_url && existing.booking_email_sent_at) {
        return { content: [{ type: "text", text: "sent" }] };
      }

      // Synchronous: upsert the Call row so we have call.id for deferred work.
      const call = await db.call.upsert({
        where: { vapi_call_id: callId },
        create: {
          vapi_call_id: callId,
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

      defer(async () => {
        const feeCents = parseInt(
          (await settings.get("consultation_fee_cents").catch(() => "3000")) || "3000",
        );
        const feeDollars = (feeCents / 100).toFixed(2);
        const durationMinutes =
          (await settings.get("consultation_duration_minutes").catch(() => "15")) || "15";
        const calendlyUrl =
          (await settings.get("calendly_event_type_uri").catch(() => "")) || "";

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

        // Only attempt the email if the parent actually gave us an address.
        // If they declined, args.parent_email is "" — sending to an empty
        // recipient would fail and (previously) trip the escalation logic.
        const emailEnabled = Boolean(args.parent_email);

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
          emailEnabled
            ? sendEmail({
                to: args.parent_email,
                subject: "Here's your scheduling link for Mr. Phillips",
                templateName: "booking-link",
                vars: emailVars,
              })
            : Promise.resolve(null),
          sendSms({
            to: args.parent_phone,
            templateName: "booking-link",
            vars: smsVars,
            callId: call.id,
          }),
        ]);

        const updates: Record<string, unknown> = {};

        if (docResult.status === "fulfilled") {
          updates["doc_url"] = docResult.value;
          updates["doc_creation_failed"] = false;
        } else {
          logger.error(
            { err: String(docResult.reason), call_id: callId },
            "google doc creation failed",
          );
          updates["doc_creation_failed"] = true;
          await enqueueFailedJob("google_doc_create", {
            call_id: call.id,
            vapi_call_id: callId,
            parent_name: args.parent_name,
            parent_email: args.parent_email,
            parent_phone: args.parent_phone,
            child_name: args.child_name,
            child_grade: args.child_grade,
            summary_of_need: args.summary_of_need,
            urgency_level: args.urgency_level,
          });
        }

        if (!emailEnabled) {
          // Parent declined to give an email — nothing to send or log.
          logger.info({ call_id: callId }, "booking email skipped (no email provided)");
        } else if (emailResult.status === "fulfilled" && emailResult.value) {
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
          logger.error(
            {
              err:
                emailResult.status === "rejected"
                  ? String(emailResult.reason)
                  : "unknown",
              call_id: callId,
            },
            "booking email failed",
          );
          await db.messageLog.create({
            data: {
              call_id: call.id,
              channel: "email",
              direction: "outbound",
              template: "booking-link",
              recipient: args.parent_email,
              status: "failed",
              error:
                emailResult.status === "rejected"
                  ? String(emailResult.reason).slice(0, 500)
                  : null,
            },
          });
        }

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
          logger.error(
            { err: String(smsResult.reason), call_id: callId },
            "booking sms failed",
          );
          await db.messageLog.create({
            data: {
              call_id: call.id,
              channel: "sms",
              direction: "outbound",
              template: "booking-link",
              recipient: args.parent_phone,
              status: "failed",
              error: String(smsResult.reason).slice(0, 500),
            },
          });
        }

        if (Object.keys(updates).length > 0) {
          await db.call.update({ where: { id: call.id }, data: updates });
        }

        // Escalate only if the booking link reached the parent on NO channel.
        // A skipped email (parent declined) doesn't count as a failure — but
        // if it was skipped AND the SMS failed, nothing got through.
        const emailDelivered =
          emailEnabled &&
          emailResult.status === "fulfilled" &&
          Boolean(emailResult.value);
        const smsDelivered =
          smsResult.status === "fulfilled" && Boolean(smsResult.value.sid);
        if (!emailDelivered && !smsDelivered) {
          await maybeEscalate(call.id, callId, {
            reason: "booking_link_send_failed",
            parent_name: args.parent_name,
            parent_phone: args.parent_phone,
            summary: "Both email and SMS failed to deliver the booking link.",
          });
        }

        if (args.urgency_level === "crisis") {
          await maybeEscalate(call.id, callId, {
            reason: "crisis_language",
            parent_name: args.parent_name,
            parent_phone: args.parent_phone,
            summary: args.summary_of_need.slice(0, 1000),
          });
        }
      });

      return { content: [{ type: "text", text: "sent" }] };
    },
  );

  server.registerTool(
    "urgent_escalation",
    {
      title: "Urgent escalation",
      description:
        "Alert Mr. Phillips immediately by SMS and email. Call this only when (1) the parent describes a child-safety crisis, (2) there's a procedural deadline within 48 hours, (3) the parent explicitly asks for Mr. Phillips to call back today, or (4) the parent sounds like they'll hang up before you can capture their info.",
      inputSchema: {
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
      },
    },
    async (args) => {
      const callId = ctx.callId;

      // Postgres-backed idempotency.
      const escKey = urgentEscalationKey(callId, args.reason);
      const claimed = await tryClaimEscalation(escKey);
      if (!claimed) {
        return { content: [{ type: "text", text: "escalated" }] };
      }

      defer(async () => {
        const call = await db.call.upsert({
          where: { vapi_call_id: callId },
          create: {
            vapi_call_id: callId,
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
          data: { reason: args.reason, call_id: callId },
          level: "info",
        });

        await sendUrgentEscalation({
          reason: args.reason,
          parentName: args.parent_name,
          parentPhone: args.parent_phone,
          summary: args.summary,
          callId: call.id,
          vapiCallId: callId,
        });
      });

      return { content: [{ type: "text", text: "escalated" }] };
    },
  );

  return server;
}

/**
 * Build a fresh stateless Streamable HTTP transport. Stateless mode means
 * no session tracking — each request stands alone, which matches Vapi's
 * "new MCP session per tool call" pattern.
 */
export function buildTransport(): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // undefined => stateless
    enableJsonResponse: true,
  });
}

// Internal helper mirroring the old vapi.ts handleUrgentEscalation, but
// callable from MCP tool bodies.
async function maybeEscalate(
  callDbId: string,
  vapiCallId: string,
  args: {
    reason: string;
    parent_name?: string;
    parent_phone?: string;
    summary: string;
  },
): Promise<void> {
  const escKey = urgentEscalationKey(vapiCallId, args.reason);
  const claimed = await tryClaimEscalation(escKey);
  if (!claimed) return;

  await db.call
    .update({
      where: { id: callDbId },
      data: { escalated: true, escalation_reason: args.reason },
    })
    .catch(() => null);

  await sendUrgentEscalation({
    reason: args.reason,
    parentName: args.parent_name,
    parentPhone: args.parent_phone,
    summary: args.summary,
    callId: callDbId,
    vapiCallId,
  });
}
