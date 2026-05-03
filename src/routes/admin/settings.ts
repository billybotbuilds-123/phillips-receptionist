import type { FastifyInstance } from "fastify";
import { settings, SETTING_KEYS, type SettingKey } from "../../lib/settings.js";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { generateHexKey } from "../../lib/crypto.js";
import * as anthropicService from "../../services/anthropic.js";
import * as vapiService from "../../services/vapi.js";
import * as twilioService from "../../services/twilio.js";
import * as elevenlabsService from "../../services/elevenlabs.js";
import * as calendlyService from "../../services/calendly.js";
import * as googleDocsService from "../../services/googleDocs.js";

const SERVICES = ["anthropic", "vapi", "twilio", "elevenlabs", "calendly", "google", "stripe"] as const;
type Service = (typeof SERVICES)[number];

const TAB_SETTINGS: Record<string, SettingKey[]> = {
  "core-ai": ["anthropic_api_key", "vapi_api_key", "vapi_webhook_secret"],
  phone: ["twilio_account_sid", "twilio_auth_token", "twilio_phone_number"],
  voice: ["elevenlabs_api_key", "elevenlabs_voice_id"],
  google: [
    "google_oauth_client_id",
    "google_oauth_client_secret",
    "google_oauth_refresh_token",
    "google_sender_email",
    "google_drive_notes_folder_id",
  ],
  scheduling: ["calendly_api_token", "calendly_webhook_signing_key", "calendly_event_type_uri"],
  payments: ["stripe_secret_key"],
  "business-info": [
    "consultation_fee_cents",
    "consultation_duration_minutes",
    "mr_phillips_bio",
    "timezone",
  ],
  notifications: [
    "shane_notification_email",
    "shane_notification_phone",
    "quiet_hours_start",
    "quiet_hours_end",
  ],
  persona: ["riley_system_prompt_override"],
  account: [],
};

async function getTabData(tab: string): Promise<Record<string, string>> {
  const keys = TAB_SETTINGS[tab] ?? [];
  const data: Record<string, string> = {};
  for (const key of keys) {
    data[key] = await settings.getMasked(key);
  }
  return data;
}

