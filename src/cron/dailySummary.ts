import { db } from "../db/client.js";
import { settings } from "../lib/settings.js";
import { sendEmail } from "../services/gmail.js";
import { logger } from "../lib/logger.js";
import { config } from "../lib/config.js";

export async function sendDailySummary(): Promise<void> {
  const tz = await settings.get("timezone").catch(() => "America/Los_Angeles");

  // Yesterday in the configured timezone
  const now = new Date();
  const yesterdayStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now.getTime() - 24 * 60 * 60 * 1000));

  const dayStart = new Date(`${yesterdayStr}T00:00:00`);
  const dayEnd = new Date(`${yesterdayStr}T23:59:59`);

  const [calls, bookings, escalations, followupsSent] = await Promise.all([
    db.call.findMany({
      where: { started_at: { gte: dayStart, lte: dayEnd } },
      select: {
        id: true,
        parent_name: true,
        child_grade: true,
        urgency_level: true,
        booked_at: true,
        escalated: true,
        doc_url: true,
        duration_seconds: true,
      },
    }),
    db.call.count({ where: { booked_at: { gte: dayStart, lte: dayEnd } } }),
    db.call.count({ where: { escalated: true, started_at: { gte: dayStart, lte: dayEnd } } }),
    db.call.count({ where: { follow_up_sent_at: { gte: dayStart, lte: dayEnd } } }),
  ]);

  const linksSent = await db.messageLog.count({
    where: {
      template: "booking-link",
      direction: "outbound",
      sent_at: { gte: dayStart, lte: dayEnd },
    },
  });

  const feeCents = parseInt(await settings.get("consultation_fee_cents").catch(() => "3000"));
  const feeDollars = (feeCents / 100).toFixed(2);
  const revenueDollars = ((bookings * feeCents) / 100).toFixed(2);

  const callsListBlock = calls
    .map((c) => {
      const name = c.parent_name ?? "Unknown";
      const grade = c.child_grade ?? "?";
      const urgency = c.urgency_level ?? "?";
      const docLink = c.doc_url ? `<a href="${c.doc_url}">Doc</a>` : "No doc";
      return `• ${name} (Grade ${grade}) — ${urgency} urgency — ${docLink}`;
    })
    .join("\n");

  const reportDatePt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(dayStart));

  const notifEmail = await settings.get("shane_notification_email");

  await sendEmail({
    to: notifEmail,
    subject: `Daily summary — ${reportDatePt}`,
    templateName: "daily-summary",
    vars: {
      report_date_pt: reportDatePt,
      call_count: String(calls.length),
      link_sent_count: String(linksSent),
      booking_count: String(bookings),
      followup_count: String(followupsSent),
      escalation_count: String(escalations),
      revenue_dollars: revenueDollars,
      consultation_fee_dollars: feeDollars,
      calls_list_block: callsListBlock || "No calls yesterday.",
      dashboard_url: `${config.PUBLIC_URL}/admin`,
    },
  });

  logger.info({ date: yesterdayStr, calls: calls.length, bookings }, "daily summary sent");
}
