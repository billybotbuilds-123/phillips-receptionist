import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/client.js";
import { verifyTwilioSignature } from "../lib/hmac.js";
import { logger } from "../lib/logger.js";
import { config } from "../lib/config.js";

/**
 * Opt-out patterns applied against inbound SMS body text.
 *
 * Note: Twilio also applies carrier-level STOP detection and will stop
 * delivering outbound SMS to numbers that replied STOP at the carrier layer.
 * This application-level check is a belt-and-suspenders guard so:
 *   (a) our follow-up cron skips the number instead of bouncing off Twilio,
 *   (b) the admin dashboard shows opt-out status correctly,
 *   (c) we catch softer opt-outs like "no thanks" that Twilio won't.
 */
export const OPT_OUT_PATTERNS: RegExp[] = [
  /\bstop\b/i,
  /\bstop\s*(all|please|now)\b/i,
  /\bunsubscribe\b/i,
  /\bcancel\b/i,
  /\bquit\b/i,
  /\bend\b/i,
  /\bopt.?out\b/i,
  /no\s+thanks?/i,
  /don'?t\s+(text|contact|message|call)/i,
  /stop\s+(texting|messaging|contacting)/i,
  /remove\s+(me|my\s+number)/i,
];

export function hasOptedOut(text: string): boolean {
  if (!text) return false;
  return OPT_OUT_PATTERNS.some((p) => p.test(text));
}

// Twilio sends form-encoded fields. These are the ones we use.
const twilioInboundBodySchema = z
  .object({
    From: z.string(),
    To: z.string().optional(),
    Body: z.string().default(""),
    MessageSid: z.string().optional(),
    AccountSid: z.string().optional(),
  })
  .passthrough();

export async function twilioInboundRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/webhooks/twilio/sms-inbound",
    { config: { skipAuth: true } },
    async (request, reply) => {
      // Twilio's signature is computed over the full public URL, not just the path.
      const publicUrl = `${config.PUBLIC_URL.replace(/\/$/, "")}/webhooks/twilio/sms-inbound`;
      const valid = await verifyTwilioSignature(request, publicUrl).catch(() => false);
      if (!valid) {
        logger.warn({ ip: request.ip }, "invalid twilio signature on sms-inbound");
        return reply
          .status(401)
          .header("Content-Type", "text/xml")
          .send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response/>");
      }

      const parsed = twilioInboundBodySchema.safeParse(request.body);
      if (!parsed.success) {
        logger.warn({ errors: parsed.error.flatten() }, "twilio sms-inbound body malformed");
        return reply
          .status(200)
          .header("Content-Type", "text/xml")
          .send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response/>");
      }

      const { From: from, Body: body, MessageSid: messageSid } = parsed.data;
      const optedOut = hasOptedOut(body);

      // Log every inbound SMS so we have a record and can audit opt-outs.
      await db.messageLog.create({
        data: {
          channel: "sms",
          direction: "inbound",
          template: optedOut ? "stop" : "inbound",
          recipient: from,
          provider_id: messageSid ?? null,
          status: "sent",
          error: body.slice(0, 500) || null, // store body preview for admin visibility
        },
      });

      if (optedOut) {
        logger.info({ from }, "sms opt-out received");
        // TwiML confirmation. Twilio also sends its own STOP confirmation for
        // exact-match carrier opt-outs; this one covers soft opt-outs too.
        const twiml = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          "<Response>",
          "  <Message>You've been unsubscribed from Mr. Phillips's office. You will not receive further messages. Reply START to resubscribe.</Message>",
          "</Response>",
        ].join("\n");
        return reply.status(200).header("Content-Type", "text/xml").send(twiml);
      }

      // Non-opt-out inbound: just ack. Shane will see it in the dashboard.
      logger.info({ from }, "sms inbound received (non-opt-out)");
      return reply
        .status(200)
        .header("Content-Type", "text/xml")
        .send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response/>");
    },
  );
}
