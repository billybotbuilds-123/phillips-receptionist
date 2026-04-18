import { db } from "../db/client.js";
import { encrypt, decrypt, sha256 } from "./crypto.js";
import { logger } from "./logger.js";

export const SETTING_KEYS = [
  "anthropic_api_key",
  "vapi_api_key",
  "vapi_webhook_secret",
  "twilio_account_sid",
  "twilio_auth_token",
  "twilio_phone_number",
  "elevenlabs_api_key",
  "elevenlabs_voice_id",
  "calendly_api_token",
  "calendly_webhook_signing_key",
  "calendly_event_type_uri",
  "google_oauth_client_id",
  "google_oauth_client_secret",
  "google_oauth_refresh_token",
  "google_drive_notes_folder_id",
  "google_sender_email",
  "stripe_secret_key",
  "shane_notification_email",
  "shane_notification_phone",
  "timezone",
  "consultation_fee_cents",
  "consultation_duration_minutes",
  "mr_phillips_bio",
  "riley_system_prompt_override",
  "quiet_hours_start",
  "quiet_hours_end",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export class SettingMissingError extends Error {
  constructor(public readonly key: SettingKey) {
    super(`Setting '${key}' is not configured`);
    this.name = "SettingMissingError";
  }
}

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<SettingKey, CacheEntry>();

function invalidate(key?: SettingKey): void {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
}

async function get<K extends SettingKey>(key: K): Promise<string> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const row = await db.setting.findUnique({ where: { key } });
  if (!row) {
    throw new SettingMissingError(key);
  }

  const value = decrypt({
    encrypted_value: row.encrypted_value,
    iv: row.iv,
    auth_tag: row.auth_tag,
  });

  if (!value) {
    throw new SettingMissingError(key);
  }

  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

async function set(key: SettingKey, value: string, updatedBy: string, ip?: string): Promise<void> {
  let oldHash: string | null = null;
  try {
    const existing = await db.setting.findUnique({ where: { key } });
    if (existing) {
      const oldValue = decrypt({
        encrypted_value: existing.encrypted_value,
        iv: existing.iv,
        auth_tag: existing.auth_tag,
      });
      oldHash = sha256(oldValue);
    }
  } catch {
    // no previous value
  }

  const encrypted = encrypt(value);
  await db.setting.upsert({
    where: { key },
    create: {
      key,
      encrypted_value: encrypted.encrypted_value,
      iv: encrypted.iv,
      auth_tag: encrypted.auth_tag,
      updated_by: updatedBy,
    },
    update: {
      encrypted_value: encrypted.encrypted_value,
      iv: encrypted.iv,
      auth_tag: encrypted.auth_tag,
      updated_by: updatedBy,
    },
  });

  await db.settingsAuditLog.create({
    data: {
      setting_key: key,
      changed_by: updatedBy,
      ip: ip ?? null,
      old_hash: oldHash,
      new_hash: sha256(value),
    },
  });

  invalidate(key);
  logger.info({ setting_key: key, changed_by: updatedBy }, "setting updated");
}

async function getAll(): Promise<Record<string, string>> {
  const rows = await db.setting.findMany();
  const result: Record<string, string> = {};
  for (const row of rows) {
    try {
      result[row.key] = decrypt({
        encrypted_value: row.encrypted_value,
        iv: row.iv,
        auth_tag: row.auth_tag,
      });
    } catch (err) {
      logger.error({ setting_key: row.key, err }, "failed to decrypt setting");
    }
  }
  return result;
}

async function isPresent(key: SettingKey): Promise<boolean> {
  try {
    const value = await get(key);
    return value.length > 0;
  } catch {
    return false;
  }
}

async function getMasked(key: SettingKey): Promise<string> {
  try {
    const value = await get(key);
    if (value.length <= 4) return "••••";
    const last4 = value.slice(-4);
    const prefix = value.slice(0, Math.min(6, value.length - 4));
    return `${prefix}••••••••••••${last4}`;
  } catch {
    return "";
  }
}

async function getMissingRequired(): Promise<SettingKey[]> {
  const required: SettingKey[] = [
    "anthropic_api_key",
    "vapi_api_key",
    "vapi_webhook_secret",
    "twilio_account_sid",
    "twilio_auth_token",
    "twilio_phone_number",
    "elevenlabs_api_key",
    "elevenlabs_voice_id",
    "calendly_api_token",
    "calendly_webhook_signing_key",
    "calendly_event_type_uri",
    "google_oauth_client_id",
    "google_oauth_client_secret",
    "google_oauth_refresh_token",
    "google_drive_notes_folder_id",
    "google_sender_email",
    "shane_notification_email",
    "shane_notification_phone",
    "timezone",
    "consultation_fee_cents",
    "consultation_duration_minutes",
    "mr_phillips_bio",
  ];

  const missing: SettingKey[] = [];
  for (const key of required) {
    const present = await isPresent(key);
    if (!present) missing.push(key);
  }
  return missing;
}

export const settings = { get, set, getAll, isPresent, getMasked, getMissingRequired, invalidate };
