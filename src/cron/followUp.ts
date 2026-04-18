import { db } from "../db/client.js";
import { settings } from "../lib/settings.js";
import { sendEmail } from "../services/gmail.js";
import { sendSms, isOptedOut } from "../services/twilio.js";
import { logger } from "../lib/logger.js";

function isInQuietHours(start: string, end: string, tz: string): boolean {
  if (!start || !end) return false;

  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const timeStr = formatter.format(now); // "HH:MM"

  const [nowH = 0, nowM = 0] = timeStr.split(":").map(Number);
  const [startH = 0, startM = 0] = start.split(":").map(Number);
  const [endH = 0, endM = 0] = end.split(":").map(Number);

  const nowMins = nowH * 60 + nowM;
  const startMins = startH * 60 + startM;
  const endMins = endH * 60 + endM;

  if (startMins <= endMins) {
    return nowMins >= startMins && nowMins < endMins;
  } else {
    // Overnight quiet window
    return nowMins >= startMins || nowMins < endMins;
  }
}

export async function processFollowUps(): Promise<void> {
  const now = new Date();

  const pending = await db.call.findMany({
    where: {
      follow_up_due_at: { lt: now },
      booked_at: null,
      follow_up_sent_at: null,
      follow_up_skipped: false,
      canceled_at: null,
    },
    orderBy: { follow_up_due_at: "asc" },
    take: 50,
  });

  if (pending.length === 0) return;

  const tz = await settings.get("timezone").catch(() => "America/Los_Angeles");
  const quietStart = await settings.isPresent("quiet_hours_start")
    ? await settings.get("quiet_hours_start")
    : "";
  const quietEnd = await settings.isPresent("quiet_hours_end")
    ? await settings.get("quiet_hours_end")
    : "";

  const inQuiet = isInQuietHours(quietStart, quietEnd, tz);
  if (inQuiet) {
    logger.info({ count: pending.length }, "follow-up processor skipping: quiet hours");
    return;
  }

  const feeCents = parseInt(await settings.get("consultation_fee_cents").catch(() => "3000"));
  const feeDollars = (feeCents / 100).toFixed(2);
  const calendlyUrl = await settings.get("calendly_event_type_uri").catch(() => "");

  logger.info({ count: pending.length }, "processing follow-ups");

  for (const call of pending) {
    const vars = {
      parent_name: call.parent_name ?? "there",
      calendly_url: calendlyUrl,
      consultation_fee_dollars: feeDollars,
    };

    const emailResult = call.parent_email
      ? await sendEmail({
          to: call.parent_email,
          subject: "Just checking in — here's the scheduling link again",
          templateName: "follow-up-24h",
          vars,
        }).catch((err) => {
          logger.error({ err, call_id: call.id }, "follow-up email failed");
          return null;
        })
      : null;

    const smsResult =
      call.parent_phone && !(await isOptedOut(call.parent_phone))
        ? await sendSms({
            to: call.parent_phone,
            templateName: "follow-up-24h",
            vars,
            callId: call.id,
          }).catch((err) => {
            logger.error({ err, call_id: call.id }, "follow-up sms failed");
            return null;
          })
        : null;

    await db.call.update({
      where: { id: call.id },
      data: { follow_up_sent_at: new Date() },
    });

    if (emailResult !== null && call.parent_email) {
      await db.messageLog.create({
        data: {
          call_id: call.id,
          channel: "email",
          direction: "outbound",
          template: "follow-up-24h",
          recipient: call.parent_email,
          provider_id: emailResult.messageId,
          status: "sent",
        },
      });
    }

    if (smsResult?.sid && call.parent_phone) {
      await db.messageLog.create({
        data: {
          call_id: call.id,
          channel: "sms",
          direction: "outbound",
          template: "follow-up-24h",
          recipient: call.parent_phone,
          provider_id: smsResult.sid,
          status: "sent",
        },
      });
    }

    logger.info({ call_id: call.id }, "follow-up sent");
  }
}
