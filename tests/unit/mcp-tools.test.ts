import { describe, it, expect } from "vitest";
import { z } from "zod";

// This is a lightweight smoke test that doesn't actually call the MCP SDK
// (which would require mocking the entire transport and Prisma). Instead,
// we re-declare the schemas and verify they accept/reject inputs correctly.
// A real end-to-end test should be run manually with MCP Inspector:
//
//   npm run mcp:inspector
//   # or:
//   npx @modelcontextprotocol/inspector http://localhost:3000/mcp
//
// with the Bearer token set to the value of vapi_mcp_secret.

const sendBookingLinkSchema = z.object({
  parent_name: z.string().min(1).max(120),
  parent_email: z.string().email(),
  parent_phone: z.string().regex(/^\+1\d{10}$/),
  child_name: z.string().min(1).max(80),
  child_grade: z.string().min(1).max(40),
  summary_of_need: z.string().min(10).max(2000),
  urgency_level: z.enum(["low", "medium", "high", "crisis"]),
});

const urgentEscalationSchema = z.object({
  reason: z.enum([
    "crisis_language",
    "imminent_deadline",
    "acute_distress",
    "direct_callback_requested",
    "booking_link_send_failed",
    "hangup_imminent",
    "incomplete_call",
    "other",
  ]),
  parent_name: z.string().optional(),
  parent_phone: z.string().optional(),
  summary: z.string().min(1).max(1000),
});

describe("MCP tool input schemas", () => {
  it("accepts a valid send_booking_link call", () => {
    const r = sendBookingLinkSchema.safeParse({
      parent_name: "Maria Garcia",
      parent_email: "maria@example.com",
      parent_phone: "+15621234567",
      child_name: "Diego",
      child_grade: "3rd grade",
      summary_of_need:
        "Diego is in 3rd grade with autism. The district sent a letter proposing placement change; Maria wants help responding before Friday.",
      urgency_level: "high",
    });
    expect(r.success).toBe(true);
  });

  it("rejects non-E.164 phone numbers", () => {
    const r = sendBookingLinkSchema.safeParse({
      parent_name: "X",
      parent_email: "x@example.com",
      parent_phone: "562-123-4567",
      child_name: "Y",
      child_grade: "3rd",
      summary_of_need: "long enough summary here",
      urgency_level: "low",
    });
    expect(r.success).toBe(false);
  });

  it("rejects summary that's too short", () => {
    const r = sendBookingLinkSchema.safeParse({
      parent_name: "X",
      parent_email: "x@example.com",
      parent_phone: "+15621234567",
      child_name: "Y",
      child_grade: "3rd",
      summary_of_need: "short",
      urgency_level: "low",
    });
    expect(r.success).toBe(false);
  });

  it("rejects invalid urgency_level", () => {
    const r = sendBookingLinkSchema.safeParse({
      parent_name: "X",
      parent_email: "x@example.com",
      parent_phone: "+15621234567",
      child_name: "Y",
      child_grade: "3rd",
      summary_of_need: "long enough summary here",
      urgency_level: "URGENT", // wrong casing, wrong value
    });
    expect(r.success).toBe(false);
  });

  it("accepts minimal urgent_escalation", () => {
    const r = urgentEscalationSchema.safeParse({
      reason: "crisis_language",
      summary: "Child expressed suicidal ideation today.",
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown escalation reason", () => {
    const r = urgentEscalationSchema.safeParse({
      reason: "some_new_reason",
      summary: "x",
    });
    expect(r.success).toBe(false);
  });
});
