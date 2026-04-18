import { describe, it, expect, vi, beforeAll } from "vitest";
import { computeHmacSha256 } from "../../src/lib/crypto.js";

beforeAll(() => {
  process.env["SETTINGS_MASTER_KEY"] = "a".repeat(64);
  process.env["SESSION_SECRET"] = "b".repeat(64);
  process.env["DATABASE_URL"] = "postgresql://localhost/test";
  process.env["NODE_ENV"] = "test";
  process.env["ADMIN_USERNAME"] = "admin";
  process.env["ADMIN_PASSWORD_HASH"] = "$2b$12$" + "x".repeat(53);
  process.env["PUBLIC_URL"] = "http://localhost:3000";
});

describe("Calendly webhook signature format", async () => {
  it("builds a valid Calendly HMAC header", () => {
    const secret = "test-calendly-signing-key";
    const body = JSON.stringify({ event: "invitee.created", payload: {} });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signedPayload = `${timestamp}.${body}`;
    const hmac = computeHmacSha256(secret, signedPayload);
    const header = `t=${timestamp},v1=${hmac}`;

    expect(header).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
  });

  it("invitee.created payload schema is recognized", async () => {
    const { z } = await import("zod");
    const schema = z.object({
      event: z.literal("invitee.created"),
      payload: z.object({
        email: z.string().email(),
        event: z.object({ start_time: z.string(), uri: z.string() }),
        uri: z.string(),
      }),
    });

    const payload = {
      event: "invitee.created",
      payload: {
        email: "parent@example.com",
        event: { start_time: "2026-04-20T10:00:00Z", uri: "https://api.calendly.com/scheduled_events/abc" },
        uri: "https://api.calendly.com/scheduled_events/abc/invitees/xyz",
      },
    };

    expect(schema.safeParse(payload).success).toBe(true);
  });

  it("invitee.canceled payload schema is recognized", async () => {
    const { z } = await import("zod");
    const schema = z.object({
      event: z.literal("invitee.canceled"),
      payload: z.object({
        email: z.string().email(),
        event: z.object({ uri: z.string() }),
        uri: z.string(),
      }),
    });

    const payload = {
      event: "invitee.canceled",
      payload: {
        email: "parent@example.com",
        event: { uri: "https://api.calendly.com/scheduled_events/abc" },
        uri: "https://api.calendly.com/scheduled_events/abc/invitees/xyz",
      },
    };

    expect(schema.safeParse(payload).success).toBe(true);
  });

  it("unknown event type is rejected by discriminated union", async () => {
    const { z } = await import("zod");
    const schema = z.discriminatedUnion("event", [
      z.object({ event: z.literal("invitee.created"), payload: z.object({ email: z.string() }) }),
      z.object({ event: z.literal("invitee.canceled"), payload: z.object({ email: z.string() }) }),
    ]);

    const result = schema.safeParse({ event: "invitee.rescheduled", payload: { email: "x@y.com" } });
    expect(result.success).toBe(false);
  });
});
