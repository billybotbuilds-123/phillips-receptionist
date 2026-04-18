import { describe, it, expect } from "vitest";
import { z } from "zod";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Reproduce the schema from src/routes/calendly.ts so we can exercise it
// directly without spinning up Fastify.
const eventDetailsSchema = z
  .object({
    uri: z.string(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
  })
  .passthrough();

const inviteeCreatedPayloadSchema = z
  .object({
    email: z.string().email(),
    uri: z.string(),
    scheduled_event: eventDetailsSchema.optional(),
    calendar_event: eventDetailsSchema.optional(),
    event: eventDetailsSchema.optional(),
  })
  .passthrough()
  .refine(
    (p) => Boolean(p.scheduled_event ?? p.calendar_event ?? p.event),
    { message: "payload must contain scheduled_event, calendar_event, or event" },
  );

const inviteeCreatedSchema = z.object({
  event: z.literal("invitee.created"),
  payload: inviteeCreatedPayloadSchema,
});

describe("Calendly webhook schema (P0.1 regression)", () => {
  // Regression test: Billy's schema looked for payload.event.start_time,
  // but the real v2 payload nests under scheduled_event. Previously every
  // real Calendly booking silently failed parsing.
  it("parses the captured real v2 invitee.created payload", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(__dirname, "../fixtures/calendly-invitee-created.json"),
        "utf8",
      ),
    );
    const result = inviteeCreatedSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      // Confirm we can pull start_time from scheduled_event.
      expect(result.data.payload.scheduled_event?.start_time).toBe(
        "2026-04-25T17:00:00.000000Z",
      );
      // Confirm we have the invitee email for matching against Call rows.
      expect(result.data.payload.email).toBe("parent@example.com");
    }
  });

  it("also accepts legacy calendar_event nesting", () => {
    const legacy = {
      event: "invitee.created",
      payload: {
        email: "parent@example.com",
        uri: "https://api.calendly.com/invitees/X",
        calendar_event: {
          uri: "https://api.calendly.com/scheduled_events/X",
          start_time: "2026-04-25T17:00:00Z",
        },
      },
    };
    const result = inviteeCreatedSchema.safeParse(legacy);
    expect(result.success).toBe(true);
  });

  it("also accepts bare event nesting (old schema)", () => {
    const old = {
      event: "invitee.created",
      payload: {
        email: "parent@example.com",
        uri: "https://api.calendly.com/invitees/X",
        event: {
          uri: "https://api.calendly.com/scheduled_events/X",
          start_time: "2026-04-25T17:00:00Z",
        },
      },
    };
    const result = inviteeCreatedSchema.safeParse(old);
    expect(result.success).toBe(true);
  });

  it("REJECTS a payload with none of the event-detail keys", () => {
    const bad = {
      event: "invitee.created",
      payload: {
        email: "parent@example.com",
        uri: "https://api.calendly.com/invitees/X",
        // no scheduled_event / calendar_event / event
      },
    };
    const result = inviteeCreatedSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects a payload with a bad email", () => {
    const bad = {
      event: "invitee.created",
      payload: {
        email: "not-an-email",
        uri: "https://api.calendly.com/invitees/X",
        scheduled_event: { uri: "x", start_time: "2026-04-25T17:00:00Z" },
      },
    };
    const result = inviteeCreatedSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
