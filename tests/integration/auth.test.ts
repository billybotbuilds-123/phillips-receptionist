import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import bcrypt from "bcrypt";

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
    loginAttempt: { count: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    session: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    user: { count: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
  },
}));

describe("auth helpers", async () => {
  const { db } = await import("../../src/db/client.js");
  const { hashPassword, verifyPassword, isRateLimited, recordLoginAttempt } =
    await import("../../src/lib/auth.js");

  beforeEach(() => { vi.clearAllMocks(); });

  it("hashPassword produces a bcrypt hash", async () => {
    const hash = await hashPassword("mysecretpassword");
    expect(hash).toMatch(/^\$2b\$12\$/);
  });

  it("verifyPassword succeeds with correct password", async () => {
    const hash = await bcrypt.hash("correct", 4); // use cost 4 for speed in tests
    expect(await verifyPassword("correct", hash)).toBe(true);
  });

  it("verifyPassword fails with wrong password", async () => {
    const hash = await bcrypt.hash("correct", 4);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("isRateLimited returns not limited when < 5 attempts", async () => {
    vi.mocked(db.loginAttempt.count).mockResolvedValue(3);
    const result = await isRateLimited("1.2.3.4");
    expect(result.limited).toBe(false);
  });

  it("isRateLimited returns limited when >= 5 attempts", async () => {
    vi.mocked(db.loginAttempt.count).mockResolvedValue(5);
    vi.mocked(db.loginAttempt.findFirst).mockResolvedValue({
      id: "1",
      user_id: null,
      username_tried: "admin",
      ip: "1.2.3.4",
      success: false,
      created_at: new Date(Date.now() - 5 * 60 * 1000),
    });
    const result = await isRateLimited("1.2.3.4");
    expect(result.limited).toBe(true);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("recordLoginAttempt creates a LoginAttempt row", async () => {
    vi.mocked(db.loginAttempt.create).mockResolvedValue({} as never);
    await recordLoginAttempt("admin", "1.2.3.4", false);
    expect(db.loginAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          username_tried: "admin",
          ip: "1.2.3.4",
          success: false,
        }),
      }),
    );
  });
});
