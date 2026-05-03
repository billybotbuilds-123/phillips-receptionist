#!/usr/bin/env tsx
/**
 * One-time script: set ElevenLabs API key in the encrypted Settings table.
 * Run on Railway: npx tsx scripts/set-elevenlabs-key.ts
 *
 * Requires env vars: DATABASE_URL, SETTINGS_MASTER_KEY
 */
import { PrismaClient } from "@prisma/client";
import * as crypto from "crypto";

const db = new PrismaClient();

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_TO_SET = "elevenlabs_api_key";
const VALUE = process.env.ELEVENLABS_API_KEY ?? "sk_37f9167d4947cf0d423fad4e56d21d57161dcb6c149d7dd5";

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
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH } as Parameters<typeof crypto.createCipheriv>[3]);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const auth_tag = (cipher as crypto.CipherGCM).getAuthTag();
  return { encrypted_value: encrypted, iv, auth_tag };
}

async function main() {
  await db.$connect();
  const { encrypted_value, iv, auth_tag } = encrypt(VALUE);
  await db.setting.upsert({
    where: { key: KEY_TO_SET },
    update: { encrypted_value, iv, auth_tag, updated_by: "set-elevenlabs-script" },
    create: {
      key: KEY_TO_SET,
      encrypted_value,
      iv,
      auth_tag,
      updated_by: "set-elevenlabs-script",
    },
  });
  console.log(`✅ ${KEY_TO_SET} saved successfully`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
