import { settings } from "../lib/settings.js";

const ELEVENLABS_BASE = "https://api.elevenlabs.io";

async function getHeaders() {
  const apiKey = await settings.get("elevenlabs_api_key");
  return {
    "xi-api-key": apiKey,
    "Content-Type": "application/json",
  };
}

export interface ElevenLabsUser {
  subscription: { tier: string; character_count: number; character_limit: number };
}

export async function getUser(): Promise<ElevenLabsUser> {
  const resp = await fetch(`${ELEVENLABS_BASE}/v1/user`, { headers: await getHeaders() });
  if (!resp.ok) throw new Error(`ElevenLabs /v1/user failed: ${resp.status}`);
  return (await resp.json()) as ElevenLabsUser;
}

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  preview_url: string;
}

export async function listVoices(): Promise<ElevenLabsVoice[]> {
  const resp = await fetch(`${ELEVENLABS_BASE}/v1/voices`, { headers: await getHeaders() });
  if (!resp.ok) throw new Error(`ElevenLabs /v1/voices failed: ${resp.status}`);
  const data = (await resp.json()) as { voices: ElevenLabsVoice[] };
  return data.voices;
}

export async function generatePreview(voiceId: string): Promise<Buffer> {
  const apiKey = await settings.get("elevenlabs_api_key");
  const PREVIEW_TEXT =
    "Hi, you've reached Mr. Phillips's office. This is Riley — how can I help you today?";

  const resp = await fetch(`${ELEVENLABS_BASE}/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: PREVIEW_TEXT,
      model_id: "eleven_monolingual_v1",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!resp.ok) throw new Error(`ElevenLabs TTS failed: ${resp.status}`);
  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function testConnection(): Promise<{ ok: boolean; latencyMs: number; detail?: string; error?: string }> {
  const start = Date.now();
  try {
    const user = await getUser();
    const remaining = user.subscription.character_limit - user.subscription.character_count;
    return {
      ok: true,
      latencyMs: Date.now() - start,
      detail: `Tier: ${user.subscription.tier} · ${remaining.toLocaleString()} chars remaining`,
    };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: String(err) };
  }
}
