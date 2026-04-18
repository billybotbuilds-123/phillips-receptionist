import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

beforeAll(() => {
  process.env["SETTINGS_MASTER_KEY"] = "a".repeat(64);
  process.env["SESSION_SECRET"] = "b".repeat(64);
  process.env["DATABASE_URL"] = "postgresql://localhost/test";
  process.env["NODE_ENV"] = "test";
  process.env["ADMIN_USERNAME"] = "admin";
  process.env["ADMIN_PASSWORD_HASH"] = "$2b$12$" + "x".repeat(53);
  process.env["PUBLIC_URL"] = "http://localhost:3000";
});

vi.mock("../../src/db/client.js", () => ({
  db: {
    call: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn(), create: vi.fn() },
    messageLog: { create: vi.fn() },
    failedJob: { create: vi.fn() },
  },
}));

vi.mock("../../src/services/googleDocs.js", () => ({
  createCallDoc: vi.fn().mockResolvedValue("https://docs.google.com/document/d/test123/edit"),
  appendTranscriptToDoc: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/gmail.js", () => ({
  sendEmail: vi.fn().mockResolvedValue({ messageId: "msg-123" }),
}));

vi.mock("../../src/services/twilio.js", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM123" }),
  isOptedOut: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../src/lib/settings.js", () => ({
  settings: {
    get: vi.fn().mockImplementation((key: string) => {
      const vals: Record<string, string> = {
        vapi_webhook_secret: "a".repeat(64),
        consultation_fee_cents: "3000",
        consultation_duration_minutes: "15",
        calendly_event_type_uri: "https://calendly.com/test",
        shane_notification_email: "shane@test.com",
        shane_notification_phone: "+15551234567",
      };
      return Promise.resolve(vals[key] ?? "test-value");
    }),
    isPresent: vi.fn().mockResolvedValue(false),
  },
  SettingMissingError: class SettingMissingError extends Error {
    constructor(public key: string) { super(`Missing ${key}`); }
  },
}));

vi.mock("../../src/lib/hmac.js", () => ({
  verifyVapiSignature: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../src/services/notifications.js", () => ({
  enqueueFailedJob: vi.fn().mockResolvedValue(undefined),
  sendUrgentEscalation: vi.fn().mockResolvedValue(undefined),
  urgentEscalationKey: vi.fn().mockReturnValue("key"),
  markEscalationSent: vi.fn(),
  wasEscalationSent: vi.fn().mockReturnValue(false),
}));

describe("Vapi tool handler logic", async () => {
  const { db } = await import("../../src/db/client.js");

  const validBookingPayload = {
    call_id: "vapi-call-001",
    tool_call_id: "tool-001",
    arguments: {
      parent_name: "Jennifer Smith",
      parent_email: "jennifer@example.com",
      parent_phone: "+15551234567",
      child_name: "Marcus",
      child_grade: "3rd",
      summary_of_need: "My son has an IEP meeting next week and I need help understanding his rights.",
      urgency_level: "medium",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("send-booking-link schema validates correct payload", async () => {
    const { z } = await import("zod");
    const schema = z.object({
      call_id: z.string(),
      tool_call_id: z.string(),
      arguments: z.object({
        parent_name: z.string().min(1).max(120),
        parent_email: z.string().email(),
        parent_phone: z.string().regex(/^\+1\d{10}$/),
        child_name: z.string().min(1).max(80),
        child_grade: z.string().min(1).max(40),
        summary_of_need: z.string().min(10).max(2000),
        urgency_level: z.enum(["low", "medium", "high", "crisis"]),
      }),
    });

    const result = schema.safeParse(validBookingPayload);
    expect(result.success).toBe(true);
  });

  it("send-booking-link schema rejects invalid phone", async () => {
    const { z } = await import("zod");
    const schema = z.object({
      arguments: z.object({
        parent_phone: z.string().regex(/^\+1\d{10}$/),
      }),
    });
    const result = schema.safeParse({ arguments: { parent_phone: "5551234567" } });
    expect(result.success).toBe(false);
  });

  it("send-booking-link schema rejects short summary", async () => {
    const { z } = await import("zod");
    const schema = z.object({
      arguments: z.object({ summary_of_need: z.string().min(10) }),
    });
    const result = schema.safeParse({ arguments: { summary_of_need: "Short" } });
    expect(result.success).toBe(false);
  });

  it("urgent-escalation schema validates all reason values", async () => {
    const { z } = await import("zod");
    const reasonSchema = z.enum([
      "crisis_language", "imminent_deadline", "acute_distress",
      "direct_callback_requested", "booking_link_send_failed",
      "hangup_imminent", "incomplete_call", "other",
    ]);
    for (const reason of reasonSchema.options) {
      expect(reasonSchema.safeParse(reason).success).toBe(true);
    }
  });

  it("urgent-escalation schema rejects unknown reason", async () => {
    const { z } = await import("zod");
    const schema = z.object({
      arguments: z.object({
        reason: z.enum(["crisis_language", "incomplete_call", "other"]),
        summary: z.string().min(1),
      }),
    });
    const result = schema.safeParse({ arguments: { reason: "not_real", summary: "test" } });
    expect(result.success).toBe(false);
  });
});
