import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

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
    setting: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
    settingsAuditLog: {
      create: vi.fn(),
    },
    personaVersion: {
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

describe("settings module", async () => {
  const { db } = await import("../../src/db/client.js");
  const { encrypt } = await import("../../src/lib/crypto.js");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("SETTING_KEYS contains required keys", async () => {
    const { SETTING_KEYS } = await import("../../src/lib/settings.js");
    expect(SETTING_KEYS).toContain("anthropic_api_key");
    expect(SETTING_KEYS).toContain("vapi_webhook_secret");
    expect(SETTING_KEYS).toContain("riley_system_prompt_override");
  });

  it("SettingMissingError carries the key", async () => {
    const { SettingMissingError } = await import("../../src/lib/settings.js");
    const err = new SettingMissingError("twilio_phone_number");
    expect(err.key).toBe("twilio_phone_number");
    expect(err.name).toBe("SettingMissingError");
    expect(err).toBeInstanceOf(Error);
  });

  it("settings.get throws SettingMissingError for missing key", async () => {
    vi.mocked(db.setting.findUnique).mockResolvedValue(null);
    const { settings, SettingMissingError } = await import("../../src/lib/settings.js");
    settings.invalidate();
    await expect(settings.get("anthropic_api_key")).rejects.toBeInstanceOf(SettingMissingError);
  });

  it("settings.get decrypts and returns value", async () => {
    const value = "sk-ant-test-secret";
    const enc = encrypt(value);
    vi.mocked(db.setting.findUnique).mockResolvedValue({
      key: "anthropic_api_key",
      encrypted_value: enc.encrypted_value,
      iv: enc.iv,
      auth_tag: enc.auth_tag,
      updated_at: new Date(),
      updated_by: "test",
    });
    const { settings } = await import("../../src/lib/settings.js");
    settings.invalidate("anthropic_api_key");
    const result = await settings.get("anthropic_api_key");
    expect(result).toBe(value);
  });

  it("settings.isPresent returns false for missing key", async () => {
    vi.mocked(db.setting.findUnique).mockResolvedValue(null);
    const { settings } = await import("../../src/lib/settings.js");
    settings.invalidate("stripe_secret_key");
    const present = await settings.isPresent("stripe_secret_key");
    expect(present).toBe(false);
  });
});
