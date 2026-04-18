import { google } from "googleapis";
import { settings } from "../lib/settings.js";
import { logger } from "../lib/logger.js";
import { renderTemplate, htmlToPlainText } from "../lib/templates.js";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadHtmlTemplate(name: string): string {
  const htmlPath = join(__dirname, `../templates/emails/${name}.html`);
  if (existsSync(htmlPath)) {
    return readFileSync(htmlPath, "utf8");
  }
  const mjmlPath = join(__dirname, `../templates/emails/${name}.mjml`);
  if (existsSync(mjmlPath)) {
    return readFileSync(mjmlPath, "utf8");
  }
  throw new Error(`Email template not found: ${name}`);
}

function loadPlainTemplate(name: string): string | null {
  const txtPath = join(__dirname, `../templates/emails/${name}.txt`);
  if (existsSync(txtPath)) {
    return readFileSync(txtPath, "utf8");
  }
  return null;
}

// Singleton OAuth client to avoid recreating on every send.
let cachedGmail: ReturnType<typeof google.gmail> | null = null;
let cachedRefresh: string | null = null;
let cachedClientId: string | null = null;

async function getGmailClient() {
  const clientId = await settings.get("google_oauth_client_id");
  const clientSecret = await settings.get("google_oauth_client_secret");
  const refreshToken = await settings.get("google_oauth_refresh_token");

  if (
    !cachedGmail ||
    refreshToken !== cachedRefresh ||
    clientId !== cachedClientId
  ) {
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    cachedGmail = google.gmail({ version: "v1", auth });
    cachedRefresh = refreshToken;
    cachedClientId = clientId;
  }
  return cachedGmail;
}

/**
 * Build an RFC822 multipart/alternative message with BOTH text/plain and
 * text/html parts. multipart/alternative with only one part violates the
 * MIME spec and hurts deliverability (DMARC, spam filters).
 *
 * Base64-encoding the entire message in base64url is required by the Gmail
 * API (users.messages.send raw parameter).
 */
function buildRfc822Message(params: {
  from: string;
  to: string;
  subject: string;
  html: string;
  plainText: string;
}): string {
  const boundary = `b_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const message = [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    params.plainText,
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

  // Prefer an explicit .txt template if one was committed; otherwise derive
  // a plaintext version from the HTML.
  const plainTemplate = loadPlainTemplate(params.templateName);
  const plainText = plainTemplate
    ? renderTemplate(plainTemplate, params.vars)
    : htmlToPlainText(html);

  const raw = buildRfc822Message({
    from: `Riley at Mr. Phillips's Office <${from}>`,
    to: params.to,
    subject: params.subject,
    html,
    plainText,
  });

  const start = Date.now();
  const resp = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  logger.info(
    { templateName: params.templateName, latencyMs: Date.now() - start },
    "email sent",
  );

  return { messageId: resp.data.id ?? null };
}
