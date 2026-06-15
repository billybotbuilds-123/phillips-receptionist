import { google } from "googleapis";
import { settings } from "../lib/settings.js";
import { logger } from "../lib/logger.js";
import { renderTemplate } from "../lib/templates.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, "../templates/googleDoc/template.md");

function getTemplateContent(): string {
  try {
    return readFileSync(TEMPLATE_PATH, "utf8");
  } catch {
    return "";
  }
}

// Singleton OAuth client. Reuses cached access tokens across calls instead
// of forcing a fresh refresh on every single API invocation.
let cachedAuth: import("google-auth-library").OAuth2Client | null = null;
let cachedRefresh: string | null = null;
let cachedClientId: string | null = null;

async function getAuth() {
  const clientId = await settings.get("google_oauth_client_id");
  const clientSecret = await settings.get("google_oauth_client_secret");
  const refreshToken = await settings.get("google_oauth_refresh_token");

  if (
    !cachedAuth ||
    refreshToken !== cachedRefresh ||
    clientId !== cachedClientId
  ) {
    cachedAuth = new google.auth.OAuth2(clientId, clientSecret);
    cachedAuth.setCredentials({ refresh_token: refreshToken });
    cachedRefresh = refreshToken;
    cachedClientId = clientId;
  }
  return cachedAuth;
}

export interface CallDocData {
  parentName: string;
  parentEmail: string;
  parentPhone: string;
  childName: string;
  childGrade: string;
  summaryOfNeed: string;
  urgencyLevel: string;
  callDate: Date;
}

export async function createCallDoc(data: CallDocData): Promise<string> {
  const auth = await getAuth();
  const docs = google.docs({ version: "v1", auth });
  const drive = google.drive({ version: "v3", auth });

  const folderId = await settings.get("google_drive_notes_folder_id").catch(() => "");
  const dateStr = data.callDate.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const title = `Call with ${data.parentName} — ${dateStr} PT`;

  // CRITICAL: use shared renderTemplate which replaces ALL occurrences.
  // The template uses {{parent_name}} in both the title and the contact
  // section. Previous String#replace(string, ...) only replaced the first
  // occurrence, leaving literal "{{parent_name}}" in the body.
  const content = renderTemplate(getTemplateContent(), {
    parent_name: data.parentName,
    parent_email: data.parentEmail,
    parent_phone: data.parentPhone,
    child_name: data.childName,
    child_grade: data.childGrade,
    summary_of_need: data.summaryOfNeed,
    urgency_level: data.urgencyLevel,
    call_date: dateStr,
  });

  const createResp = await docs.documents.create({ requestBody: { title } });
  const docId = createResp.data.documentId;
  if (!docId) throw new Error("failed to create doc: no documentId");

  // Move to the configured folder (optional — skip if not configured).
  if (folderId) {
    const file = await drive.files.get({ fileId: docId, fields: "parents" });
    const prevParents = (file.data.parents ?? []).join(",");
    await drive.files.update({
      fileId: docId,
      addParents: folderId,
      removeParents: prevParents,
      requestBody: {},
      fields: "id, parents",
    });
  }

  if (content) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text: content,
            },
          },
        ],
      },
    });
  }

  const docUrl = `https://docs.google.com/document/d/${docId}/edit`;
  logger.info({ docId, title }, "google doc created");
  return docUrl;
}

export async function appendTranscriptToDoc(docUrl: string, transcript: string): Promise<void> {
  const docId = extractDocId(docUrl);
  if (!docId) {
    logger.warn({ docUrl }, "could not extract doc id from url");
    return;
  }

  const auth = await getAuth();
  const docs = google.docs({ version: "v1", auth });

  const doc = await docs.documents.get({ documentId: docId });
  const endIndex = doc.data.body?.content?.at(-1)?.endIndex ?? 1;

  const transcriptSection = `\n\n---\nFULL TRANSCRIPT\n\n${transcript}\n`;

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [
        {
          insertText: {
            location: { index: endIndex - 1 },
            text: transcriptSection,
          },
        },
      ],
    },
  });

  logger.info({ docId }, "transcript appended to google doc");
}

export async function updateDocAppointmentStatus(
  docUrl: string,
  appointmentTime: string,
  canceled = false,
): Promise<void> {
  const docId = extractDocId(docUrl);
  if (!docId) return;

  const auth = await getAuth();
  const docs = google.docs({ version: "v1", auth });
  const doc = await docs.documents.get({ documentId: docId });
  const endIndex = doc.data.body?.content?.at(-1)?.endIndex ?? 1;

  const statusText = canceled
    ? `\n\nAPPOINTMENT STATUS: CANCELED (was: ${appointmentTime})\n`
    : `\n\nAPPOINTMENT STATUS: BOOKED — ${appointmentTime}\n✓ Parent booked\n`;

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [
        {
          insertText: {
            location: { index: endIndex - 1 },
            text: statusText,
          },
        },
      ],
    },
  });
}

export async function refreshAccessToken(): Promise<{ expiresInSeconds: number; scopes: string }> {
  const auth = await getAuth();
  const { credentials } = await auth.refreshAccessToken();
  const expiresAt = credentials.expiry_date ?? Date.now() + 3600_000;
  const expiresInSeconds = Math.floor((expiresAt - Date.now()) / 1000);
  const scopes = credentials.scope ?? "";
  return { expiresInSeconds, scopes };
}

function extractDocId(url: string): string | null {
  const match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}
