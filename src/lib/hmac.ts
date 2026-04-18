import { verifyHmacSha256 } from "./crypto.js";
import { settings } from "./settings.js";
import { logger } from "./logger.js";
import type { FastifyRequest } from "fastify";

const CALENDLY_MAX_AGE_SECONDS = 5 * 60; // 5 minutes — standard webhook replay guard

export async function verifyVapiSignature(request: FastifyRequest): Promise<boolean> {
  const sig = request.headers["x-vapi-signature"];
  if (!sig || typeof sig !== "string") return false;

  const secret = await settings.get("vapi_webhook_secret");
  const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
  if (!rawBody) return false;

  return verifyHmacSha256(secret, rawBody, sig);
}

/**
 * Verify a Twilio-signed request. Twilio signs as
 *   HMAC-SHA1(authToken, url + sortedFormParams)
 * and sends it in X-Twilio-Signature as base64.
 *
 * For webhook POSTs with application/x-www-form-urlencoded bodies, url is the
 * public URL Twilio posted to, and sortedFormParams is the concatenation of
 * alphabetically-sorted form keys followed by their values with no separator.
 *
 * This uses twilio's validateRequest helper which implements that correctly.
 */
export async function verifyTwilioSignature(
  request: FastifyRequest,
  publicUrl: string,
): Promise<boolean> {
  const sig = request.headers["x-twilio-signature"];
  if (!sig || typeof sig !== "string") return false;

  const authToken = await settings.get("twilio_auth_token");
  const body = (request.body ?? {}) as Record<string, string>;

  const { default: twilio } = await import("twilio");
  try {
    return twilio.validateRequest(authToken, sig, publicUrl, body);
  } catch (err) {
    logger.warn({ err: String(err) }, "twilio signature validation threw");
    return false;
  }
}

export async function verifyCalendlySignature(request: FastifyRequest): Promise<boolean> {
  const sig = request.headers["calendly-webhook-signature"];
  if (!sig || typeof sig !== "string") return false;

  const secret = await settings.get("calendly_webhook_signing_key");
  const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
  if (!rawBody) return false;

  // Calendly uses "t=<timestamp>,v1=<hmac>" format.
  const parts = sig.split(",");
  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Part = parts.find((p) => p.startsWith("v1="));
  if (!tPart || !v1Part) return false;

  const timestamp = tPart.slice(2);
  const expectedSig = v1Part.slice(3);

  // Replay-attack guard: reject signatures whose timestamp is too old or in
  // the future. Calendly's timestamps are Unix seconds.
  const tsSeconds = Number(timestamp);
  if (!Number.isFinite(tsSeconds)) {
    logger.warn({ timestamp }, "calendly signature timestamp not a number");
    return false;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const age = nowSeconds - tsSeconds;
  if (age > CALENDLY_MAX_AGE_SECONDS || age < -CALENDLY_MAX_AGE_SECONDS) {
    logger.warn({ age, timestamp }, "calendly signature timestamp out of freshness window");
    return false;
  }

  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
  return verifyHmacSha256(secret, signedPayload, expectedSig);
}