export async function adminSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/settings", async (_req, reply) => {
    return reply.redirect(302, "/admin/settings/core-ai");
  });

  app.get("/admin/settings/:tab", async (request, reply) => {
    const { tab } = request.params as { tab: string };
    if (!TAB_SETTINGS[tab]) {
      return reply.redirect(302, "/admin/settings/core-ai");
    }

    const tabData = await getTabData(tab);
    const missingSettings = await settings.getMissingRequired();
    const csrfToken = await reply.generateCsrf();

    const extraData: Record<string, unknown> = {};

    if (tab === "persona") {
      const override = await settings.get("riley_system_prompt_override").catch(() => "");
      extraData["currentOverride"] = override;
      const versions = await db.personaVersion.findMany({
        orderBy: { created_at: "desc" },
        take: 10,
      });
      extraData["versions"] = versions;
    }

    if (tab === "account") {
      const userId = request.user!.id;
      const sessions = await db.session.findMany({
        where: { user_id: userId, expires_at: { gt: new Date() } },
        orderBy: { expires_at: "desc" },
      });
      const loginActivity = await db.loginAttempt.findMany({
        where: { user_id: userId },
        orderBy: { created_at: "desc" },
        take: 20,
      });
      extraData["sessions"] = sessions;
      extraData["loginActivity"] = loginActivity;
    }

    return reply.view(`settings/${tab}.ejs`, {
      user: request.user,
      tab,
      tabData,
      missingSettings,
      missingCount: missingSettings.length,
      csrfToken,
      ...extraData,
    });
  });

  // POST /admin/settings/:key — save a setting
  app.post("/admin/settings/:key", async (request, reply) => {
    const { key } = request.params as { key: string };
    if (!(SETTING_KEYS as readonly string[]).includes(key)) {
      return reply.status(400).send({ error: "unknown_key" });
    }

    const body = request.body as Record<string, string>;
    const value = body["value"] ?? "";

    const validationError = validateSettingValue(key as SettingKey, value);
    if (validationError) {
      return reply.status(400).send({ error: "validation_error", message: validationError });
    }

    await settings.set(key as SettingKey, value, request.user!.username, request.ip);

    if (key === "riley_system_prompt_override" && value) {
      await db.personaVersion.create({
        data: { content: value, changed_by: request.user!.username },
      });
      const allVersions = await db.personaVersion.findMany({
        orderBy: { created_at: "desc" },
      });
      if (allVersions.length > 10) {
        const toDelete = allVersions.slice(10).map((v) => v.id);
        await db.personaVersion.deleteMany({ where: { id: { in: toDelete } } });
      }
    }

    return reply.send({ ok: true });
  });

  // POST /admin/test-connection/:service — rate-limited
  app.post(
    "/admin/test-connection/:service",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const { service } = request.params as { service: string };
      if (!(SERVICES as readonly string[]).includes(service)) {
        return reply.status(400).send({ error: "unknown_service" });
      }

      const start = Date.now();
      let result: { ok: boolean; latency_ms?: number; detail?: string; error?: string };

      try {
        switch (service as Service) {
          case "anthropic":
            result = await anthropicService.testConnection();
            break;
          case "vapi":
            result = await vapiService.testConnection();
            break;
          case "twilio": {
            const info = await twilioService.getAccountInfo();
            result = {
              ok: true,
              latency_ms: Date.now() - start,
              detail: `Status: ${info.status} · Balance: $${info.balance}`,
            };
            break;
          }
          case "elevenlabs":
            result = await elevenlabsService.testConnection();
            break;
          case "calendly": {
            const user = await calendlyService.getCurrentUser();
            result = { ok: true, latency_ms: Date.now() - start, detail: user.name };
            break;
          }
          case "google": {
            const { expiresInSeconds, scopes } = await googleDocsService.refreshAccessToken();
            result = {
              ok: true,
              latency_ms: Date.now() - start,
              detail: `Token valid, expires in ${expiresInSeconds}s · Scopes: ${scopes.split(" ").length}`,
            };
            break;
          }
          case "stripe": {
            const stripeKey = await settings.get("stripe_secret_key");
            const resp = await fetch("https://api.stripe.com/v1/balance", {
              headers: { Authorization: `Bearer ${stripeKey}` },
            });
            if (!resp.ok) throw new Error(`Stripe returned ${resp.status}`);
            result = { ok: true, latency_ms: Date.now() - start };
            break;
          }
          default:
            return reply.status(400).send({ error: "unknown_service" });
        }
      } catch (err) {
        result = { ok: false, latency_ms: Date.now() - start, error: String(err).slice(0, 200) };
      }

      await db.connectionTest.create({
        data: {
          service,
          ok: result.ok,
          latency_ms: result.latency_ms ?? null,
          error: result.error ?? null,
          tested_by: request.user!.username,
        },
      });

      return reply.send(result);
    },
  );

  app.post("/admin/settings/vapi/rotate-secret", async (request, reply) => {
    const newSecret = generateHexKey(32);
    await settings.set("vapi_webhook_secret", newSecret, request.user!.username, request.ip);
    return reply.send({ ok: true, new_secret: newSecret });
  });

  // GET /admin/settings/reveal/:key — HEAVILY rate-limited.
  // Returns raw secret values; an XSS foothold plus an un-rate-limited reveal
  // endpoint would enumerate every secret in a loop. Cap at 20/minute.
  app.get(
    "/admin/settings/reveal/:key",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const { key } = request.params as { key: string };
      if (!(SETTING_KEYS as readonly string[]).includes(key)) {
        return reply.status(400).send({ error: "unknown_key" });
      }
      try {
        const value = await settings.get(key as SettingKey);
        // Audit log every reveal so Shane can see if something automated is
        // iterating through secret keys.
        logger.info(
          { user: request.user?.username, key, ip: request.ip },
          "settings reveal",
        );
        return reply.send({ value });
      } catch {
        return reply.send({ value: "" });
      }
    },
  );

  app.get("/admin/settings/audit", async (request, reply) => {
    const page = parseInt((request.query as Record<string, string>)["page"] ?? "1");
    const pageSize = 50;
    const [rows, total] = await Promise.all([
      db.settingsAuditLog.findMany({
        orderBy: { created_at: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.settingsAuditLog.count(),
    ]);
    return reply.view("settings/audit.ejs", {
      user: request.user,
      rows,
      page,
      totalPages: Math.ceil(total / pageSize),
    });
  });

  app.post("/admin/settings/persona/apply-to-vapi", async (request, reply) => {
    try {
      const override = await settings.get("riley_system_prompt_override").catch(() => "");
      const assistants = await vapiService.listAssistants();
      if (assistants.length === 0) {
        return reply.status(400).send({ error: "no_assistants", message: "No Vapi assistants found" });
      }
      const firstAssistant = assistants[0];
      if (!firstAssistant) {
        return reply.status(400).send({ error: "no_assistants" });
      }
      await vapiService.updateAssistantSystemPrompt(firstAssistant.id, override);
      return reply.send({ ok: true });
    } catch (err) {
      logger.error({ err: String(err) }, "failed to apply persona to vapi");
      return reply.status(500).send({ error: "vapi_update_failed", message: String(err) });
    }
  });

  app.post("/admin/settings/persona/revert", async (request, reply) => {
    await settings.set("riley_system_prompt_override", "", request.user!.username, request.ip);
    return reply.send({ ok: true });
  });

  app.post("/admin/settings/persona/restore/:versionId", async (request, reply) => {
    const { versionId } = request.params as { versionId: string };
    const version = await db.personaVersion.findUnique({ where: { id: versionId } });
    if (!version) return reply.status(404).send({ error: "not_found" });

    await settings.set(
      "riley_system_prompt_override",
      version.content,
      request.user!.username,
      request.ip,
    );
    await db.personaVersion.create({
      data: { content: version.content, changed_by: `${request.user!.username} (restore)` },
    });
    return reply.send({ ok: true });
  });

  // POST /admin/test-notification — RATE LIMITED.
  // Each call sends a real SMS (costs money) and real email. A buggy frontend
  // in a loop would burn through Twilio balance fast. Cap at 5/minute.
  app.post(
    "/admin/test-notification",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
    },
    async (_request, reply) => {
      const notifEmail = await settings.get("shane_notification_email");
      const notifPhone = await settings.get("shane_notification_phone");

      const { sendEmail: gmailSend } = await import("../../services/gmail.js");
      const { sendSms: twilioSend } = await import("../../services/twilio.js");

      await Promise.allSettled([
        gmailSend({
          to: notifEmail,
          subject: "Test from Phillips Receptionist",
          templateName: "test-email",
          vars: { message: "Test from Phillips Receptionist — all systems working." },
        }),
        twilioSend({
          to: notifPhone,
          templateName: "urgent-to-shane",
          vars: {
            reason: "test",
            parent_name: "Test",
            parent_phone: "n/a",
            summary_first_120_chars: "Test from Phillips Receptionist — all systems working.",
            short_dashboard_url: "",
          },
        }),
      ]);

      return reply.send({ ok: true });
    },
  );

  // POST /admin/settings/persona/affirmation-preview — rate-limited.
  // Spends Anthropic tokens per call.
  app.post(
    "/admin/settings/persona/affirmation-preview",
    {
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (_request, reply) => {
      const bio = await settings.get("mr_phillips_bio").catch(() => "");
      const lines = await anthropicService.generateAffirmationPreview(bio);
      return reply.send({ lines });
    },
  );
}

function validateSettingValue(key: SettingKey, value: string): string | null {
  if (!value) return null;

  switch (key) {
    case "anthropic_api_key":
      if (!value.startsWith("sk-ant-")) return "Must start with sk-ant-";
      break;
    case "twilio_account_sid":
      if (!value.startsWith("AC")) return "Must start with AC";
      break;
    case "twilio_auth_token":
      if (!/^[0-9a-f]{32}$/.test(value)) return "Must be 32 hex characters";
      break;
    case "twilio_phone_number":
      if (!/^\+1\d{10}$/.test(value)) return "Must be E.164 format (+1XXXXXXXXXX)";
      break;
    case "vapi_webhook_secret":
      if (value.length < 32) return "Must be at least 32 characters";
      break;
    case "elevenlabs_voice_id":
      if (!/^[a-zA-Z0-9]{20}$/.test(value)) return "Must be 20 alphanumeric characters";
      break;
    case "stripe_secret_key":
      if (!value.startsWith("sk_")) return "Must start with sk_";
      break;
    case "shane_notification_email":
    case "google_sender_email": {
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRe.test(value)) return "Must be a valid email address";
      break;
    }
    case "shane_notification_phone":
      if (!/^\+1\d{10}$/.test(value)) return "Must be E.164 format (+1XXXXXXXXXX)";
      break;
    case "consultation_fee_cents":
      if (isNaN(parseInt(value)) || parseInt(value) < 0) return "Must be a non-negative integer";
      break;
    case "consultation_duration_minutes":
      if (isNaN(parseInt(value)) || parseInt(value) < 1 || parseInt(value) > 180)
        return "Must be 1–180";
      break;
    case "quiet_hours_start":
    case "quiet_hours_end":
      if (value && !/^\d{2}:\d{2}$/.test(value)) return "Must be HH:MM format";
      break;
  }

  return null;
}
