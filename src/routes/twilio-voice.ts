/**
 * Twilio voice inbound route.
 *
 * Sits in front of Vapi to add a natural ring delay before Riley answers.
 * Twilio is configured to POST to /webhooks/twilio/voice-inbound on each call.
 * This handler:
 *   1. Verifies the Twilio signature (security).
 *   2. Returns TwiML that pauses briefly (simulating a human picking up after
 *      a ring or two), then redirects the call to Vapi's inbound webhook.
 *
 * Ring delay: 6 seconds ≈ 2 US ring cycles (one ring ≈ 2–3 seconds on + 4
 * seconds silence = ~6 seconds per full ring cycle). Adjust RING_PAUSE_SECONDS
 * to taste.
 */

import type { FastifyInstance } from "fastify";
import { verifyTwilioSignature } from "../lib/hmac.js";
import { logger } from "../lib/logger.js";
import { config } from "../lib/config.js";

/** Vapi's public inbound webhook for Twilio calls. */
const VAPI_INBOUND_URL = "https://api.vapi.ai/twilio/inbound_call";

/** Seconds of silence before Riley picks up. 6s ≈ 2 ring cycles. */
const RING_PAUSE_SECONDS = 6;

export async function twilioVoiceRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/webhooks/twilio/voice-inbound",
    { config: { skipAuth: true } },
    async (request, reply) => {
      // Verify this request came from Twilio.
      const publicUrl = `${config.PUBLIC_URL.replace(/\/$/, "")}/webhooks/twilio/voice-inbound`;
      const valid = await verifyTwilioSignature(request, publicUrl).catch(() => false);
      if (!valid) {
        logger.warn({ ip: request.ip }, "invalid twilio signature on voice-inbound");
        // Return empty TwiML — Twilio will hear silence and hang up.
        return reply
          .status(401)
          .header("Content-Type", "text/xml")
          .send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
      }

      // TwiML: pause (ring simulation), then redirect to Vapi.
      const twiml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<Response>",
        `  <Pause length="${RING_PAUSE_SECONDS}"/>`,
        `  <Redirect method="POST">${VAPI_INBOUND_URL}</Redirect>`,
        "</Response>",
      ].join("\n");

      logger.info({ ip: request.ip }, "voice-inbound: ring delay applied, redirecting to Vapi");

      return reply
        .status(200)
        .header("Content-Type", "text/xml")
        .send(twiml);
    },
  );
}
