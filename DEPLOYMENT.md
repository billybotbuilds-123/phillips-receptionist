# Deployment Guide — Phillips Receptionist

## Initial Railway Setup

### 1. Create the Railway project

1. Go to https://railway.app → New Project → Deploy from GitHub repo
2. Select the `phillips-receptionist` repo
3. Railway will detect Node.js and create a service

### 2. Create two services from the same repo

Railway runs the web server and cron worker as separate services sharing one repo.

**Web service** (already created from GitHub):
- Settings → Build Command: `npm run build`
- Settings → Start Command: `node dist/index.js` (or `npm run start`)
- Settings → Watch Paths: leave default

**Worker service** (add manually):
- New Service → Empty Service → name it `worker`
- Source → Same repo
- Settings → Start Command: `node dist/worker.js`
- Settings → Root Directory: (same as web)

### 3. Add PostgreSQL

- New → Database → PostgreSQL
- Railway auto-sets `DATABASE_URL` — it will be shared with both services automatically

### 4. Set environment variables

On **both** services, add these variables:

```
SETTINGS_MASTER_KEY=<from npm run bootstrap>
SESSION_SECRET=<from npm run bootstrap>
ADMIN_USERNAME=<from npm run bootstrap>
ADMIN_PASSWORD_HASH=<from npm run bootstrap>
NODE_ENV=production
PUBLIC_URL=https://office.educationalsuccessexpert.com
PORT=3000
SENTRY_DSN=<your Sentry DSN>
```

`DATABASE_URL` is auto-set by Railway's Postgres plugin.

### 5. Bootstrap the database

After first deploy, run migrations via Railway's terminal:

```bash
# In Railway → web service → Shell
npx prisma migrate deploy
```

Or run bootstrap locally pointed at the production DATABASE_URL:

```bash
DATABASE_URL=<railway postgres url> npm run bootstrap
```

### 6. Configure custom domain

1. Railway → web service → Settings → Networking → Custom Domain
2. Add `office.educationalsuccessexpert.com`
3. Railway gives you a CNAME target (e.g. `xyz.railway.app`)
4. At your DNS registrar: add CNAME `office` → `xyz.railway.app`, TTL 300
5. Wait 5–60 min for DNS propagation + TLS provisioning
6. Verify: `curl -I https://office.educationalsuccessexpert.com/health`

---

## Redeploying

```bash
# Automatic: push to main branch triggers Railway CI/CD
git push origin main

# Manual: Railway dashboard → web service → Deploy → Redeploy
```

Railway zero-downtime deploys: new container starts, passes health check, then old container stops.

---

## Rollback

### Via Railway dashboard
1. Railway → web service → Deployments tab
2. Find the last known-good deployment
3. Click → Rollback

### Via git
```bash
git revert HEAD
git push origin main
# Or pin to specific commit:
git push origin <good-commit-sha>:main --force
```

---

## Health Check

Railway uses `/health` as the health probe. It checks:
- Postgres connectivity
- Settings master key availability
- Gmail token validity (warns if expiring soon)
- Twilio API reachability

If health check fails, Railway won't route traffic to the new deploy.

---

## Key Rotation

### Rotating an API key (Vapi, Anthropic, Twilio, etc.)

1. Generate new key at the provider
2. Log into `/admin/settings`
3. Update the field → Save
4. Click "Test connection" → verify ✓
5. Revoke old key at the provider

No redeploy needed — settings are read from DB on each request.

### Rotating SESSION_SECRET

This invalidates all active sessions (Shane will be logged out):

1. Generate new secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Railway → web service → Variables → update `SESSION_SECRET`
3. Railway auto-redeploys

### Rotating SETTINGS_MASTER_KEY (rare — nuclear option)

This requires re-encrypting all settings values. Do this only if the key is compromised.

```bash
# 1. Generate new key
NEW_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "New key: $NEW_KEY"

# 2. Run migration script (re-encrypts all Setting rows)
OLD_SETTINGS_MASTER_KEY=<current key> NEW_SETTINGS_MASTER_KEY=$NEW_KEY npx tsx scripts/rotate-master-key.ts

# 3. Update Railway env var: SETTINGS_MASTER_KEY=$NEW_KEY
# 4. Redeploy
```

> **Note:** `scripts/rotate-master-key.ts` needs to be written if this ever becomes necessary. The logic: read all Setting rows with old key, re-encrypt with new key, write back in a transaction.

---

## Database Migrations

```bash
# Apply pending migrations (run after every deploy that includes schema changes)
npx prisma migrate deploy

# Create a new migration (development only)
npx prisma migrate dev --name describe_the_change

# Reset database (DANGER — destroys all data)
npx prisma migrate reset
```

---

## Monitoring

- **Sentry** — errors route to Shane's notification email as daily digest
- **Railway metrics** — memory/CPU visible in Railway dashboard
- **Admin dashboard** — `/admin` shows system health badges for all integrations
- **Logs** — Railway → service → Logs tab (pino JSON logs)

---

## Monthly Maintenance Checklist

- [ ] Check Sentry for recurring errors
- [ ] Verify Gmail OAuth token hasn't expired (`/health` will warn)
- [ ] Review Railway usage vs. plan limits
- [ ] Check Twilio A2P 10DLC registration is still active
- [ ] Review any flagged calls in `/admin`
- [ ] Check for npm security advisories: `npm audit`
- [ ] Update dependencies if any critical security patches: `npm update`

---

## Emergency Contacts

| Issue | Action |
|-------|--------|
| Riley not answering calls | Check Vapi dashboard → is assistant active? Check Twilio → is number configured? Check Railway → is web service running? |
| Emails not sending | `/admin/settings` → Google tab → Test connection. If expired: Re-authorize Google. |
| SMS not sending | `/admin/settings` → Phone tab → Test connection. Check Twilio console for errors. |
| Database down | Railway → PostgreSQL → check status. Contact Railway support. |
| Railway outage | Twilio fallback TwiML forwards to Shane's cell. |

---

## Offboarding (handing repo to a new developer)

1. New developer creates their own GitHub account
2. Transfer repo: GitHub → Settings → Transfer ownership
3. New developer sets up Railway with their account
4. Remove old collaborators from GitHub repo
5. Rotate ALL API keys (go through all 10 settings tabs)
6. Rotate `SETTINGS_MASTER_KEY` and `SESSION_SECRET` in Railway
7. Verify `/health` returns 200
8. Verify a test call works end-to-end
