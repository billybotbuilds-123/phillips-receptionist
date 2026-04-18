import { google } from "googleapis";
import { settings } from "../lib/settings.js";
import { logger } from "../lib/logger.js";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadHtmlTemplate(name: string): string {
  const htmlPath = join(__dirname, `../templates/emails/${name}.html`);
  if (existsSync(htmlPath)) {
    return readFileSync(htmlPath, "utf8");
  }
  // fallback: try .mjml if somehow HTML wasn't compiled
  const mjmlPath = join(__dirname, `../templates/emails/${name}.mjml`);
  if (existsSync(mjmlPath)) {
    return readFileSync(mjmlPath, "utf8");
  }
  throw new Error(`Email template not found: ${name}`);
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

async function getGmailClient() {
  const clientId = await settings.get("google_oauth_client_id");
  const clientSecret = await settings.get("google_oauth_client_secret");
  const refreshToken = await settings.get("google_oauth_refresh_token");

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: "v1", auth });
}

function buildRfc822Message(params: {
  from: string;
  to: string;
  subject: string;
  html: string;
}): string {
  const boundary = `boundary_${Date.now()}`;
  const message = [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    params.html,
    "",
    `--${boundary}--`,
  ].join("\r\n");
  return Buffer.from(message).toString("base64url");
}

export interface SendEmailResult {
  messageId: string | null;
}

export async function sendEmail(params: {
  to: string;
  subject: string;
  templateName: string;
  vars: Record<string, string>;
}): Promise<SendEmailResult> {
  const from = await settings.get("google_sender_email");
  const gmail = await getGmailClient();

  const html = renderTemplate(loadHtmlTemplate(params.templateName), params.vars);

  const raw = buildRfc822Message({
    from: `Riley at Mr. Phillips's Office <${from}>`,
    to: params.to,
    subject: params.subject,
    html,
  });

  const start = Date.now();
  const resp = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  logger.info({ to: "[REDACTED]", templateName: params.templateName, latencyMs: Date.now() - start }, "email sent");

  return { messageId: resp.data.id ?? null };
}
