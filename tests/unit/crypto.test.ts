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

describe("crypto", async () => {
  const { encrypt, decrypt, sha256, generateToken, verifyHmacSha256, computeHmacSha256 } =
    await import("../../src/lib/crypto.js");

  it("encrypts and decrypts a string", () => {
    const plaintext = "hello world";
    const enc = encrypt(plaintext);
    expect(decrypt(enc)).toBe(plaintext);
  });

  it("produces different IV each call (random IV)", () => {
    const enc1 = encrypt("same input");
    const enc2 = encrypt("same input");
    expect(enc1.iv.equals(enc2.iv)).toBe(false);
  });

  it("decrypts to same value regardless of unique IV", () => {
    const enc1 = encrypt("value");
    const enc2 = encrypt("value");
    expect(decrypt(enc1)).toBe("value");
    expect(decrypt(enc2)).toBe("value");
  });

  it("sha256 is deterministic", () => {
    expect(sha256("test")).toBe(sha256("test"));
    expect(sha256("test")).toHaveLength(64);
  });

  it("sha256 different inputs differ", () => {
    expect(sha256("a")).not.toBe(sha256("b"));
  });

  it("generateToken returns correct length hex", () => {
    const t = generateToken(32);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it("HMAC round-trips correctly", () => {
    const secret = "mysecret";
    const payload = "body";
    const hmac = computeHmacSha256(secret, payload);
    expect(verifyHmacSha256(secret, payload, hmac)).toBe(true);
  });

  it("HMAC rejects wrong secret", () => {
    const hmac = computeHmacSha256("correct", "payload");
    expect(verifyHmacSha256("wrong", "payload", hmac)).toBe(false);
  });

  it("HMAC rejects tampered payload", () => {
    const hmac = computeHmacSha256("secret", "original");
    expect(verifyHmacSha256("secret", "tampered", hmac)).toBe(false);
  });

  it("decrypt throws on tampered auth tag", () => {
    const enc = encrypt("original");
    const badTag = Buffer.alloc(enc.auth_tag.length, 0xff);
    expect(() => decrypt({ ...enc, auth_tag: badTag })).toThrow();
  });

  it("handles unicode strings", () => {
    const text = "¡Hola! 🎉 — special: café";
    expect(decrypt(encrypt(text))).toBe(text);
  });

  it("handles empty string", () => {
    expect(decrypt(encrypt(""))).toBe("");
  });
});
