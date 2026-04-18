import twilio from "twilio";
import { settings } from "../lib/settings.js";
import { db } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSmsTemplate(name: string): string {
  const path = join(__dirname, `../templates/sms/${name}.txt`);
  if (!existsSync(path)) throw new Error(`SMS template not found: ${name}`);
  return readFileSync(path, "utf8");
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

// Lazy-initialized client cached per (sid, token) pair.
let cachedClient: ReturnType<typeof twilio> | null = null;
let cachedSid: string | null = null;
let cachedToken: string | null = null;

async function getClient() {
  const accountSid = await settings.get("twilio_account_sid");
  const authToken = await settings.get("twilio_auth_token");
  if (!cachedClient || accountSid !== cachedSid || authToken !== cachedToken) {
    cachedClient = twilio(accountSid, authToken);
    cachedSid = accountSid;
    cachedToken = authToken;
  }
  return cachedClient;
}

/**
 * A number is opted-out if we have ANY inbound message from it flagged as
 * an opt-out. The inbound SMS webhook writes MessageLog rows with
 * template = "stop" when the body matches opt-out patterns.
 */
export async function isOptedOut(phone: string): Promise<boolean> {
  const stopMsg = await db.messageLog.findFirst({
    where: {
      recipient: phone,
      direction: "inbound",
      template: "stop",
    },
    orderBy: { sent_at: "desc" },
  });
  return stopMsg !== null;
}

export interface SendSmsResult {
  sid: string | null;
}

export async function sendSms(params: {
  to: string;
  templateName: string;
  vars: Record<string, string>;
  callId?: string;
}): Promise<SendSmsResult> {
  const optedOut = await isOptedOut(params.to);
  if (optedOut) {
    logger.info({ template: params.templateName }, "sms suppressed: recipient opted out");
    await db.messageLog.create({
      data: {
        call_id: params.callId ?? null,
        channel: "sms",
        direction: "outbound",
        template: params.templateName,
        recipient: params.to,
        status: "blocked_opt_out",
      },
    });
    return { sid: null };
  }

  const from = await settings.get("twilio_phone_number");
  const client = await getClient();
  const body = renderTemplate(loadSmsTemplate(params.templateName), params.vars);

  const start = Date.now();
  const msg = await client.messages.create({ from, to: params.to, body });
  logger.info(
    { template: params.templateName, latencyMs: Date.now() - start },
    "sms sent",
  );

  return { sid: msg.sid };
}

export async function getAccountInfo(): Promise<{ status: string; balance: string }> {
  const accountSid = await settings.get("twilio_account_sid");
  const client = await getClient();
  const account = await client.api.accounts(accountSid).fetch();
  const balance = await client.balance.fetch();
  return { status: account.status, balance: balance.balance };
}

export async function getA2pStatus(): Promise<string> {
  try {
    const client = await getClient();
    const services = await client.messaging.v1.services.list({ limit: 10 });
    if (services.length === 0) return "not_registered";
    const firstService = services[0];
    if (!firstService) return "not_registered";
    return "approved"; // simplified; full A2P check needs brand registry API
  } catch {
    return "unknown";
  }
}
