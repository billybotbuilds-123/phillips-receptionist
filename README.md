# Phillips Receptionist — Phase 2 Fixes

This archive contains corrections for all P0 and P1 issues identified in the
Phase 2 code review. It is a **drop-in patch** — extract it over the existing
`phillips-receptionist` working copy and the paths will overwrite the files
that need to change.

---

## How to apply

```bash
# From the repo root
tar -xzf phillips-receptionist-fixes.tar.gz --strip-components=1

# Install the new dependency
npm install

# Apply the new database migration (adds EscalationDedup table)
npx prisma migrate dev --name add_escalation_dedup

# Run tests
npm test

# Typecheck
npm run typecheck
```

Billy should then:

1. Delete `tests/integration/vapi-tools.test.ts` (the old Vapi webhook tests
   are superseded by `tests/unit/mcp-tools.test.ts` + manual MCP Inspector).
2. Run `npm run typecheck` and fix any remaining type issues. A small number
   of typing adjustments may be needed where Billy's code and the new code
   disagree.
3. Restart the dev server; hit `POST /webhooks/twilio/sms-inbound` with a
   signed payload to confirm inbound SMS works.

---

## What changed

### 🔴 P0 fixes (deploy blockers)

| # | Issue | Fix | Files |
|---|---|---|---|
| P0.1 | Calendly webhook schema wrong — every real booking silently failed | Defensive schema accepting `scheduled_event` / `calendar_event` / `event` nesting; loud error on parse failure; real fixture in tests/ | `src/routes/calendly.ts`, `tests/fixtures/calendly-invitee-created.json`, `tests/integration/calendly-schema.test.ts` |
| P0.2 | No inbound SMS webhook — TCPA violation, every STOP ignored | New `POST /webhooks/twilio/sms-inbound` with signature verification, `OPT_OUT_PATTERNS` detection, TwiML confirmation reply | `src/routes/twilio-inbound.ts`, `src/services/twilio.ts`, `src/lib/hmac.ts`, `tests/unit/opt-out.test.ts` |
| P0.3 | Google Doc template — `{{parent_name}}` leaked into body (one-shot replace) | New shared `renderTemplate` using global regex; googleDocs.ts now uses it | `src/lib/templates.ts`, `src/services/googleDocs.ts`, `tests/unit/templates.test.ts` |
| P0.4 | Email `multipart/alternative` with only HTML part — MIME violation | Now emits proper text/plain + text/html parts; `htmlToPlainText` helper for fallback | `src/services/gmail.ts`, `src/lib/templates.ts` |
| P0.5 | MCP spec said "adopt" but code was bespoke Vapi webhooks | **MCP server built for real**: `src/mcp/server.ts` exposes `send_booking_link` + `urgent_escalation` via Streamable HTTP. Auth via Bearer token (`vapi_mcp_secret` setting). Old `/vapi/tools/*` routes removed. | `src/mcp/server.ts`, `src/routes/mcp.ts`, `src/routes/vapi.ts` (reduced to just `/vapi/call-ended`), `src/lib/settings.ts` (new key), `package.json` (new dep) |

### 🟠 P1 fixes

| # | Issue | Fix | Files |
|---|---|---|---|
| P1.1 | Escalation idempotency in-memory `Set` — lost on Railway restart | Postgres-backed `EscalationDedup` table + `tryClaimEscalation()` | `prisma/schema.prisma`, `src/services/notifications.ts` |
| P1.2 | Sequential DB writes after parallel work blew the 5s Vapi budget | All post-send bookkeeping runs in `setImmediate` so the HTTP response flushes first | `src/routes/vapi.ts`, `src/mcp/server.ts` |
| P1.3 | Calendly HMAC had no timestamp freshness check — replayable | Rejects signatures older than 5 minutes (or >5 min in the future) | `src/lib/hmac.ts` |
| P1.4 | Gmail OAuth client re-created per send → token refresh on every email | Singleton cached in module scope, keyed on clientId + refresh token | `src/services/gmail.ts`, `src/services/googleDocs.ts`, `src/services/twilio.ts` |
| P1.5 | Tool validation errors returned HTTP 400, Vapi doesn't surface cleanly | MCP tools use standard error content; validation enforced at Zod schema registration | `src/mcp/server.ts` |
| P1.6 | CSRF plugin registered but never enforced | `preHandler` hook calls `app.csrfProtection` on every state-changing admin request | `src/index.ts` |
| P1.7 | Reveal + test-notification + test-connection endpoints unrate-limited | `@fastify/rate-limit` registered; per-route limits on sensitive endpoints | `src/index.ts`, `src/routes/admin/settings.ts` |

---

## New environment / settings

