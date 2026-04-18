import { sendEmail } from "./gmail.js";
import { sendSms } from "./twilio.js";
import { settings } from "../lib/settings.js";
import { db } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { config } from "../lib/config.js";
import { sha256 } from "../lib/crypto.js";

const BACKOFF_SCHEDULE_MS = [
  1 * 60 * 1000,
  5 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
];

export async function enqueueFailedJob(
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.failedJob.create({
    data: {
      type,
      payload,
      attempts: 0,
      next_retry_at: new Date(Date.now() + (BACKOFF_SCHEDULE_MS[0] ?? 60_000)),
    },
  });
}

export function nextRetryAt(attempts: number): Date {
  const delayMs = BACKOFF_SCHEDULE_MS[attempts] ?? BACKOFF_SCHEDULE_MS.at(-1) ?? 60_000;
  return new Date(Date.now() + delayMs);
}

export async function sendUrgentEscalation(params: {
  reason: string;
  parentName?: string;
  parentPhone?: string;
  summary: string;
  callId?: string;
  vapiCallId?: string;
}): Promise<void> {
  const notifEmail = await settings.get("shane_notification_email");
  const notifPhone = await settings.get("shane_notification_phone");
  const dashUrl = params.callId
    ? `${config.PUBLIC_URL}/admin/calls/${params.callId}`
    : `${config.PUBLIC_URL}/admin`;

  const reasonLabels: Record<string, string> = {
    crisis_language: "Crisis Language",
    imminent_deadline: "Imminent Deadline",
    acute_distress: "Acute Distress",
    direct_callback_requested: "Callback Requested",
    booking_link_send_failed: "Booking Link Failed",
    hangup_imminent: "Hangup Imminent",
    incomplete_call: "Incomplete Call",
    other: "Other",
  };
  const reasonLabel = reasonLabels[params.reason] ?? params.reason;

  const summaryFirst120 = params.summary.slice(0, 120);

  // SMS to Shane (no opt-out check — internal notification)
  const smsBody = [
    `URGENT [${params.reason}]: ${params.parentName ?? "unknown"} ${params.parentPhone ?? "no number"}`,
    summaryFirst120,
    `Dashboard: ${dashUrl}`,
  ].join("\n");

  try {
    const smsResp = await sendSms({
      to: notifPhone,
      templateName: "urgent-to-shane",
      vars: {
        reason: params.reason,
        parent_name: params.parentName ?? "unknown",
        parent_phone: params.parentPhone ?? "no number",
        summary_first_120_chars: summaryFirst120,
        short_dashboard_url: dashUrl,
      },
      callId: params.callId,
    });
    await db.messageLog.create({
      data: {
        call_id: params.callId ?? null,
        channel: "sms",
        direction: "outbound",
        template: "urgent-to-shane",
        recipient: notifPhone,
        provider_id: smsResp.sid,
        status: "sent",
      },
    });
  } catch (err) {
    logger.error({ err }, "failed to send urgent escalation SMS");
  }

  // Email to Shane
  try {
    const emailResult = await sendEmail({
      to: notifEmail,
      subject: `URGENT — ${reasonLabel}`,
      templateName: "urgent-escalation",
      vars: {
        reason_label: reasonLabel,
        parent_name: params.parentName ?? "unknown",
        parent_phone: params.parentPhone ?? "no number",
        parent_email: "",
        summary: params.summary,
        call_dashboard_url: dashUrl,
        call_time_pt: new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }),
        duration_label: "",
        vapi_call_id: params.vapiCallId ?? "",
        summary_first_sentence: summaryFirst120,
      },
    });
    await db.messageLog.create({
      data: {
        call_id: params.callId ?? null,
        channel: "email",
        direction: "outbound",
        template: "urgent-escalation",
        recipient: notifEmail,
        provider_id: emailResult.messageId,
        status: "sent",
      },
    });
  } catch (err) {
    logger.error({ err }, "failed to send urgent escalation email");
  }
}

export function urgentEscalationKey(vapiCallId: string, reason: string): string {
  return sha256(`${vapiCallId}:${reason}`);
}

const sentEscalations = new Set<string>();

export function markEscalationSent(key: string): void {
  sentEscalations.add(key);
}

export function wasEscalationSent(key: string): boolean {
  return sentEscalations.has(key);
}
