/**
 * Vapi webhook routes.
 *
 * After the MCP migration, Riley's tool calls go through `/mcp` (see
 * src/routes/mcp.ts). This file only handles Vapi's end-of-call webhook,
 * which is a notification about what happened — not a tool invocation.
 */

import type { FastifyInstance } from "fastify";
import * as Sentry from "@sentry/node";
import { db } from "../db/client.js";
import { verifyVapiSignature } from "../lib/hmac.js";
import { logger } from "../lib/logger.js";
import { createCallDoc, appendTranscriptToDoc } from "../services/googleDocs.js";
import {
  enqueueFailedJob,
  sendUrgentEscalation,
  urgentEscalationKey,
  tryClaimEscalation,
} from "../services/notifications.js";

function defer(fn: () => Promise<void>): void {
  setImmediate(() => {
    fn().catch((err) => {
      logger.error({ err: String(err) }, "deferred vapi work failed");
      Sentry.captureException(err);
    });
  });
}

export async function vapiRoutes(app: FastifyInstance): Promise<void> {
  // All vapi/* routes verify HMAC signature. (MCP has its own Bearer auth.)
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/vapi/")) return;
    const valid = await verifyVapiSignature(request).catch(() => false);
    if (!valid) {
      logger.warn({ url: request.url }, "invalid vapi signature");
      return reply.status(401).send({ error: "invalid_signature" });
    }
  });

  // POST /vapi/call-ended — Vapi's end-of-call notification.
  app.post("/vapi/call-ended", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const callPayload =
      (body["call"] as Record<string, unknown> | undefined) ?? body;
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

    // Respond first, do bookkeeping async.
    reply.status(200).send({ ok: true });

    defer(async () => {
      const existing = await db.call.findUnique({
        where: { vapi_call_id: vapiCallId },
      });

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

      const autoFlag =
        endedReason === "customer-ended-call" && durationSeconds < 30;
      if (autoFlag) {
        await db.call.update({
          where: { id: call.id },
          data: { flagged: true, flag_note: "auto: short call / no tool call" },
        });
      }

      // If no row existed before this webhook, the call ended without Riley
      // ever invoking a tool.
      if (!existing) {
        await maybeEscalate(call.id, vapiCallId, {
          reason: "incomplete_call",
          summary: `Call ended (${endedReason}) after ${durationSeconds}s without capturing parent data.`,
        });
      }

      if (call.doc_url && transcript) {
        try {
          await appendTranscriptToDoc(call.doc_url, transcript);
        } catch (err) {
          logger.error(
            { err: String(err), call_id: call.id },
            "failed to append transcript to doc",
          );
          await enqueueFailedJob("google_doc_append", {
            call_id: call.id,
            doc_url: call.doc_url,
            transcript,
          });
        }
      }

      // If doc creation previously failed, retry once now.
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
          logger.error(
            { err: String(err), call_id: call.id },
            "retry doc creation at call-ended failed",
          );
        }
      }
    });
  });
}

async function maybeEscalate(
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
  const claimed = await tryClaimEscalation(escKey);
  if (!claimed) return;

  await db.call
    .update({
      where: { id: callId },
      data: { escalated: true, escalation_reason: args.reason },
    })
    .catch(() => null);

  await sendUrgentEscalation({
    reason: args.reason,
    parentName: args.parent_name,
    parentPhone: args.parent_phone,
    summary: args.summary,
    callId,
    vapiCallId,
  });
}
