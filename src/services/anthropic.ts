import Anthropic from "@anthropic-ai/sdk";
import { settings } from "../lib/settings.js";
import { logger } from "../lib/logger.js";

async function getClient() {
  const apiKey = await settings.get("anthropic_api_key");
  return new Anthropic({ apiKey });
}

export async function testConnection(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const client = await getClient();
    await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    logger.warn({ err }, "anthropic connection test failed");
    return { ok: false, latencyMs: Date.now() - start, error: String(err) };
  }
}

export async function generateAffirmationPreview(bio: string): Promise<string[]> {
  const client = await getClient();
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: `You are Riley, an AI receptionist for Mr. Phillips, a special education parent advocate. Based on the following bio, generate 3 short sentences (1-2 sentences each) that Riley might say to reassure a parent about Mr. Phillips's qualifications. Keep them warm, confident, and specific to the bio details. Bio: ${bio}`,
      },
    ],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(0, 3);
}
