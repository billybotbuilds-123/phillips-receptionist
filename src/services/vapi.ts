import { settings } from "../lib/settings.js";
import { logger } from "../lib/logger.js";

const VAPI_BASE = "https://api.vapi.ai";

async function getHeaders() {
  const apiKey = await settings.get("vapi_api_key");
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

export async function listAssistants(): Promise<Array<{ id: string; name: string }>> {
  const resp = await fetch(`${VAPI_BASE}/assistant`, { headers: await getHeaders() });
  if (!resp.ok) throw new Error(`Vapi /assistant failed: ${resp.status}`);
  const data = (await resp.json()) as Array<{ id: string; name: string }>;
  return data;
}

export async function updateAssistantSystemPrompt(
  assistantId: string,
  systemPrompt: string,
): Promise<void> {
  const resp = await fetch(`${VAPI_BASE}/assistant/${assistantId}`, {
    method: "PATCH",
    headers: await getHeaders(),
    body: JSON.stringify({
      model: {
        messages: [{ role: "system", content: systemPrompt }],
      },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Vapi update assistant failed: ${resp.status} ${text}`);
  }
  logger.info({ assistantId }, "vapi assistant system prompt updated");
}

export async function createOutboundCall(toPhone: string, assistantId: string): Promise<string> {
  const fromPhone = await settings.get("twilio_phone_number");
  const resp = await fetch(`${VAPI_BASE}/call/phone`, {
    method: "POST",
    headers: await getHeaders(),
    body: JSON.stringify({
      phoneNumberId: fromPhone,
      assistantId,
      customer: { number: toPhone },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Vapi create call failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as { id: string };
  return data.id;
}

export async function testConnection(): Promise<{ ok: boolean; latencyMs: number; detail?: string; error?: string }> {
  const start = Date.now();
  try {
    const assistants = await listAssistants();
    return {
      ok: true,
      latencyMs: Date.now() - start,
      detail: `${assistants.length} assistant(s) found`,
    };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: String(err) };
  }
}
