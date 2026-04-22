#!/usr/bin/env tsx
/**
 * Seed settings from environment variables into the encrypted Settings table.
 * Run once after first deploy: npx tsx scripts/seed-settings.ts
 */
import { PrismaClient } from "@prisma/client";
import * as crypto from "crypto";

const db = new PrismaClient();

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getMasterKey(): Buffer {
  const key = process.env.SETTINGS_MASTER_KEY;
  if (!key || !/^[0-9a-f]{64}$/i.test(key)) {
    throw new Error("SETTINGS_MASTER_KEY must be a 64-char hex string (32 bytes)");
  }
  return Buffer.from(key, "hex");
}

function encrypt(plaintext: string): { encrypted_value: Buffer; iv: Buffer; auth_tag: Buffer } {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH } as any);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const auth_tag = (cipher as any).getAuthTag();
  return { encrypted_value: encrypted, iv, auth_tag };
}

async function upsert(key: string, value: string | undefined) {
  if (!value) {
    console.log(`  ⚠️  Skipping ${key} — no value`);
    return;
  }
  const { encrypted_value, iv, auth_tag } = encrypt(value);
  await db.setting.upsert({
    where: { key },
    update: { encrypted_value, iv, auth_tag, updated_by: "seed-script" },
    create: { key, encrypted_value, iv, auth_tag, updated_by: "seed-script" },
  });
  console.log(`  ✅ ${key}`);
}

async function main() {
  console.log("\n🌱 Seeding settings from environment variables...\n");

  const env = process.env;
  const vapiSecret = env.VAPI_WEBHOOK_SECRET || crypto.randomBytes(32).toString("hex");
  const vapiMcpSecret = env.VAPI_MCP_SECRET || crypto.randomBytes(32).toString("hex");

  await upsert("vapi_api_key", env.VAPI_API_KEY);
  await upsert("vapi_webhook_secret", vapiSecret);
  await upsert("vapi_mcp_secret", vapiMcpSecret);
  await upsert("twilio_account_sid", env.TWILIO_ACCOUNT_SID);
  await upsert("twilio_auth_token", env.TWILIO_AUTH_TOKEN);
  await upsert("twilio_phone_number", env.TWILIO_FROM_NUMBER || "+15622704221");
  await upsert("elevenlabs_api_key", env.ELEVENLABS_API_KEY);
  await upsert("elevenlabs_voice_id", env.ELEVENLABS_VOICE_ID || "");
  await upsert("calendly_api_token", env.CALENDLY_API_KEY);
  await upsert("calendly_event_type_uri", env.CALENDLY_EVENT_TYPE_URI);
  await upsert("calendly_webhook_signing_key", env.CALENDLY_WEBHOOK_SIGNING_KEY || "");
  await upsert("anthropic_api_key", env.ANTHROPIC_API_KEY);
  await upsert("shane_notification_email", env.SHANE_EMAIL || "educationalsuccessexpert@gmail.com");
  await upsert("shane_notification_phone", env.SHANE_PHONE || "");
  await upsert("timezone", "America/Los_Angeles");
  await upsert("consultation_fee_cents", "3000");
  await upsert("consultation_duration_minutes", "15");
  await upsert("google_sender_email", env.GOOGLE_SENDER_EMAIL || "educationalsuccessexpert@gmail.com");
  await upsert("google_oauth_client_id", env.GOOGLE_CLIENT_ID || "");
  await upsert("google_oauth_client_secret", env.GOOGLE_CLIENT_SECRET || "");
  await upsert("google_oauth_refresh_token", env.GOOGLE_REFRESH_TOKEN || "");
  await upsert("google_drive_notes_folder_id", env.GOOGLE_DRIVE_FOLDER_ID || "");
  await upsert("mr_phillips_bio", "Mr. Shane Phillips is a special education parent advocate based in Long Beach, California. He helps families navigate the IEP process and advocate for their children's educational rights.");
  await upsert("riley_system_prompt_override", "");
  await upsert("quiet_hours_start", "21");
  await upsert("quiet_hours_end", "8");
  await upsert("stripe_secret_key", env.STRIPE_SECRET_KEY || "");

  console.log("\n✅ Done seeding settings.\n");
  if (!env.VAPI_WEBHOOK_SECRET) console.log(`  ℹ️  Generated vapi_webhook_secret — update VAPI_WEBHOOK_SECRET in Railway if needed`);
  if (!env.VAPI_MCP_SECRET) console.log(`  ℹ️  Generated vapi_mcp_secret — update VAPI_MCP_SECRET in Railway if needed`);

  await db.$disconnect();
}

main().catch((e) => {
  console.error("❌ Seed failed:", e);
  process.exit(1);
});
