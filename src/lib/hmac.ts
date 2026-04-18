import { verifyHmacSha256 } from "./crypto.js";
import { settings } from "./settings.js";
import type { FastifyRequest } from "fastify";

export async function verifyVapiSignature(request: FastifyRequest): Promise<boolean> {
  const sig = request.headers["x-vapi-signature"];
  if (!sig || typeof sig !== "string") return false;

  const secret = await settings.get("vapi_webhook_secret");
  const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
  if (!rawBody) return false;

  return verifyHmacSha256(secret, rawBody, sig);
}

export async function verifyCalendlySignature(request: FastifyRequest): Promise<boolean> {
  const sig = request.headers["calendly-webhook-signature"];
  if (!sig || typeof sig !== "string") return false;

  const secret = await settings.get("calendly_webhook_signing_key");
  const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
  if (!rawBody) return false;

  // Calendly uses "t=<timestamp>,v1=<hmac>" format
  const parts = sig.split(",");
  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Part = parts.find((p) => p.startsWith("v1="));
  if (!tPart || !v1Part) return false;

  const timestamp = tPart.slice(2);
  const expectedSig = v1Part.slice(3);
  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;

  return verifyHmacSha256(secret, signedPayload, expectedSig);
}
