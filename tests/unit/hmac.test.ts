import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env["SETTINGS_MASTER_KEY"] = "a".repeat(64);
  process.env["SESSION_SECRET"] = "b".repeat(64);
  process.env["DATABASE_URL"] = "postgresql://localhost/test";
  process.env["NODE_ENV"] = "test";
  process.env["ADMIN_USERNAME"] = "admin";
  process.env["ADMIN_PASSWORD_HASH"] = "$2b$12$" + "x".repeat(53);
  process.env["PUBLIC_URL"] = "http://localhost:3000";
});

describe("HMAC helpers (via crypto)", async () => {
  const { computeHmacSha256, verifyHmacSha256 } = await import("../../src/lib/crypto.js");

  const secret = "test-webhook-secret-32chars-padded";

  it("computeHmacSha256 produces 64-char hex", () => {
    const sig = computeHmacSha256(secret, "payload");
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });

  it("computeHmacSha256 is deterministic", () => {
    expect(computeHmacSha256(secret, "p")).toBe(computeHmacSha256(secret, "p"));
  });

  it("computeHmacSha256 differs for different payloads", () => {
    expect(computeHmacSha256(secret, "a")).not.toBe(computeHmacSha256(secret, "b"));
  });

  it("verifyHmacSha256 accepts valid signature", () => {
    const sig = computeHmacSha256(secret, "body");
    expect(verifyHmacSha256(secret, "body", sig)).toBe(true);
  });

  it("verifyHmacSha256 rejects wrong secret", () => {
    const sig = computeHmacSha256(secret, "body");
    expect(verifyHmacSha256("wrong", "body", sig)).toBe(false);
  });

  it("verifyHmacSha256 rejects tampered payload", () => {
    const sig = computeHmacSha256(secret, "original");
    expect(verifyHmacSha256(secret, "tampered", sig)).toBe(false);
  });

  it("verifyHmacSha256 accepts sha256= prefix (Vapi format)", () => {
    const sig = computeHmacSha256(secret, "body");
    expect(verifyHmacSha256(secret, "body", `sha256=${sig}`)).toBe(true);
  });

  it("verifyHmacSha256 returns false for empty expected", () => {
    expect(verifyHmacSha256(secret, "body", "")).toBe(false);
  });

  it("Buffer and string payloads produce same result", () => {
    const str = "test payload";
    const buf = Buffer.from(str);
    expect(computeHmacSha256(secret, str)).toBe(computeHmacSha256(secret, buf));
  });
});
