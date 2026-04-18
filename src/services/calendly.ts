import { settings } from "../lib/settings.js";
import { logger } from "../lib/logger.js";

const CALENDLY_BASE = "https://api.calendly.com";

async function getHeaders() {
  const token = await settings.get("calendly_api_token");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export interface CalendlyUser {
  name: string;
  email: string;
  scheduling_url: string;
  current_organization: string;
}

export async function getCurrentUser(): Promise<CalendlyUser> {
  const resp = await fetch(`${CALENDLY_BASE}/users/me`, { headers: await getHeaders() });
  if (!resp.ok) throw new Error(`Calendly /users/me failed: ${resp.status}`);
  const data = (await resp.json()) as { resource: CalendlyUser };
  return data.resource;
}

export interface CalendlyEventType {
  uri: string;
  name: string;
  active: boolean;
  scheduling_url: string;
}

export async function listEventTypes(): Promise<CalendlyEventType[]> {
  const user = await getCurrentUser();
  const orgUri = user.current_organization;
  const userUri = `${CALENDLY_BASE}/users/me`;

  const resp = await fetch(
    `${CALENDLY_BASE}/event_types?organization=${encodeURIComponent(orgUri)}&user=${encodeURIComponent(userUri)}`,
    { headers: await getHeaders() },
  );
  if (!resp.ok) throw new Error(`Calendly /event_types failed: ${resp.status}`);
  const data = (await resp.json()) as { collection: CalendlyEventType[] };
  return data.collection;
}

export async function registerWebhook(callbackUrl: string): Promise<void> {
  const user = await getCurrentUser();
  const orgUri = user.current_organization;

  const resp = await fetch(`${CALENDLY_BASE}/webhook_subscriptions`, {
    method: "POST",
    headers: await getHeaders(),
    body: JSON.stringify({
      url: callbackUrl,
      events: ["invitee.created", "invitee.canceled"],
      organization: orgUri,
      scope: "organization",
      signing_key: await settings.get("calendly_webhook_signing_key"),
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Calendly webhook registration failed: ${resp.status} ${text}`);
  }
  logger.info({ callbackUrl }, "calendly webhook registered");
}

export async function verifyWebhookRegistered(callbackUrl: string): Promise<boolean> {
  const user = await getCurrentUser();
  const orgUri = user.current_organization;

  const resp = await fetch(
    `${CALENDLY_BASE}/webhook_subscriptions?organization=${encodeURIComponent(orgUri)}&scope=organization`,
    { headers: await getHeaders() },
  );
  if (!resp.ok) return false;
  const data = (await resp.json()) as { collection: Array<{ callback_url: string; state: string }> };
  return data.collection.some((w) => w.callback_url === callbackUrl && w.state === "active");
}
