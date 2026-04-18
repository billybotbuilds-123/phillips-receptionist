import { describe, it, expect } from "vitest";
import { hasOptedOut } from "../../src/routes/twilio-inbound.js";

describe("hasOptedOut (P0.2 — TCPA compliance)", () => {
  // These MUST match. Each of these is either a carrier-standard opt-out
  // keyword or a soft opt-out phrase a real person might send. Missing any
  // of them means we'd keep SMS-ing a parent who asked us to stop, which
  // is a TCPA violation.
  const SHOULD_MATCH = [
    "STOP",
    "stop",
    "Stop",
    "StOp",
    "STOP PLEASE",
    "stop all",
    "STOP NOW",
    "unsubscribe",
    "Please unsubscribe me",
    "UNSUBSCRIBE",
    "cancel",
    "please cancel",
    "quit",
    "end",
    "opt out",
    "opt-out",
    "OPT OUT",
    "no thanks",
    "No thanks",
    "no thank you",
    "don't text me",
    "don't text",
    "dont text me",
    "don't contact me",
    "don't message me",
    "don't call me",
    "stop texting me",
    "stop texting",
    "stop messaging",
    "stop contacting me",
    "remove me",
    "remove my number",
  ];

  for (const text of SHOULD_MATCH) {
    it(`matches: "${text}"`, () => {
      expect(hasOptedOut(text)).toBe(true);
    });
  }

  // Things that should NOT be treated as opt-outs — ordinary replies from
  // parents. False positives here would make us silently drop legitimate
  // follow-up SMS.
  const SHOULD_NOT_MATCH = [
    "Thanks, looking forward to it",
    "Sounds good",
    "Great, see you Tuesday",
    "What time is the call?",
    "My son is in 5th grade",
    "",
    "ok",
    "yes",
    "Got it",
    // Note: the word "stop" appearing in ordinary text WILL match because
    // the regex uses \bstop\b. That's the safer default — a parent who
    // writes "please don't stop helping me" will get no more automated SMS,
    // which is an over-opt-out but not a legal violation.
  ];

  for (const text of SHOULD_NOT_MATCH) {
    it(`does NOT match: "${text}"`, () => {
      expect(hasOptedOut(text)).toBe(false);
    });
  }

  it("returns false for empty string", () => {
    expect(hasOptedOut("")).toBe(false);
  });
});