**New required setting:** `vapi_mcp_secret` — the Bearer token Shane will
configure in Vapi's MCP tool "Authorization" header. Generate a 64-char hex
string in the admin settings dashboard (there's a Core AI tab rotate button
pattern Billy can reuse) or at the shell with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then paste it both:
- into the admin settings dashboard under Core AI → "Vapi MCP Secret"
- into Vapi's assistant config for the MCP tool's Authorization header, as
  `Bearer <the-hex-string>`

`vapi_webhook_secret` is still required (it signs the `/vapi/call-ended`
notification webhook, which is NOT a tool call and still uses HMAC).

---

## Vapi assistant config changes (Phase 3)

When Shane configures the Riley assistant in Vapi, the tools section becomes:

```json
{
  "tools": [
    {
      "type": "mcp",
      "function": { "name": "rileyTools" },
      "server": {
        "url": "https://office.educationalsuccessexpert.com/mcp",
        "headers": {
          "Authorization": "Bearer <vapi_mcp_secret>"
        }
      }
    }
  ]
}
```

Remove the individual `send_booking_link` and `urgent_escalation` function
tool definitions — Vapi will discover them dynamically from the MCP server
at call start.

The `/vapi/call-ended` webhook URL configured separately in the Vapi
assistant stays the same.

---

## Testing checklist

Before deploying to production, run:

```bash
npm run typecheck        # must pass
npm test                 # all unit tests green
npm run build            # mjml compilation + tsc
```

Then spin up locally and run these manual checks:

1. **MCP Inspector smoke test**
   ```bash
   npm run dev
   # in another terminal:
   npm run mcp:inspector
   ```
   Set Authorization header to `Bearer <your vapi_mcp_secret>`. You should
   see `send_booking_link` and `urgent_escalation` in the tool list. Invoke
   `send_booking_link` with test data and confirm the Call row appears in
   the database and a Google Doc is created.

2. **Claude Desktop end-to-end** (the best part of MCP)
   Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
   ```json
   {
     "mcpServers": {
       "phillips-receptionist": {
         "command": "npx",
         "args": [
           "mcp-remote",
           "http://localhost:3000/mcp",
           "--header",
           "Authorization: Bearer <vapi_mcp_secret>"
         ]
       }
     }
   }
   ```
   Restart Claude Desktop. In a new conversation say: *"Send a booking link
   to test@example.com for Emma, 4th grade — mom's name is Maria Garcia at
   +15621234567, summary: Emma has been struggling with reading since K."*
   Confirm the tools run.

3. **Capture a real Calendly payload** — configure Calendly to point at
   `https://<your-railway-url>/webhooks/calendly`, make a test booking, and
   inspect the logs. If the captured shape differs from
   `tests/fixtures/calendly-invitee-created.json`, update the fixture and
   consider tightening the schema's `.passthrough()` to be stricter.

4. **TCPA opt-out test** — text "STOP" to the Twilio number. Confirm:
   - `/webhooks/twilio/sms-inbound` logs the opt-out
   - A MessageLog row is written with `template: "stop"`, `direction: "inbound"`
   - A follow-up SMS to that number now gets `status: "blocked_opt_out"`
   - A TwiML confirmation reply is sent back

5. **Crisis flow test** — invoke `urgent_escalation` twice with the same
   `(call_id, reason)`. The second invocation should return immediately
   without firing a duplicate SMS to Shane. Confirm an `EscalationDedup`
   row exists.

---

## What I did NOT change

These were flagged in review but intentionally left alone:

- **Settings cache 60s TTL in-memory, no cross-process invalidation** —
  documented but not fixed. Acceptable for Shane's single-operator workflow.
  Note in ops docs.
- **Bootstrap race in `ensureBootstrapUser`** — still uses findCount +
  create. Low impact for a single-instance Railway deploy.
- **`getAll()` decrypts every secret on render** — unchanged. Acceptable
  for Shane's workflow.

---

## Known limitations of this patch

**I haven't run any of this code.** I wrote it carefully against Billy's
existing structure but:

- `npm install` may surface peer-dep issues with the new
  `@modelcontextprotocol/sdk` version. If so, pin to `1.29.0` exactly.
- `app.csrfProtection` in `src/index.ts` uses `@ts-expect-error` because
  the plugin's type surface is awkward. Billy may need to adjust based on
  the actual plugin version.
- `StreamableHTTPServerTransport` options may have shifted between SDK
  versions. If `enableJsonResponse` isn't recognized, check the SDK
  README for the current name.
- The Calendly schema uses `.passthrough()` defensively because I could
  not fetch the full Stoplight doc. Once Billy captures a real payload in
  production, he should tighten the schema to match exactly.
- Type checks should surface these quickly. Plan for ~30-60 min of Billy
  ironing out `tsc` complaints before the first green build.

**Before shipping to production**, Billy must:

1. Run `npm test` — tests must pass
2. Run `npm run typecheck` — no type errors
3. Perform all five manual checks above
4. Capture a real Calendly webhook payload and update the fixture
