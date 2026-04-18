import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";
import { config } from "./config.js";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getMasterKey(): Buffer {
  return Buffer.from(config.SETTINGS_MASTER_KEY, "hex");
}

export interface EncryptedValue {
  encrypted_value: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
}

export function encrypt(plaintext: string): EncryptedValue {
  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const auth_tag = cipher.getAuthTag();
  return { encrypted_value: encrypted, iv, auth_tag };
}

export function decrypt(data: EncryptedValue): string {
  const key = getMasterKey();
  const decipher = createDecipheriv(ALGORITHM, key, data.iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(data.auth_tag);
  const decrypted = Buffer.concat([
    decipher.update(data.encrypted_value),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export function generateHexKey(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

// Verify HMAC-SHA256 in constant time
import { timingSafeEqual, createHmac } from "crypto";

export function computeHmacSha256(secret: string, payload: Buffer | string): string {
  return createHmac("sha256", secret)
    .update(typeof payload === "string" ? Buffer.from(payload) : payload)
    .digest("hex");
}

export function verifyHmacSha256(
  secret: string,
  payload: Buffer | string,
  expected: string,
): boolean {
  const computed = computeHmacSha256(secret, payload);
  const computedBuf = Buffer.from(computed, "hex");
  const expectedBuf = Buffer.from(expected.replace(/^sha256=/, ""), "hex");
  if (computedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(computedBuf, expectedBuf);
}
